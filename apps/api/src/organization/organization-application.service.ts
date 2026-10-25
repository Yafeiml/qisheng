import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { type Enterprise, Prisma, type Tenant } from "@xhs-agentic/database";
import { tenantAccessScope } from "../access/access-scope";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import {
  createdAtCursorWhere,
  createdAtOrderBy,
  pageTake,
  toCursorPage,
} from "../http/cursor-pagination";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import { withGeneratedEnterpriseCode } from "./enterprise-code";
import { IndustryService } from "./industry.service";
import type {
  CreateEnterpriseDto,
  CreateTenantDto,
  EnterpriseMembershipQueryDto,
  SetEnterpriseStatusDto,
  UpdateEnterpriseDto,
  UpdatePublisherContextDto,
} from "./organization.dto";
import { OrganizationRepository } from "./organization.repository";

@Injectable()
export class OrganizationApplicationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrganizationRepository) private readonly organizations: OrganizationRepository,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(TenantCapabilityService)
    private readonly capabilities: TenantCapabilityService,
    @Inject(IndustryService) private readonly industries: IndustryService,
  ) {}

  async listPlatformTenants(): Promise<Tenant[]> {
    const principal = this.accessContext.requireSaasAdmin();
    this.assertPlatform(principal.scope.type);
    return this.organizations.listTenants(principal.scope);
  }

  async createTenant(_input: CreateTenantDto): Promise<Tenant> {
    const principal = this.accessContext.requireSaasAdmin();
    this.assertPlatform(principal.scope.type);
    throw new ForbiddenException("此安装只管理一个企业或集团；请在现有集团下新增企业");
  }

  async listPlatformEnterprises(tenantId: string): Promise<Enterprise[]> {
    const principal = this.accessContext.requireSaasAdmin();
    this.assertPlatform(principal.scope.type);
    await this.requireActiveTenant(tenantId);
    return this.organizations.listEnterprises(tenantAccessScope(tenantId));
  }

  async listTenantEnterprises(tenantId: string) {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "TENANT" || principal.scope.tenantId !== tenantId) {
      throw new ForbiddenException("Active request scope does not match the requested tenant");
    }
    const [enterprises, membershipCounts, campaignCounts] = await Promise.all([
      this.organizations.listEnterprises(principal.scope),
      this.prisma.enterpriseMembership.groupBy({
        _count: { _all: true },
        by: ["enterpriseId", "seatStatus"],
        where: { tenantId },
      }),
      this.prisma.campaign.groupBy({
        _count: { _all: true },
        by: ["enterpriseId", "status"],
        where: { tenantId },
      }),
    ]);
    return enterprises.map((enterprise) => ({
      ...enterprise,
      campaigns: groupedEnterpriseCounts(campaignCounts, enterprise.id, "status"),
      seats: groupedEnterpriseCounts(membershipCounts, enterprise.id, "seatStatus"),
    }));
  }

  async getEnterprise(tenantId: string, enterpriseId: string) {
    const principal = this.accessContext.requireSaasAdmin();
    this.assertEnterpriseScope(principal.scope, tenantId, enterpriseId);
    const enterprise = await this.prisma.enterprise.findFirst({
      where: { id: enterpriseId, tenantId },
    });
    if (!enterprise) throw new NotFoundException("Enterprise was not found");
    const [membershipCounts, campaignCounts] = await Promise.all([
      this.prisma.enterpriseMembership.groupBy({
        _count: { _all: true },
        by: ["seatStatus"],
        where: { enterpriseId, tenantId },
      }),
      this.prisma.campaign.groupBy({
        _count: { _all: true },
        by: ["status"],
        where: { enterpriseId, tenantId },
      }),
    ]);
    return {
      ...enterprise,
      campaigns: Object.fromEntries(campaignCounts.map((row) => [row.status, row._count._all])),
      seats: Object.fromEntries(membershipCounts.map((row) => [row.seatStatus, row._count._all])),
    };
  }

  async createEnterprise(tenantId: string, input: CreateEnterpriseDto): Promise<Enterprise> {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "PLATFORM" &&
      (principal.scope.type !== "TENANT" || principal.scope.tenantId !== tenantId)
    ) {
      throw new ForbiddenException("Cannot create an enterprise outside the active scope");
    }
    if (input.administratorPhone !== undefined)
      throw new ConflictException("请先创建企业，再到账号管理新增账号并设置登录密码");
    await this.industries.assertAvailable(input.industry);
    try {
      return await withGeneratedEnterpriseCode(this.prisma, (code) =>
        this.prisma.$transaction(async (transaction) => {
          const tenant = await transaction.tenant.findFirst({
            select: { customerType: true, id: true },
            where: { id: tenantId, status: "ACTIVE" },
          });
          if (!tenant) throw new NotFoundException("Active tenant was not found");
          if (tenant.customerType === "SINGLE_ENTERPRISE") {
            const existingCount = await transaction.enterprise.count({ where: { tenantId } });
            if (existingCount > 0)
              throw new ConflictException(
                "A single-enterprise tenant cannot create another enterprise",
              );
          }
          await this.capabilities.assertEnterpriseCapacityIfConfigured(tenantId, 1, transaction);
          const enterprise = await transaction.enterprise.create({
            data: {
              brandName: input.brandName,
              city: input.city,
              code,
              industry: input.industry,
              name: input.name,
              tenantId,
            },
          });
          await transaction.auditLog.createMany({
            data: [
              {
                action: "enterprise.create",
                actorType: "USER",
                actorUserId: principal.userId,
                enterpriseId: enterprise.id,
                resourceId: enterprise.id,
                resourceType: "Enterprise",
                stateAfter: {
                  administratorAssigned: false,
                  code: enterprise.code,
                  name: enterprise.name,
                  status: enterprise.status,
                },
                tenantId,
              },
            ],
          });
          return enterprise;
        }),
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new ConflictException("创建企业发生唯一值冲突，请重试");
      throw error;
    }
  }

  async updateEnterprise(
    tenantId: string,
    enterpriseId: string,
    input: UpdateEnterpriseDto,
  ): Promise<Enterprise> {
    const principal = this.accessContext.requireSaasAdmin();
    this.assertEnterpriseScope(principal.scope, tenantId, enterpriseId);
    if (
      input.name === undefined &&
      input.brandName === undefined &&
      input.industry === undefined &&
      input.city === undefined
    ) {
      throw new ConflictException("At least one enterprise profile field is required");
    }
    return this.prisma.$transaction(async (transaction) => {
      const enterprise = await transaction.enterprise.findFirst({
        where: { id: enterpriseId, tenantId },
      });
      if (!enterprise) throw new NotFoundException("Enterprise was not found");
      if (input.industry !== undefined && input.industry !== enterprise.industry) {
        await this.industries.assertAvailable(input.industry);
      }
      const updated = await transaction.enterprise.update({
        data: {
          brandName: input.brandName,
          city: input.city,
          industry: input.industry,
          name: input.name,
        },
        where: { id: enterprise.id },
      });
      await transaction.auditLog.create({
        data: {
          action: "enterprise.update",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId,
          resourceId: enterpriseId,
          resourceType: "Enterprise",
          stateAfter: enterpriseProfileState(updated),
          stateBefore: enterpriseProfileState(enterprise),
          tenantId,
        },
      });
      return updated;
    });
  }

  async setEnterpriseStatus(
    tenantId: string,
    enterpriseId: string,
    input: SetEnterpriseStatusDto,
  ): Promise<Enterprise> {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "PLATFORM" &&
      (principal.scope.type !== "TENANT" || principal.scope.tenantId !== tenantId)
    ) {
      throw new ForbiddenException("Enterprise status requires tenant or platform scope");
    }
    return this.prisma.$transaction(
      async (transaction) => {
        const enterprise = await transaction.enterprise.findFirst({
          where: { id: enterpriseId, tenantId },
        });
        if (!enterprise) throw new NotFoundException("Enterprise was not found");
        if (enterprise.status === input.status) return enterprise;
        if (input.status === "DISABLED") {
          const activeCampaign = await transaction.campaign.findFirst({
            select: { id: true },
            where: {
              enterpriseId,
              status: {
                in: ["GENERATING", "REVIEW_PENDING", "APPROVED", "ACTIVE"],
              },
              tenantId,
            },
          });
          if (activeCampaign) {
            throw new ConflictException("Enterprise with an active campaign cannot be disabled");
          }
        } else {
          await this.capabilities.assertEnterpriseCapacity(tenantId, 1, transaction);
        }
        const updated = await transaction.enterprise.update({
          data: { status: input.status },
          where: { id: enterprise.id },
        });
        await transaction.auditLog.create({
          data: {
            action: input.status === "ACTIVE" ? "enterprise.enable" : "enterprise.disable",
            actorType: "USER",
            actorUserId: principal.userId,
            enterpriseId,
            reason: input.reason,
            resourceId: enterpriseId,
            resourceType: "Enterprise",
            stateAfter: { status: updated.status },
            stateBefore: { status: enterprise.status },
            tenantId,
          },
        });
        return updated;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async listEnterpriseMemberships(
    tenantId: string,
    enterpriseId: string,
    query: EnterpriseMembershipQueryDto,
  ) {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "ENTERPRISE" ||
      principal.scope.tenantId !== tenantId ||
      principal.scope.enterpriseId !== enterpriseId
    ) {
      throw new ForbiddenException("Active request scope does not match the requested enterprise");
    }
    const where: Prisma.EnterpriseMembershipWhereInput = {
      enterpriseId,
      smsNotificationStatus: query.smsNotificationStatus,
      tenantId,
    };
    const [memberships, totalCount] = await Promise.all([
      this.prisma.enterpriseMembership.findMany({
        include: {
          participation: true,
        },
        orderBy: createdAtOrderBy(),
        take: pageTake(query),
        where: {
          AND: [where, createdAtCursorWhere(query)],
        },
      }),
      this.prisma.enterpriseMembership.count({ where }),
    ]);
    const page = toCursorPage(
      memberships.map(({ participation, ...membership }) => ({
        ...membership,
        participation: participation
          ? {
              controlOwner: participation.controlOwner,
              effectiveUntil: participation.effectiveUntil,
              lockedByTenant: participation.lockedByTenant,
              status: participation.status,
            }
          : null,
      })),
      query,
    );
    return { ...page, pageInfo: { ...page.pageInfo, totalCount } };
  }

  async updatePublisherContext(
    tenantId: string,
    enterpriseId: string,
    membershipId: string,
    input: UpdatePublisherContextDto,
  ) {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "ENTERPRISE" ||
      principal.scope.tenantId !== tenantId ||
      principal.scope.enterpriseId !== enterpriseId ||
      !principal.permissions.includes("enterprise.membership.manage")
    )
      throw new ForbiddenException("发布档案仅由当前企业授权运营维护，员工不选择账号定位");
    const now = new Date();
    if (
      !Number.isFinite(Date.parse(input.validUntil)) ||
      Date.parse(input.validUntil) <= now.getTime()
    )
      throw new ConflictException("发布条件有效期必须晚于当前时间");
    const qualified = input.category === "MEDICAL_KOS" || input.category === "INSTITUTION";
    if (!qualified && (input.allowBrandAttribution || input.allowPlatformConsultation))
      throw new ConflictException("普通或未知资格不能被升级为医疗品牌或咨询入口");
    if (input.allowPlatformConsultation && !input.allowBrandAttribution)
      throw new ConflictException("咨询入口必须同时具备已核验的主体归属");
    return this.prisma.$transaction(
      async (transaction) => {
        const member = await transaction.enterpriseMembership.findFirst({
          where: { tenantId, enterpriseId, id: membershipId },
        });
        if (!member) throw new NotFoundException("当前企业未找到该成员");
        const publisherContext = {
          schemaVersion: "medical-publisher-v1",
          category: input.category,
          authorId: input.authorId,
          validUntil: new Date(input.validUntil).toISOString(),
          evidence: input.evidence,
          role: input.role ?? "",
          allowBrandAttribution: qualified && input.allowBrandAttribution,
          allowPlatformConsultation: qualified && input.allowPlatformConsultation,
          verifiedAt: now.toISOString(),
          verifiedBy: principal.userId,
          verificationMethod: "ENTERPRISE_MANUAL_REVIEW",
          experienceFacts: [],
        };
        const updated = await transaction.enterpriseMembership.update({
          where: { id: member.id },
          data: { publisherContext },
        });
        await transaction.auditLog.create({
          data: {
            action: "enterprise.publisher-context.verify",
            actorType: "USER",
            actorUserId: principal.userId,
            tenantId,
            enterpriseId,
            resourceType: "EnterpriseMembership",
            resourceId: membershipId,
            reason: input.reason,
            stateBefore: member.publisherContext ?? Prisma.JsonNull,
            stateAfter: publisherContext,
          },
        });
        return updated;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async requireActiveTenant(tenantId: string): Promise<void> {
    const tenant = await this.prisma.tenant.findFirst({
      select: { id: true },
      where: { id: tenantId, status: "ACTIVE" },
    });
    if (!tenant) {
      throw new NotFoundException("Active tenant was not found");
    }
  }

  private assertPlatform(scopeType: string): void {
    if (scopeType !== "PLATFORM") {
      throw new ForbiddenException("This operation requires platform scope");
    }
  }

  private assertEnterpriseScope(
    scope: { type: string; tenantId?: string; enterpriseId?: string },
    tenantId: string,
    enterpriseId: string,
  ): void {
    if (scope.type === "PLATFORM") return;
    if (scope.type === "TENANT" && scope.tenantId === tenantId) return;
    if (
      scope.type === "ENTERPRISE" &&
      scope.tenantId === tenantId &&
      scope.enterpriseId === enterpriseId
    ) {
      return;
    }
    throw new ForbiddenException("Active request scope does not include this enterprise");
  }
}

function groupedEnterpriseCounts(
  rows: ReadonlyArray<
    Readonly<{
      _count: Readonly<{ _all: number }>;
      enterpriseId: string;
      seatStatus?: string;
      status?: string;
    }>
  >,
  enterpriseId: string,
  field: "seatStatus" | "status",
): Record<string, number> {
  return Object.fromEntries(
    rows
      .filter((row) => row.enterpriseId === enterpriseId)
      .map((row) => [String(row[field]), row._count._all]),
  );
}

function enterpriseProfileState(enterprise: Enterprise) {
  return {
    brandName: enterprise.brandName,
    city: enterprise.city,
    code: enterprise.code,
    industry: enterprise.industry,
    name: enterprise.name,
    status: enterprise.status,
  };
}
