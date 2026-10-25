import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { type MembershipParticipationStatus, Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import type {
  BulkUpdateMembershipParticipationDto,
  UpdateEnterprisePersonnelPolicyDto,
  UpdateMembershipParticipationDto,
} from "./personnel-governance.dto";

@Injectable()
export class PersonnelGovernanceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
  ) {}

  async listPolicies(tenantId: string) {
    this.requireTenantPolicyPermission();
    const enterprises = await this.prisma.enterprise.findMany({
      include: { personnelPolicy: true },
      orderBy: { createdAt: "asc" },
      where: { tenantId },
    });
    return enterprises.map(
      ({ createdAt, id, personnelPolicy }) =>
        personnelPolicy ?? defaultPolicy(tenantId, id, createdAt),
    );
  }

  async enterprisePolicy(tenantId: string, enterpriseId: string) {
    this.requireEnterpriseScope(tenantId, enterpriseId);
    const enterprise = await this.prisma.enterprise.findFirst({
      include: { personnelPolicy: true },
      where: { id: enterpriseId, tenantId },
    });
    if (!enterprise) throw new NotFoundException("企业不存在或不在当前集团范围内");
    return (
      enterprise.personnelPolicy ?? defaultPolicy(tenantId, enterpriseId, enterprise.createdAt)
    );
  }

  async updatePolicy(
    tenantId: string,
    enterpriseId: string,
    input: UpdateEnterprisePersonnelPolicyDto,
  ) {
    const principal = this.requireTenantPolicyPermission();
    return this.prisma.$transaction(async (transaction) => {
      const enterprise = await transaction.enterprise.findFirst({
        where: { id: enterpriseId, tenantId },
      });
      if (!enterprise) throw new NotFoundException("企业不存在或不在当前集团范围内");
      const before = await transaction.enterprisePersonnelPolicy.findUnique({
        where: { enterpriseId },
      });
      const updated = await transaction.enterprisePersonnelPolicy.upsert({
        create: {
          allowEnterpriseParticipationManagement: input.allowEnterpriseParticipationManagement,
          allowEnterpriseSeatManagement: input.allowEnterpriseSeatManagement,
          defaultParticipationStatus: input.defaultParticipationStatus ?? "PENDING_REVIEW",
          enterpriseId,
          tenantId,
          updatedBy: principal.userId,
        },
        update: {
          allowEnterpriseParticipationManagement: input.allowEnterpriseParticipationManagement,
          allowEnterpriseSeatManagement: input.allowEnterpriseSeatManagement,
          defaultParticipationStatus: input.defaultParticipationStatus,
          updatedBy: principal.userId,
        },
        where: { enterpriseId },
      });
      await transaction.auditLog.create({
        data: {
          action: "enterprise.personnel-policy.update",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId,
          reason: input.reason,
          resourceId: updated.id,
          resourceType: "EnterprisePersonnelPolicy",
          stateAfter: publicPolicyState(updated),
          stateBefore: before ? publicPolicyState(before) : Prisma.JsonNull,
          tenantId,
        },
      });
      return updated;
    });
  }

  async updateParticipation(
    tenantId: string,
    enterpriseId: string,
    membershipId: string,
    input: UpdateMembershipParticipationDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    const tenantManaged = principal.permissions.includes("tenant.membership.policy.manage");
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
    const effectiveUntil = input.effectiveUntil ? new Date(input.effectiveUntil) : null;
    validateParticipationWindow(input.status, effectiveFrom, effectiveUntil);

    return this.prisma.$transaction(async (transaction) => {
      const membership = await transaction.enterpriseMembership.findFirst({
        include: { participation: true },
        where: { enterpriseId, id: membershipId, tenantId },
      });
      if (!membership) throw new NotFoundException("员工不存在或不在当前企业范围内");
      if (membership.status === "LEFT") {
        throw new ConflictException("已离职员工不能调整任务参与状态");
      }
      const policy = await transaction.enterprisePersonnelPolicy.findUnique({
        where: { enterpriseId },
      });
      if (!tenantManaged && policy && !policy.allowEnterpriseParticipationManagement) {
        throw new ForbiddenException("集团未向本企业下放员工任务参与管理权限");
      }
      if (!tenantManaged && membership.participation?.lockedByTenant) {
        throw new ForbiddenException("该员工的任务参与状态已由集团锁定");
      }
      if (!tenantManaged && input.lockedByTenant) {
        throw new ForbiddenException("只有集团管理员可以锁定员工任务参与状态");
      }
      const updated = await transaction.membershipParticipation.upsert({
        create: {
          controlOwner: tenantManaged ? "TENANT" : "ENTERPRISE",
          effectiveFrom,
          effectiveUntil,
          enterpriseId,
          lockedByTenant: tenantManaged ? (input.lockedByTenant ?? false) : false,
          membershipId,
          reason: input.reason,
          reasonCode: input.reasonCode,
          status: input.status,
          tenantId,
          updatedBy: principal.userId,
        },
        update: {
          controlOwner: tenantManaged ? "TENANT" : "ENTERPRISE",
          effectiveFrom,
          effectiveUntil,
          lockedByTenant: tenantManaged
            ? (input.lockedByTenant ?? membership.participation?.lockedByTenant ?? false)
            : false,
          reason: input.reason,
          reasonCode: input.reasonCode,
          status: input.status,
          updatedBy: principal.userId,
          version: { increment: 1 },
        },
        where: { membershipId },
      });
      await transaction.auditLog.create({
        data: {
          action: "membership.participation.update",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId,
          reason: input.reason,
          resourceId: membershipId,
          resourceType: "MembershipParticipation",
          stateAfter: publicParticipationState(updated),
          stateBefore: membership.participation
            ? publicParticipationState(membership.participation)
            : Prisma.JsonNull,
          tenantId,
        },
      });
      return updated;
    });
  }

  async bulkUpdateParticipation(
    tenantId: string,
    enterpriseId: string,
    input: BulkUpdateMembershipParticipationDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    const tenantManaged = principal.permissions.includes("tenant.membership.policy.manage");
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
    const effectiveUntil = input.effectiveUntil ? new Date(input.effectiveUntil) : null;
    validateParticipationWindow(input.status, effectiveFrom, effectiveUntil);
    const membershipIds = [...new Set(input.membershipIds)];

    return this.prisma.$transaction(async (transaction) => {
      const memberships = await transaction.enterpriseMembership.findMany({
        include: { participation: true },
        where: { enterpriseId, id: { in: membershipIds }, tenantId },
      });
      if (memberships.length !== membershipIds.length) {
        throw new NotFoundException("部分员工不存在或不在当前企业范围内");
      }
      if (memberships.some(({ status }) => status === "LEFT")) {
        throw new ConflictException("已离职员工不能调整任务参与状态");
      }
      const policy = await transaction.enterprisePersonnelPolicy.findUnique({
        where: { enterpriseId },
      });
      if (!tenantManaged && policy && !policy.allowEnterpriseParticipationManagement) {
        throw new ForbiddenException("集团未向本企业下放员工任务参与管理权限");
      }
      if (
        !tenantManaged &&
        memberships.some(({ participation }) => participation?.lockedByTenant)
      ) {
        throw new ForbiddenException("所选员工中存在集团锁定的任务参与状态");
      }
      if (!tenantManaged && input.lockedByTenant) {
        throw new ForbiddenException("只有集团管理员可以锁定员工任务参与状态");
      }

      const participations = [];
      for (const membership of memberships) {
        const updated = await transaction.membershipParticipation.upsert({
          create: {
            controlOwner: tenantManaged ? "TENANT" : "ENTERPRISE",
            effectiveFrom,
            effectiveUntil,
            enterpriseId,
            lockedByTenant: tenantManaged ? (input.lockedByTenant ?? false) : false,
            membershipId: membership.id,
            reason: input.reason,
            reasonCode: input.reasonCode,
            status: input.status,
            tenantId,
            updatedBy: principal.userId,
          },
          update: {
            controlOwner: tenantManaged ? "TENANT" : "ENTERPRISE",
            effectiveFrom,
            effectiveUntil,
            lockedByTenant: tenantManaged
              ? (input.lockedByTenant ?? membership.participation?.lockedByTenant ?? false)
              : false,
            reason: input.reason,
            reasonCode: input.reasonCode,
            status: input.status,
            updatedBy: principal.userId,
            version: { increment: 1 },
          },
          where: { membershipId: membership.id },
        });
        await transaction.auditLog.create({
          data: {
            action: "membership.participation.update",
            actorType: "USER",
            actorUserId: principal.userId,
            enterpriseId,
            metadata: { bulk: true },
            reason: input.reason,
            resourceId: membership.id,
            resourceType: "MembershipParticipation",
            stateAfter: publicParticipationState(updated),
            stateBefore: membership.participation
              ? publicParticipationState(membership.participation)
              : Prisma.JsonNull,
            tenantId,
          },
        });
        participations.push(updated);
      }
      return { participations, updatedCount: participations.length };
    });
  }

  async assertEnterpriseSeatManagementAllowed(
    tenantId: string,
    enterpriseId: string,
    database: Pick<Prisma.TransactionClient, "enterprisePersonnelPolicy"> = this.prisma,
  ): Promise<void> {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    if (principal.permissions.includes("tenant.membership.policy.manage")) return;
    const policy = await database.enterprisePersonnelPolicy.findUnique({
      select: { allowEnterpriseSeatManagement: true },
      where: { enterpriseId },
    });
    if (policy && !policy.allowEnterpriseSeatManagement) {
      throw new ForbiddenException("集团未向本企业下放员工启用管理权限");
    }
  }

  private requireTenantPolicyPermission() {
    const principal = this.accessContext.requireSaasAdmin();
    if (!principal.permissions.includes("tenant.membership.policy.manage")) {
      throw new ForbiddenException("当前管理员无权维护集团人员策略");
    }
    return principal;
  }

  private requireEnterpriseScope(tenantId: string, enterpriseId: string) {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "ENTERPRISE" ||
      principal.scope.tenantId !== tenantId ||
      principal.scope.enterpriseId !== enterpriseId
    ) {
      throw new ForbiddenException("请求人员不在当前企业授权范围内");
    }
    return principal;
  }
}

function defaultPolicy(tenantId: string, enterpriseId: string, createdAt: Date) {
  return {
    allowEnterpriseParticipationManagement: true,
    allowEnterpriseSeatManagement: false,
    createdAt,
    defaultParticipationStatus: "PENDING_REVIEW" as const,
    enterpriseId,
    id: `default:${enterpriseId}`,
    tenantId,
    updatedAt: createdAt,
    updatedBy: "SYSTEM",
  };
}

function validateParticipationWindow(
  status: MembershipParticipationStatus,
  effectiveFrom: Date | null,
  effectiveUntil: Date | null,
): void {
  if (status !== "PAUSED" && (effectiveFrom || effectiveUntil)) {
    throw new BadRequestException("只有暂停参与状态可以设置生效和恢复时间");
  }
  if (effectiveUntil && effectiveUntil <= (effectiveFrom ?? new Date())) {
    throw new BadRequestException("暂停恢复时间必须晚于生效时间");
  }
}

function publicPolicyState(policy: {
  allowEnterpriseParticipationManagement: boolean;
  allowEnterpriseSeatManagement: boolean;
  defaultParticipationStatus: string;
}) {
  return {
    allowEnterpriseParticipationManagement: policy.allowEnterpriseParticipationManagement,
    allowEnterpriseSeatManagement: policy.allowEnterpriseSeatManagement,
    defaultParticipationStatus: policy.defaultParticipationStatus,
  };
}

function publicParticipationState(participation: {
  controlOwner: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  lockedByTenant: boolean;
  reason: string | null;
  reasonCode: string | null;
  status: string;
  version: number;
}) {
  return {
    controlOwner: participation.controlOwner,
    effectiveFrom: participation.effectiveFrom?.toISOString() ?? null,
    effectiveUntil: participation.effectiveUntil?.toISOString() ?? null,
    lockedByTenant: participation.lockedByTenant,
    reason: participation.reason,
    reasonCode: participation.reasonCode,
    status: participation.status,
    version: participation.version,
  };
}
