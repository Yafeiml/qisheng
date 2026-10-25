import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AuthTokenService } from "../access/auth-token.service";
import { PrismaService } from "../database/prisma.service";
import { normalizeChineseMobilePhone } from "../employee/phone";

export type EmployeeBindInput = Readonly<{ phone: string; enterpriseIds?: string[] }>;

const NO_BINDABLE_MEMBERSHIP_MESSAGE =
  "未找到可绑定的企业，请联系企业管理员确认此手机号已录入员工名单，且员工状态正常、任务资格已启用。";

@Injectable()
export class EmployeeBindingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthTokenService) private readonly tokens: AuthTokenService,
  ) {}

  async listBindableMemberships(rawPhone: string) {
    const phone = normalizePhone(rawPhone);
    const memberships = await this.prisma.enterpriseMembership.findMany({
      include: {
        department: { select: { name: true } },
        enterprise: {
          select: {
            name: true,
            tenant: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ tenantId: "asc" }, { enterpriseId: "asc" }],
      where: {
        phone,
        seatStatus: "ENABLED",
        status: { in: ["PENDING_BIND", "ACTIVE"] },
      },
    });
    if (memberships.length === 0) {
      throw new NotFoundException(NO_BINDABLE_MEMBERSHIP_MESSAGE);
    }
    return memberships.map((membership) => ({
      alreadyBound: membership.status === "ACTIVE" && Boolean(membership.globalUserId),
      departmentName: membership.department?.name ?? null,
      employeeName: membership.name,
      enterpriseId: membership.enterpriseId,
      enterpriseName: membership.enterprise.name,
      membershipId: membership.id,
      tenantId: membership.enterprise.tenant.id,
      tenantName: membership.enterprise.tenant.name,
    }));
  }

  async bindVerifiedPhone(input: EmployeeBindInput) {
    const phone = normalizePhone(input.phone);
    const selected = input.enterpriseIds ? new Set(input.enterpriseIds) : null;
    const result = await this.prisma.$transaction(async (transaction) => {
      const verifiedAt = new Date();
      const candidates = await transaction.enterpriseMembership.findMany({
        include: { enterprise: { select: { name: true } } },
        where: {
          enterpriseId: selected ? { in: [...selected] } : undefined,
          phone,
          seatStatus: "ENABLED",
          status: { in: ["PENDING_BIND", "ACTIVE"] },
        },
      });
      if (candidates.length === 0) {
        throw new NotFoundException(NO_BINDABLE_MEMBERSHIP_MESSAGE);
      }
      if (selected && candidates.length !== selected.size) {
        throw new NotFoundException("所选企业的员工状态或任务资格已变更，请重新验证并选择企业。");
      }

      // Upsert locks the current identity before deciding whether verification needs renewal.
      let user = await transaction.globalUser.upsert({
        create: { lastLoginAt: verifiedAt, phone, phoneVerifiedAt: verifiedAt },
        update: { lastLoginAt: verifiedAt },
        where: { phone },
      });
      if (user.status !== "ACTIVE" || !user.phoneVerifiedAt) {
        user = await transaction.globalUser.update({
          data: { phoneVerifiedAt: verifiedAt, status: "ACTIVE" },
          where: { id: user.id },
        });
      }
      for (const membership of candidates) {
        if (membership.globalUserId && membership.globalUserId !== user.id) {
          throw new ConflictException("该员工身份已绑定其他账号，请联系企业管理员核实。");
        }
        const newlyBound =
          membership.globalUserId !== user.id ||
          membership.status !== "ACTIVE" ||
          !membership.boundAt;
        const bound = await transaction.enterpriseMembership.updateMany({
          data: {
            boundAt: membership.boundAt ?? verifiedAt,
            globalUserId: user.id,
            status: "ACTIVE",
          },
          where: {
            globalUserId: membership.globalUserId,
            id: membership.id,
            phone,
            seatStatus: "ENABLED",
            smsNotificationPhoneVersion: membership.smsNotificationPhoneVersion,
            status: { in: ["PENDING_BIND", "ACTIVE"] },
          },
        });
        if (bound.count !== 1) {
          throw new ConflictException("员工手机号或绑定状态已变更，请重新验证并选择企业。");
        }
        if (newlyBound) {
          await transaction.auditLog.create({
            data: {
              action: "employee-membership.bind",
              actorType: "USER",
              actorUserId: user.id,
              enterpriseId: membership.enterpriseId,
              resourceId: membership.id,
              resourceType: "EnterpriseMembership",
              stateAfter: {
                boundAt: (membership.boundAt ?? verifiedAt).toISOString(),
                status: "ACTIVE",
              },
              tenantId: membership.tenantId,
            },
          });
        }
      }
      return {
        memberships: candidates.map((membership) => ({
          enterpriseId: membership.enterpriseId,
          enterpriseName: membership.enterprise.name,
          membershipId: membership.id,
          tenantId: membership.tenantId,
        })),
        userId: user.id,
      };
    });

    return {
      ...result,
      accessToken: this.tokens.issueEmployeeAccessToken(result.userId),
      audience: "xhs-employee-miniapp",
      tokenType: "Bearer",
    };
  }
}

function normalizePhone(phone: string): string {
  try {
    return normalizeChineseMobilePhone(phone);
  } catch (error) {
    throw new ConflictException(error instanceof Error ? error.message : "Phone is invalid");
  }
}
