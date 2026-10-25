import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { generationDeliveryMode } from "@xhs-agentic/ai-gateway";
import { type Prisma, Prisma as PrismaNamespace, type RuntimePolicy } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { eligibleMembershipParticipationWhere } from "../employee/personnel-eligibility";
import {
  type FrozenGenerationRoute,
  ModelConfigurationService,
} from "../model-configuration/model-configuration.service";
import { modelIncidentCustomerMessage } from "../model-configuration/model-incident-notification";
import {
  ModelQualificationService,
  type RouteQualificationAssessment,
} from "../model-configuration/model-qualification.service";
import { RuntimePolicyService } from "../model-configuration/runtime-policy.service";
import { PlatformContentSafetyService } from "../platform-settings/platform-content-safety.service";
import {
  capabilityAllowsImageCount,
  TenantCapabilityService,
} from "../resource-policy/tenant-capability.service";
import type { CreateCampaignDto } from "./campaign.dto";
import { type GenerationQueueMetrics, GenerationQueueService } from "./generation-queue.service";
import { ImageDeliveryService } from "./image-delivery.service";
import {
  type FrozenMedicalPlan,
  MedicalPlanningService,
  medicalInternalBrief,
} from "./medical-planning.service";

type EnterpriseScope = Readonly<{ enterpriseId: string; tenantId: string }>;
type CheckStatus = "BLOCKING" | "PASSED" | "WARNING";

type InternalCheck = Readonly<{
  audience: "CUSTOMER" | "PLATFORM";
  code: string;
  description: string;
  status: CheckStatus;
  title: string;
}>;

export type GenerationPreflightResult = Readonly<{
  medicalPlan?: FrozenMedicalPlan | null;
  assessment: RouteQualificationAssessment | null;
  audienceCount: number;
  capabilities: Readonly<{
    imagesPerDistribution: number;
  }> | null;
  checkedAt: Date;
  checks: readonly InternalCheck[];
  deliveryMode: "DEVELOPMENT" | "PRODUCTION";
  estimatedCost: number;
  frozenRoute: FrozenGenerationRoute | null;
  imageCount: number;
  policy: RuntimePolicy;
  queue: GenerationQueueMetrics;
  ready: boolean;
}>;

@Injectable()
export class GenerationPreflightService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(TenantCapabilityService)
    private readonly tenantCapabilities: TenantCapabilityService,
    @Inject(ModelConfigurationService)
    private readonly modelConfiguration: ModelConfigurationService,
    @Inject(ModelQualificationService)
    private readonly qualifications: ModelQualificationService,
    @Inject(RuntimePolicyService) private readonly runtimePolicy: RuntimePolicyService,
    @Inject(GenerationQueueService) private readonly queue: GenerationQueueService,
    @Inject(ImageDeliveryService) private readonly imageDelivery: ImageDeliveryService,
    @Inject(PlatformContentSafetyService)
    private readonly contentSafety: PlatformContentSafetyService,
    @Inject(MedicalPlanningService) private readonly medicalPlanning?: MedicalPlanningService,
  ) {}

  async customerPreflight(scope: EnterpriseScope, input: CreateCampaignDto) {
    this.requireEnterpriseScope(scope);
    return customerResponse(await this.evaluate(scope, input));
  }

  async platformPreflight(scope: EnterpriseScope, input: CreateCampaignDto) {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") {
      throw new ForbiddenException("Platform generation preflight requires platform scope");
    }
    return platformResponse(await this.evaluate(scope, input));
  }

  async requireCampaignReady(scope: EnterpriseScope, input: CreateCampaignDto) {
    const result = await this.evaluate(scope, input);
    if (!result.ready || !result.frozenRoute || !result.assessment) {
      throw new ConflictException({
        code: "GENERATION_PREFLIGHT_BLOCKED",
        details: customerResponse(result).checks,
        message: "Generation service is not ready for this campaign",
      });
    }
    return result as GenerationPreflightResult & {
      assessment: RouteQualificationAssessment;
      frozenRoute: FrozenGenerationRoute;
    };
  }

  async assertStillCurrent(
    transaction: Prisma.TransactionClient,
    result: GenerationPreflightResult & {
      assessment: RouteQualificationAssessment;
      frozenRoute: FrozenGenerationRoute;
    },
  ): Promise<void> {
    const currentPolicy = await this.runtimePolicy.current(transaction);
    if (
      currentPolicy.id !== result.policy.id ||
      currentPolicy.updatedAt.getTime() !== result.policy.updatedAt.getTime()
    ) {
      throw new ConflictException({
        code: "GENERATION_PREFLIGHT_STALE",
        message: "Runtime policy changed after generation preflight",
      });
    }
    await this.qualifications.assertCurrent(
      {
        configurationFingerprint: result.assessment.configurationFingerprint,
        deliveryMode: result.deliveryMode,
        qualificationId: result.assessment.qualification?.id ?? null,
        routeId: result.frozenRoute.routeId,
        ...(result.frozenRoute.requiresImage === false ? { requiresImage: false } : {}),
      },
      currentPolicy,
      transaction,
    );
  }

  snapshotCreateData(
    campaignId: string,
    scope: EnterpriseScope,
    result: GenerationPreflightResult & {
      assessment: RouteQualificationAssessment;
      frozenRoute: FrozenGenerationRoute;
    },
  ): Prisma.CampaignPreflightSnapshotUncheckedCreateInput {
    return {
      campaignId,
      checks: result.checks as unknown as Prisma.InputJsonValue,
      configurationFingerprint: result.assessment.configurationFingerprint,
      deliveryMode: result.deliveryMode,
      enterpriseId: scope.enterpriseId,
      estimatedCost: new PrismaNamespace.Decimal(result.estimatedCost),
      queueMetrics: result.queue as unknown as Prisma.InputJsonValue,
      routeQualificationId: result.assessment.qualification?.id,
      runtimePolicyId: result.policy.id,
      tenantId: scope.tenantId,
    };
  }

  private async evaluate(
    scope: EnterpriseScope,
    input: CreateCampaignDto,
  ): Promise<GenerationPreflightResult> {
    const checkedAt = new Date();
    let medicalPlan: FrozenMedicalPlan | null = null;
    let medicalError: string | null = null;
    if (this.medicalPlanning) {
      try {
        medicalPlan = await this.medicalPlanning.resolve(scope, input, checkedAt);
      } catch (error) {
        medicalError = safeErrorMessage(error);
      }
    }
    if (!medicalPlan && !medicalError && (input.prompt?.trim().length ?? 0) < 4)
      medicalError = "请填写至少 4 个字的主题和传播目标。";
    const deliveryMode = generationDeliveryMode();
    const selectedMembershipIds = normalizeIds(input.membershipIds);
    const policy = await this.runtimePolicy.current();
    const [enterprise, capability, memberships, infrastructure, contentSafety] = await Promise.all([
      this.prisma.enterprise.findFirst({
        select: { id: true, status: true },
        where: { id: scope.enterpriseId, tenantId: scope.tenantId },
      }),
      this.tenantCapabilities.current(scope.tenantId),
      this.prisma.enterpriseMembership.findMany({
        select: { id: true },
        where: {
          ...eligibleMembershipParticipationWhere(checkedAt),
          enterpriseId: scope.enterpriseId,
          id: selectedMembershipIds ? { in: selectedMembershipIds } : undefined,
          status: { in: ["ACTIVE", "PENDING_BIND"] },
          tenantId: scope.tenantId,
        },
      }),
      this.infrastructure(policy, Boolean(medicalPlan)),
      this.contentSafety.readiness(),
    ]);

    const checks: InternalCheck[] = [...infrastructure.checks];
    checks.push(
      businessCheck(
        "MEDICAL_SELECTION",
        !medicalError,
        "内容计划与发布条件",
        medicalError ??
          (medicalPlan
            ? "以有效问题、真实资料和企业维护的发布条件生成 GEO 与成交计划。"
            : "当前活动内容计划有效。"),
      ),
    );
    if (
      medicalPlan &&
      !medicalPlan.publishers.some(({ publisherContext }) => publisherContext.allowBrandAttribution)
    ) {
      checks.push({
        audience: "CUSTOMER",
        code: "MEDICAL_BRAND_CONTEXT",
        title: "品牌 GEO 归属",
        status: "WARNING",
        description:
          "当前发布安排仅支持一般问题内容；没有获准品牌归属时，不能计作品牌 GEO 曝光或引用。",
      });
    }
    if (medicalPlan?.conversionPath === "NONE") {
      checks.push({
        audience: "CUSTOMER",
        code: "MEDICAL_CONVERSION_CONTEXT",
        title: "成交承接",
        status: "WARNING",
        description:
          "本次未配置允许的承接入口，咨询、预约和实际成交须另有真实来源核验，不能把互动当成交。",
      });
    }
    if (medicalPlan && !inlineGeneration()) {
      const result = await measured(() => this.queue.getOperationalMetrics(true));
      checks.push(
        businessCheck(
          "MEDICAL_WORKER",
          Boolean(
            result.value &&
              result.value.workers >= policy.minimumGenerationWorkers &&
              !result.value.paused,
          ),
          "医疗计划执行能力",
          "需要支持医疗选择计划的专用内容 Worker 在线；旧 Worker 不能执行新计划。",
        ),
      );
    }
    checks.push(
      businessCheck(
        "CAMPAIGN_OPENING_TIME",
        !input.visibleAt || new Date(input.visibleAt).getTime() > checkedAt.getTime(),
        "活动开放时间",
        "可在审核通过后立即开放，也可以选择未来的开放时间。",
      ),
    );
    checks.push(
      businessCheck(
        "CONTENT_SAFETY_READY",
        deliveryMode === "DEVELOPMENT" || contentSafety.configured,
        "内容安全服务",
        deliveryMode === "DEVELOPMENT" || contentSafety.configured
          ? "生成图文会按当前运行模式执行内容安全复核。"
          : "内容安全服务需要 SaaS 平台管理员完成配置。",
      ),
    );
    checks.push(
      businessCheck(
        "ENTERPRISE_ACTIVE",
        Boolean(enterprise?.status === "ACTIVE"),
        "企业状态",
        "当前企业必须处于启用状态。",
      ),
    );
    const audienceCount = memberships.length;
    const requestedAudienceValid =
      audienceCount > 0 &&
      (!selectedMembershipIds || audienceCount === selectedMembershipIds.length);
    checks.push(
      businessCheck(
        "AUDIENCE_VALID",
        requestedAudienceValid,
        "活动受众",
        "所有受众都必须是当前企业中可参与任务的有效员工。",
      ),
    );
    const imageCount = input.imageCount ?? capability.imagesPerDistribution;
    checks.push(
      businessCheck(
        "IMAGE_CONFIGURATION",
        capabilityAllowsImageCount(capability, imageCount),
        "每员工图片数",
        `当前租户配置每份员工内容最多生成 ${capability.imagesPerDistribution} 张图片。`,
      ),
    );

    const effectiveMaterials = await this.effectiveMaterialCount(
      scope,
      capability.groupSharedMaterialsEnabled,
      checkedAt,
      Boolean(medicalPlan),
    );
    checks.push(
      businessCheck(
        "AUTHORIZED_MATERIALS",
        effectiveMaterials > 0,
        "授权素材",
        medicalPlan
          ? "至少需要一份与所选问题有关的有效回答依据；环境照片和存档资料不能代替依据。"
          : "至少需要一份当前有效、已授权且启用的企业或集团素材。",
      ),
    );
    const embeddingReady =
      !policy.embeddingModelId ||
      deliveryMode === "DEVELOPMENT" ||
      Boolean(
        policy.embeddingModelId &&
          (await this.prisma.modelDefinition.count({
            where: {
              capabilities: { has: "EMBEDDING" },
              id: policy.embeddingModelId,
              provider: { status: "ACTIVE", synthetic: false },
              status: "ACTIVE",
              synthetic: false,
            },
          })) > 0,
      );
    checks.push(
      businessCheck(
        "RETRIEVAL_INDEX_READY",
        embeddingReady,
        "素材检索服务",
        embeddingReady
          ? policy.embeddingModelId
            ? "素材检索与证据冻结服务可用。"
            : "使用本地字符特征基础检索，无需配置外部 Embedding 供应商。"
          : "素材检索服务需要 SaaS 平台管理员完成配置。",
      ),
    );

    let frozenRoute: FrozenGenerationRoute | null = null;
    let assessment: RouteQualificationAssessment | null = null;
    try {
      frozenRoute = await this.modelConfiguration.freezeGenerationRoute(
        scope.tenantId,
        scope.enterpriseId,
        !medicalPlan || medicalPlan.imageMode === "ILLUSTRATION",
      );
      assessment = await this.qualifications.assessRoute(
        frozenRoute.routeId,
        policy,
        checkedAt,
        frozenRoute.requiresImage !== false,
      );
      checks.push(
        businessCheck(
          "MODEL_ROUTE_MANAGED",
          true,
          "平台模型路由",
          "文案与图片模型由 SaaS 平台统一配置，不要求企业提供 API Key。",
        ),
      );
      checks.push(
        businessCheck(
          "GENERATION_ROUTE",
          assessment.eligible,
          "生成服务资格",
          assessment.eligible
            ? "SaaS 平台已完成当前生成路由的资格检查。"
            : assessment.runtimeHealth?.state === "REVALIDATION_REQUIRED"
              ? modelIncidentCustomerMessage(
                  assessment.runtimeHealth.notificationStatus ?? "PENDING",
                )
              : "当前生成服务需要 SaaS 平台管理员处理后才能创建活动。",
        ),
      );
      for (const reason of assessment.reasons) {
        checks.push({
          audience: "PLATFORM",
          code: reason.code,
          description: reason.message,
          status: "BLOCKING",
          title: "模型路由诊断",
        });
      }
    } catch (error) {
      checks.push({
        audience: "CUSTOMER",
        code: "GENERATION_ROUTE_UNAVAILABLE",
        description: "当前生成服务需要 SaaS 平台管理员处理后才能创建活动。",
        status: "BLOCKING",
        title: "生成服务资格",
      });
      checks.push({
        audience: "PLATFORM",
        code: "GENERATION_ROUTE_RESOLUTION_FAILED",
        description: safeErrorMessage(error),
        status: "BLOCKING",
        title: "模型路由诊断",
      });
    }

    const billableImages = medicalPlan && medicalPlan.imageMode !== "ILLUSTRATION" ? 0 : imageCount;
    const estimatedCost = assessment
      ? estimatedCampaignCost(
          assessment,
          audienceCount,
          billableImages,
          (medicalPlan ? medicalInternalBrief(medicalPlan) : (input.prompt ?? "")).length,
        )
      : 0;
    if (assessment && !pricingComplete(assessment, billableImages > 0)) {
      checks.push({
        audience: "PLATFORM",
        code: "MODEL_PRICING_INCOMPLETE",
        description: "One or more primary model pricing fields are missing; estimate may be zero.",
        status: "WARNING",
        title: "模型计价信息",
      });
    }
    if (estimatedCost >= Number(policy.costWarningThreshold)) {
      checks.push({
        audience: "PLATFORM",
        code: "CAMPAIGN_COST_WARNING",
        description: `Estimated campaign cost ${estimatedCost.toFixed(6)} ${policy.costCurrency} exceeds the warning threshold.`,
        status: "WARNING",
        title: "预计成本告警",
      });
    }
    const ready = checks.every(({ status }) => status !== "BLOCKING");
    return {
      medicalPlan,
      assessment,
      audienceCount,
      capabilities: {
        imagesPerDistribution: capability.imagesPerDistribution,
      },
      checkedAt,
      checks,
      deliveryMode,
      estimatedCost,
      frozenRoute,
      imageCount,
      policy,
      queue: infrastructure.queue,
      ready,
    };
  }

  private async infrastructure(policy: RuntimePolicy, medical = false) {
    if (inlineGeneration()) {
      return {
        checks: [
          passedPlatformCheck("DATABASE", "数据库", "内联测试模式使用当前数据库连接。"),
          passedPlatformCheck("GENERATION_QUEUE", "生成队列", "内联测试模式不依赖 BullMQ Worker。"),
          passedPlatformCheck("OBJECT_STORAGE", "对象存储", "内联测试模式不交付对象存储图片。"),
        ],
        queue: emptyQueueMetrics(),
      };
    }
    const [database, objectStorage, queueResult] = await Promise.all([
      measured(async () => {
        await this.prisma.$queryRaw`SELECT 1`;
      }),
      measured(() => this.imageDelivery.checkReadiness()),
      measured(() => this.queue.getOperationalMetrics(medical)),
    ]);
    const queueMetrics = queueResult.value ?? emptyQueueMetrics();
    const backlog = queueMetrics.waiting + queueMetrics.delayed;
    const activeJobs = queueMetrics.active;
    const checks: InternalCheck[] = [
      infrastructureCheck("DATABASE", "数据库", database.ok, database.error),
      infrastructureCheck("OBJECT_STORAGE", "对象存储", objectStorage.ok, objectStorage.error),
      infrastructureCheck("REDIS_QUEUE", "Redis 与生成队列", queueResult.ok, queueResult.error),
      businessCheck(
        "QUEUE_NOT_PAUSED",
        queueResult.ok && !queueMetrics.paused,
        "队列运行状态",
        "生成队列必须在线且未暂停。",
        "PLATFORM",
      ),
      businessCheck(
        "GENERATION_WORKERS",
        queueResult.ok && queueMetrics.workers >= policy.minimumGenerationWorkers,
        "生成 Worker",
        `至少需要 ${policy.minimumGenerationWorkers} 个在线 Worker。`,
        "PLATFORM",
      ),
      businessCheck(
        "QUEUE_CAPACITY",
        queueResult.ok &&
          backlog <= policy.maxQueueBacklog &&
          activeJobs <= policy.maxActiveGenerationJobs,
        "生成容量",
        `队列积压不得超过 ${policy.maxQueueBacklog}，活跃任务不得超过 ${policy.maxActiveGenerationJobs}。`,
        "PLATFORM",
      ),
    ];
    return { checks, queue: queueMetrics };
  }

  private async effectiveMaterialCount(
    scope: EnterpriseScope,
    includeShared: boolean,
    now: Date,
    medical = false,
  ) {
    const where = {
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        ...(medical
          ? [
              {
                structuredFacts: {
                  path: ["medicalMaterial", "schemaVersion"],
                  equals: "medical-material-v1",
                },
              },
            ]
          : []),
      ],
      OR: includeShared
        ? [{ enterpriseId: null }, { enterpriseId: scope.enterpriseId }]
        : [{ enterpriseId: scope.enterpriseId }],
      authorizationStatus: "AUTHORIZED",
      ingestionStatus: "READY",
      usabilityStatus: "USABLE",
      status: "ACTIVE",
      tenantId: scope.tenantId,
      ...(medical
        ? {
            type: { in: ["TEXT", "DOCUMENT", "LINK"] },
            structuredFacts: { path: ["medicalMaterial", "purpose"], equals: "ANSWER_EVIDENCE" },
          }
        : {}),
    } satisfies Prisma.MaterialWhereInput;
    const total = await this.prisma.material.count({ where });
    if (medical || total === 0) return total;
    const archived = await this.prisma.material.count({
      where: {
        AND: [
          where,
          { structuredFacts: { path: ["medicalMaterial", "purpose"], equals: "ARCHIVE" } },
        ],
      },
    });
    return Math.max(0, total - archived);
  }

  private requireEnterpriseScope(scope: EnterpriseScope) {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "ENTERPRISE" ||
      principal.scope.tenantId !== scope.tenantId ||
      principal.scope.enterpriseId !== scope.enterpriseId
    ) {
      throw new ForbiddenException("Active request scope does not match generation preflight");
    }
  }
}

function customerResponse(result: GenerationPreflightResult) {
  return {
    audience: {
      employeeCount: result.audienceCount,
      imageCountPerEmployee: result.imageCount,
      totalImageCount: result.audienceCount * result.imageCount,
    },
    capabilities: result.capabilities,
    checkedAt: result.checkedAt,
    checks: result.checks
      .filter(({ audience }) => audience === "CUSTOMER")
      .map(({ audience: _audience, ...check }) => check),
    estimatedWaitLevel: waitLevel(result.queue),
    ready: result.ready,
    serviceStatus: result.ready ? "AVAILABLE" : "UNAVAILABLE",
  };
}

function platformResponse(result: GenerationPreflightResult) {
  const customer = customerResponse(result);
  return {
    ...customer,
    checks: result.checks.map(({ audience: _audience, ...check }) => check),
    costCurrency: result.policy.costCurrency,
    deliveryMode: result.deliveryMode,
    estimatedCost: result.estimatedCost,
    queue: {
      ...result.queue,
      backlog: result.queue.waiting + result.queue.delayed,
    },
    route:
      result.assessment && result.frozenRoute
        ? {
            configurationFingerprint: result.assessment.configurationFingerprint,
            imageModelId: result.frozenRoute.image.primary.modelId,
            imageProviderId: result.frozenRoute.image.primary.providerId,
            qualificationExpiresAt: result.assessment.qualification?.expiresAt ?? null,
            qualificationId: result.assessment.qualification?.id ?? null,
            routeId: result.frozenRoute.routeId,
            scopeId: result.frozenRoute.scopeId,
            scopeType: result.frozenRoute.scopeType,
            synthetic: result.frozenRoute.synthetic,
            textModelId: result.frozenRoute.text.primary.modelId,
            textProviderId: result.frozenRoute.text.primary.providerId,
          }
        : null,
  };
}

function businessCheck(
  code: string,
  passed: boolean,
  title: string,
  description: string,
  audience: "CUSTOMER" | "PLATFORM" = "CUSTOMER",
): InternalCheck {
  return { audience, code, description, status: passed ? "PASSED" : "BLOCKING", title };
}

function infrastructureCheck(
  code: string,
  title: string,
  passed: boolean,
  error?: string,
): InternalCheck {
  return {
    audience: "PLATFORM",
    code,
    description: passed ? `${title}检查通过。` : (error ?? `${title}检查失败。`),
    status: passed ? "PASSED" : "BLOCKING",
    title,
  };
}

function passedPlatformCheck(code: string, title: string, description: string): InternalCheck {
  return { audience: "PLATFORM", code, description, status: "PASSED", title };
}

async function measured<T>(operation: () => Promise<T>) {
  try {
    return { ok: true as const, value: await operation() };
  } catch (error) {
    return { error: safeErrorMessage(error), ok: false as const, value: undefined };
  }
}

function normalizeIds(values: readonly string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function inlineGeneration(): boolean {
  return process.env.VITEST === "true" || process.env.GENERATION_EXECUTION_MODE === "inline";
}

function emptyQueueMetrics(): GenerationQueueMetrics {
  return { active: 0, completed: 0, delayed: 0, failed: 0, paused: false, waiting: 0, workers: 0 };
}

function waitLevel(queue: GenerationQueueMetrics): "DELAYED" | "IMMEDIATE" | "NORMAL" {
  const backlog = queue.waiting + queue.delayed;
  if (backlog === 0) return "IMMEDIATE";
  if (backlog < 100) return "NORMAL";
  return "DELAYED";
}

function estimatedCampaignCost(
  assessment: RouteQualificationAssessment,
  audienceCount: number,
  imageCount: number,
  promptLength: number,
): number {
  const textPricing = pricing(assessment.route.textModel.metadata);
  const imagePricing = pricing(assessment.route.imageModel.metadata);
  const estimatedInputUnits = 1_500 + promptLength + audienceCount * 1_200;
  const estimatedOutputUnits = 1_000 + audienceCount * 900;
  const textCost =
    (estimatedInputUnits * (textPricing.inputCostPerMillionUnits ?? 0) +
      estimatedOutputUnits * (textPricing.outputCostPerMillionUnits ?? 0)) /
    1_000_000;
  return textCost + audienceCount * imageCount * (imagePricing.imageCost ?? 0);
}

function pricing(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    imageCost: numeric(value.imageCost),
    inputCostPerMillionUnits: numeric(value.inputCostPerMillionUnits),
    outputCostPerMillionUnits: numeric(value.outputCostPerMillionUnits),
  };
}

function pricingComplete(assessment: RouteQualificationAssessment, requiresImage = true): boolean {
  const text = pricing(assessment.route.textModel.metadata);
  const image = pricing(assessment.route.imageModel.metadata);
  return (
    text.inputCostPerMillionUnits !== undefined &&
    text.outputCostPerMillionUnits !== undefined &&
    (!requiresImage || image.imageCost !== undefined)
  );
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown generation readiness error").slice(
    0,
    500,
  );
}
