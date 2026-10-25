import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";

type ReadinessStep = Readonly<{
  code: string;
  current: number;
  description: string;
  href: string;
  required: number;
  status: "BLOCKING" | "COMPLETE" | "RECOMMENDED";
  title: string;
}>;

@Injectable()
export class EnterpriseWorkspaceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(TenantCapabilityService)
    private readonly tenantCapabilities: TenantCapabilityService,
  ) {}

  async summary(tenantId: string, enterpriseId: string) {
    return this.scopedSummary(tenantId, enterpriseId, "ENTERPRISE");
  }

  async platformSummary(tenantId: string, enterpriseId: string) {
    return this.scopedSummary(tenantId, enterpriseId, "PLATFORM");
  }

  private async scopedSummary(
    tenantId: string,
    enterpriseId: string,
    accessScope: "ENTERPRISE" | "PLATFORM",
  ) {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      (accessScope === "ENTERPRISE" &&
        (principal.scope.type !== "ENTERPRISE" ||
          principal.scope.tenantId !== tenantId ||
          principal.scope.enterpriseId !== enterpriseId)) ||
      (accessScope === "PLATFORM" && principal.scope.type !== "PLATFORM")
    ) {
      throw new ForbiddenException("Active request scope cannot read this workspace summary");
    }

    const now = new Date();
    const [enterprise, capability] = await Promise.all([
      this.prisma.enterprise.findFirst({ where: { id: enterpriseId, tenantId } }),
      this.tenantCapabilities.current(tenantId),
    ]);
    if (!enterprise) throw new NotFoundException("Enterprise was not found");

    const includeShared = capability.groupSharedMaterialsEnabled;
    const contentScope = includeShared
      ? [{ enterpriseId: null }, { enterpriseId }]
      : [{ enterpriseId }];

    const [
      membershipStatuses,
      explicitAdministrators,
      effectiveMaterials,
      effectiveSensitiveRules,
      activeGeoEntities,
      activeGeoTopics,
      campaignStatuses,
      workItemStatuses,
    ] = await Promise.all([
      this.prisma.enterpriseMembership.groupBy({
        _count: { _all: true },
        by: ["seatStatus", "status"],
        where: { enterpriseId, tenantId },
      }),
      this.prisma.roleBinding.count({
        where: {
          enterpriseId,
          role: { scopeType: "ENTERPRISE", status: "ACTIVE" },
          tenantId,
          user: { status: "ACTIVE" },
        },
      }),
      this.prisma.material.count({
        where: {
          AND: [
            { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          ],
          OR: contentScope,
          authorizationStatus: "AUTHORIZED",
          ingestionStatus: "READY",
          usabilityStatus: "USABLE",
          status: "ACTIVE",
          tenantId,
        },
      }),
      this.prisma.sensitiveRule.count({
        where: {
          AND: [
            { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
            { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
          ],
          OR: contentScope,
          status: "ACTIVE",
          tenantId,
        },
      }),
      this.prisma.geoEntity.count({
        where: { OR: contentScope, status: "ACTIVE", tenantId },
      }),
      this.prisma.geoTopic.count({
        where: { OR: contentScope, status: "ACTIVE", tenantId },
      }),
      this.prisma.campaign.groupBy({
        _count: { _all: true },
        by: ["status"],
        where: { enterpriseId, tenantId },
      }),
      this.prisma.generationWorkItem.groupBy({
        _count: { _all: true },
        by: ["status"],
        where: { enterpriseId, tenantId },
      }),
    ]);

    const enabledSeats = membershipStatuses
      .filter(({ status }) => status === "ACTIVE" || status === "PENDING_BIND")
      .reduce((total, row) => total + row._count._all, 0);
    const memberProfiles = membershipStatuses.reduce((total, row) => total + row._count._all, 0);
    const profileFieldCount = [
      enterprise.name,
      enterprise.brandName,
      enterprise.industry,
      enterprise.city,
    ].filter(Boolean).length;
    const campaignCounts = groupedCounts(campaignStatuses);
    const workItemCounts = groupedCounts(workItemStatuses);
    const steps: ReadinessStep[] = [
      requiredStep(
        "EMPLOYEES",
        enabledSeats,
        1,
        "可参与任务员工",
        "有效且未被暂停或豁免的企业员工可进入活动受众。",
        "/console/employees",
      ),
      requiredStep(
        "MATERIALS",
        effectiveMaterials,
        1,
        "生效授权素材",
        "至少一份未过期且已授权的素材才能支撑可追溯生成。",
        "/console/materials",
      ),
      recommendedStep(
        "PROFILE",
        profileFieldCount,
        4,
        "完善企业资料",
        "品牌、行业和城市会提高生成内容的语境精度。",
        "/console/enterprises",
      ),
      recommendedStep(
        "COMPLIANCE",
        effectiveSensitiveRules,
        1,
        "配置合规规则",
        "敏感词和替换建议会在每次活动中冻结快照。",
        "/console/compliance",
      ),
      recommendedStep(
        "GEO",
        Math.min(activeGeoEntities, activeGeoTopics),
        1,
        "建立 GEO 实体与主题",
        "实体和问题库帮助内容稳定覆盖品牌与业务语义。",
        "/console/compliance",
      ),
    ];
    const campaignReady = steps.every(({ status }) => status !== "BLOCKING");

    return {
      campaignReady,
      campaigns: {
        active: campaignCounts.ACTIVE ?? 0,
        approved: campaignCounts.APPROVED ?? 0,
        completed: campaignCounts.COMPLETED ?? 0,
        generating: campaignCounts.GENERATING ?? 0,
        generationFailed: campaignCounts.GENERATION_FAILED ?? 0,
        reviewPending: campaignCounts.REVIEW_PENDING ?? 0,
        total: Object.values(campaignCounts).reduce((total, count) => total + count, 0),
      },
      capabilities: {
        geoEnabled: capability.geoEnabled,
        geoLevel: capability.geoLevel,
        groupSharedMaterialsEnabled: capability.groupSharedMaterialsEnabled,
        imagesPerDistribution: capability.imagesPerDistribution,
      },
      counts: {
        activeGeoEntities,
        activeGeoTopics,
        effectiveMaterials,
        effectiveSensitiveRules,
        enabledSeats,
        enterpriseAdministrators: explicitAdministrators,
        memberProfiles,
      },
      enterprise,
      generation: {
        failed: workItemCounts.FAILED ?? 0,
        queued: workItemCounts.QUEUED ?? 0,
        running: workItemCounts.RUNNING ?? 0,
        succeeded: workItemCounts.SUCCEEDED ?? 0,
        successRate: generationSuccessRate(workItemCounts),
      },
      nextAction: nextAction({
        campaignCounts,
        enabledSeats,
        effectiveMaterials,
        permissions:
          accessScope === "PLATFORM"
            ? ["campaign.approve", "campaign.manage", "enterprise.settings.manage"]
            : principal.permissions,
        profileFieldCount,
      }),
      steps,
    };
  }
}

function requiredStep(
  code: string,
  current: number,
  required: number,
  title: string,
  description: string,
  href: string,
): ReadinessStep {
  return {
    code,
    current,
    description,
    href,
    required,
    status: current >= required ? "COMPLETE" : "BLOCKING",
    title,
  };
}

function recommendedStep(
  code: string,
  current: number,
  required: number,
  title: string,
  description: string,
  href: string,
): ReadinessStep {
  return {
    code,
    current,
    description,
    href,
    required,
    status: current >= required ? "COMPLETE" : "RECOMMENDED",
    title,
  };
}

function groupedCounts(
  rows: ReadonlyArray<Readonly<{ _count: Readonly<{ _all: number }>; status: string }>>,
): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
}

function generationSuccessRate(counts: Record<string, number>): number | null {
  const terminal = (counts.SUCCEEDED ?? 0) + (counts.FAILED ?? 0);
  return terminal === 0 ? null : (counts.SUCCEEDED ?? 0) / terminal;
}

function nextAction(input: {
  campaignCounts: Record<string, number>;
  effectiveMaterials: number;
  enabledSeats: number;
  permissions: readonly string[];
  profileFieldCount: number;
}) {
  if (input.enabledSeats === 0) {
    return action(
      "ENABLE_EMPLOYEES",
      "导入可参与员工",
      "活动按企业内可参与任务的员工身份生成独立图文。",
      "/console/employees",
    );
  }
  if (input.effectiveMaterials === 0) {
    return action(
      "ADD_MATERIAL",
      "建立首份授权素材",
      "系统会从实际生效的集团/企业素材中自动召回事实。",
      "/console/materials",
    );
  }
  if (
    (input.campaignCounts.GENERATION_FAILED ?? 0) > 0 &&
    input.permissions.includes("campaign.manage")
  ) {
    return action(
      "RECOVER_GENERATION",
      "处理生成失败项",
      "已成功内容会保留，只需对最终失败员工执行局部重试。",
      "/console/campaigns?view=ACTION_REQUIRED",
    );
  }
  if (
    (input.campaignCounts.REVIEW_PENDING ?? 0) > 0 &&
    input.permissions.includes("campaign.approve")
  ) {
    return action(
      "REVIEW_CAMPAIGN",
      "审核待批准活动",
      "抽检员工独立图文后，设置统一解锁时间。",
      "/console/campaigns?view=ACTION_REQUIRED",
    );
  }
  if ((input.campaignCounts.GENERATING ?? 0) > 0) {
    return action(
      "MONITOR_GENERATION",
      "查看自动生成进度",
      "后台正在执行素材召回、母版和员工级独立图文生成。",
      "/console/campaigns?view=ACTION_REQUIRED",
    );
  }
  if ((input.campaignCounts.APPROVED ?? 0) > 0) {
    return action(
      "VIEW_SCHEDULED",
      "查看待解锁活动",
      "活动已审核通过，将在设定的开放时间向员工开放。",
      "/console/campaigns?view=UPCOMING",
    );
  }
  if (input.profileFieldCount < 4 && input.permissions.includes("enterprise.settings.manage")) {
    return action(
      "COMPLETE_PROFILE",
      "完善品牌语境",
      "补充品牌、行业和城市，让后续生成更贴合企业。",
      "/console/enterprises",
    );
  }
  if (input.permissions.includes("campaign.manage")) {
    return action(
      "CREATE_CAMPAIGN",
      "创建下一期营销活动",
      "只需输入运营目标并选择受众，其余生成步骤由后台自动完成。",
      "/console/campaigns/new",
    );
  }
  return action(
    "VIEW_CAMPAIGNS",
    "查看营销活动",
    "当前角色可以查看已授权范围内的生成和审核状态。",
    "/console/campaigns",
  );
}

function action(code: string, title: string, description: string, href: string) {
  return { code, description, href, title };
}
