import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { AdminTokenAuthenticator } from "../access/admin-token-authenticator";
import { PrismaService } from "../database/prisma.service";
import type { UpdateAdminAccountDto } from "./admin-account.dto";
import { resetChangedAdminEmail } from "./admin-email-policy";
import { activeAdminRoleBindingWhere } from "./admin-scope-policy";

@Injectable()
export class AdminAccountService {
  constructor(
    @Inject(AdminTokenAuthenticator)
    private readonly authenticator: AdminTokenAuthenticator,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async getAccount(authorization: string | undefined) {
    const { userId } = await this.authenticator.authenticate(authorization);
    const user = await this.prisma.adminUser.findUnique({
      include: {
        adminSessions: {
          select: { id: true },
          where: { expiresAt: { gt: new Date() }, revokedAt: null },
        },
        organizationProfiles: true,
        roleBindings: {
          include: {
            enterprise: { select: { id: true, name: true } },
            role: { select: { code: true, name: true } },
            tenant: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "asc" },
          where: activeAdminRoleBindingWhere,
        },
      },
      where: { id: userId },
    });
    if (!user) throw new NotFoundException("Administrator account was not found");

    const scopes = new Map<
      string,
      {
        department: string | null;
        enterprise: { id: string; name: string } | null;
        jobTitle: string | null;
        roles: { code: string; name: string }[];
        scopeId: string;
        scopeType: "ENTERPRISE" | "PLATFORM" | "TENANT";
        tenant: { id: string; name: string } | null;
      }
    >();
    for (const binding of user.roleBindings) {
      const key = `${binding.scopeType}:${binding.scopeId}`;
      const existing = scopes.get(key);
      if (existing) {
        existing.roles.push({ code: binding.role.code, name: binding.role.name });
        continue;
      }
      const profile = user.organizationProfiles.find(
        (candidate) =>
          candidate.scopeType === binding.scopeType && candidate.scopeId === binding.scopeId,
      );
      scopes.set(key, {
        department: profile?.department ?? null,
        enterprise: binding.enterprise,
        jobTitle: profile?.jobTitle ?? null,
        roles: [{ code: binding.role.code, name: binding.role.name }],
        scopeId: binding.scopeId,
        scopeType: binding.scopeType,
        tenant: binding.tenant,
      });
    }

    return {
      activeSessionCount: user.adminSessions.length,
      createdAt: user.createdAt,
      email: user.email,
      emailVerifiedAt: user.emailVerifiedAt,
      id: user.id,
      lastLoginAt: user.lastLoginAt,
      loginMethod: user.passwordHash ? "PASSWORD" : "SMS_CODE",
      name: user.name,
      phone: user.phone,
      username: user.username,
      scopes: [...scopes.values()],
      status: user.status,
      updatedAt: user.updatedAt,
    };
  }

  async updateAccount(authorization: string | undefined, input: UpdateAdminAccountDto) {
    const { userId } = await this.authenticator.authenticate(authorization);
    try {
      await this.prisma.$transaction(async (transaction) => {
        if (input.email) {
          const duplicate = await transaction.adminUser.findFirst({
            select: { id: true },
            where: { email: { equals: input.email, mode: "insensitive" }, id: { not: userId } },
          });
          if (duplicate) throw emailConflict();
        }
        const current = await transaction.adminUser.findUnique({ where: { id: userId } });
        if (!current) throw new NotFoundException("Administrator account was not found");
        await transaction.adminUser.update({
          data: {
            email: input.email,
            name: input.name,
            ...resetChangedAdminEmail(current.email, input.email),
          },
          where: { id: userId, AND: { email: current.email } },
        });
        await transaction.auditLog.create({
          data: {
            action: "admin-account.profile.update",
            actorType: "USER",
            actorUserId: userId,
            resourceId: userId,
            resourceType: "AdminUser",
            stateAfter: { email: input.email ?? current.email, name: input.name },
            stateBefore: { email: current.email, name: current.name },
          },
        });
      });
    } catch (error) {
      if (isEmailUniqueConflict(error)) throw emailConflict();
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw new ConflictException("个人资料已发生变化，请刷新后重新保存");
      }
      throw error;
    }
    return this.getAccount(authorization);
  }
}

function isEmailUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  return Array.isArray(target)
    ? target.some((field) => field === "email")
    : typeof target === "string" && target.includes("email");
}

function emailConflict(): ConflictException {
  return new ConflictException({
    code: "ADMIN_EMAIL_ALREADY_EXISTS",
    message: "该邮箱已被其他后台用户使用",
  });
}
