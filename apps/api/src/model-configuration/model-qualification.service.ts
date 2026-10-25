import { createHash, randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  createRuntimeProviderWithApiKey,
  generationDeliveryMode,
  ProviderInvocationError,
  type RouteRuntimeHealth,
  summarizeRouteRuntimeHealth,
} from "@xhs-agentic/ai-gateway";
import { Prisma, type RuntimePolicy } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { ModelCredentialService } from "./model-credential.service";
import { routeNotificationStatus } from "./model-incident-notification";
import { ModelProviderHealthService } from "./model-provider-health.service";
import { ModelQualificationStorageService } from "./model-qualification-storage.service";
import { readRouteRuntimeHealth } from "./route-runtime-health";
import { RuntimePolicyService } from "./runtime-policy.service";

export const QUALIFICATION_ROUTE_INCLUDE = {
  imageModel: { include: { provider: { include: { activeCredential: true } } } },
  textModel: { include: { provider: { include: { activeCredential: true } } } },
} as const satisfies Prisma.ModelRouteInclude;

type QualificationRoute = Prisma.ModelRouteGetPayload<{
  include: typeof QUALIFICATION_ROUTE_INCLUDE;
}>;

type QualificationModel = Prisma.ModelDefinitionGetPayload<{
  include: { provider: { include: { activeCredential: true } } };
}>;

type QualificationClient =
  | Pick<PrismaService, "modelDefinition" | "modelRoute" | "modelRouteQualification" | "auditLog">
  | Prisma.TransactionClient;

export type RouteQualificationAssessment = Readonly<{
  configurationFingerprint: string;
  eligible: boolean;
  qualification: Readonly<{
    checkedAt: Date;
    estimatedCost: number;
    expiresAt: null;
    id: string;
  }> | null;
  reasons: readonly Readonly<{ code: string; message: string }>[];
  runtimeHealth: (RouteRuntimeHealth & { notificationStatus?: string | null }) | null;
  route: QualificationRoute;
}>;

@Injectable()
export class ModelQualificationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(ModelCredentialService) private readonly credentials: ModelCredentialService,
    @Inject(ModelQualificationStorageService)
    private readonly storage: ModelQualificationStorageService,
    @Inject(RuntimePolicyService) private readonly runtimePolicy: RuntimePolicyService,
    @Inject(ModelProviderHealthService) private readonly providerHealth: ModelProviderHealthService,
  ) {}

  async qualify(routeId: string, requiresImage = true) {
    const principal = this.requirePlatform();
    const [policy, context] = await Promise.all([
      this.runtimePolicy.current(),
      this.loadRouteContext(routeId, this.prisma, requiresImage),
    ]);
    const qualificationId = randomUUID();
    const checkedAt = new Date();
    const expiresAt = new Date(
      checkedAt.getTime() + policy.routeQualificationMaxAgeSeconds * 1_000,
    );
    const deliveryMode = generationDeliveryMode();
    const fingerprint = configurationFingerprint(context.route, context.models, requiresImage);
    let textLatencyMs: number | null = null;
    let imageLatencyMs: number | null = null;
    let estimatedCost = 0;
    let storageVerified = false;
    let diagnostics: Record<string, unknown> = {};
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    type Step = "CONFIGURATION" | "CONNECTION" | "TEXT" | "IMAGE" | "STORAGE";
    let currentStep: Step = "CONFIGURATION";
    const steps: Record<Step, "PASSED" | "FAILED" | "NOT_RUN"> = {
      CONFIGURATION: "NOT_RUN",
      CONNECTION: "NOT_RUN",
      TEXT: "NOT_RUN",
      IMAGE: "NOT_RUN",
      STORAGE: "NOT_RUN",
    };

    try {
      assertRealQualificationContext(context.route, context.models);
      steps.CONFIGURATION = "PASSED";
      currentStep = "CONNECTION";
      await Promise.all(
        uniqueProviders(context.models).map((provider) =>
          this.probeProvider(provider, principal.userId),
        ),
      );
      steps.CONNECTION = "PASSED";
      currentStep = "TEXT";
      const textRuntime = await this.runtimeProvider(context.route.textModel);
      const textStartedAt = Date.now();
      const text = await textRuntime.text.generate(context.route.textModel.externalModelId, {
        context: { generationRunId: `qualification-${qualificationId}`, tenantId: "platform" },
        maxOutputCharacters: 300,
        prompt: "这是 SaaS 平台真实模型资格检查。只回复：READY。",
        temperature: 0,
      });
      textLatencyMs = Date.now() - textStartedAt;
      estimatedCost += text.usage.estimatedCost;
      steps.TEXT = "PASSED";
      diagnostics.text = {
        finishReason: text.finishReason,
        providerRequestId: text.providerRequestId,
      };

      if (requiresImage) {
        currentStep = "IMAGE";
        const imageRuntime = await this.runtimeProvider(context.route.imageModel);
        const imageStartedAt = Date.now();
        const image = await imageRuntime.image.generate(context.route.imageModel.externalModelId, {
          context: { generationRunId: `qualification-${qualificationId}`, tenantId: "platform" },
          height: 1536,
          prompt:
            "A minimal professional editorial still life with soft red accents, no text, no logo, no watermark, vertical composition.",
          seed: qualificationId,
          width: 1024,
        });
        imageLatencyMs = Date.now() - imageStartedAt;
        estimatedCost += image.usage.estimatedCost;
        steps.IMAGE = "PASSED";
        currentStep = "STORAGE";
        const storage = await this.storage.verifyImageRoundTrip(
          qualificationId,
          image.bytes,
          image.mimeType,
        );
        storageVerified = true;
        steps.STORAGE = "PASSED";
        diagnostics = {
          image: {
            byteSize: storage.byteSize,
            checksum: storage.checksum,
            providerRequestId: image.providerRequestId,
          },
          text: {
            finishReason: text.finishReason,
            outputPreview: text.text.slice(0, 120),
            providerRequestId: text.providerRequestId,
          },
        };
      }
    } catch (error) {
      steps[currentStep] = "FAILED";
      errorCode = qualificationErrorCode(error);
      const labels: Record<Step, string> = {
        CONFIGURATION: "配置检查",
        CONNECTION: "连接检查",
        TEXT: "文案生成",
        IMAGE: "图片生成",
        STORAGE: "图片存储回读",
      };
      const unsupported =
        error instanceof ProviderInvocationError &&
        (error.code === "GW_REQUEST_NOT_SUPPORTED" ||
          error.details?.httpStatus === 404 ||
          error.details?.httpStatus === 405);
      const hint = unsupported
        ? "供应商拒绝当前调用接口或请求方式；模型列表可见不代表该接口已开放，也不能据此认定 API Key 错误。请核对供应商调用脚本。"
        : safeErrorMessage(error);
      errorMessage = `${labels[currentStep]}失败：${hint}`.slice(0, 500);
      diagnostics = {
        ...diagnostics,
        failureStep: currentStep,
        failureType: error instanceof Error ? error.name : "UnknownError",
        ...(error instanceof ProviderInvocationError && error.details
          ? { request: error.details }
          : {}),
      };
    }
    diagnostics.steps = steps;
    diagnostics.requiredCapabilities = requiresImage ? ["TEXT", "IMAGE"] : ["TEXT"];
    diagnostics.textConfigurationFingerprint = configurationFingerprint(
      context.route,
      context.models.filter(
        (model) =>
          model.id === context.route.textModelId ||
          context.route.textFallbackModelIds.includes(model.id),
      ),
      false,
    );

    const status = errorCode === null && (!requiresImage || storageVerified) ? "PASSED" : "FAILED";
    const qualification = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.modelRouteQualification.create({
        data: {
          checkedAt,
          checkedBy: principal.userId,
          configurationFingerprint: fingerprint,
          deliveryMode,
          diagnostics: diagnostics as Prisma.InputJsonValue,
          errorCode,
          errorMessage,
          estimatedCost: new Prisma.Decimal(estimatedCost),
          expiresAt,
          id: qualificationId,
          imageLatencyMs,
          imageModelId: context.route.imageModelId,
          imageProviderId: context.route.imageModel.providerId,
          routeId,
          status,
          storageVerified,
          textLatencyMs,
          textModelId: context.route.textModelId,
          textProviderId: context.route.textModel.providerId,
        },
      });
      if (status === "PASSED") {
        for (const provider of uniqueProviders(
          requiresImage
            ? [context.route.textModel, context.route.imageModel]
            : [context.route.textModel],
        )) {
          // Do not erase a failure or validate credentials changed while the test ran.
          await transaction.modelProvider.updateMany({
            where: {
              id: provider.id,
              activeCredentialId: provider.activeCredentialId,
              baseUrl: provider.baseUrl,
              protocol: provider.protocol,
              OR: [{ lastRuntimeFailureAt: null }, { lastRuntimeFailureAt: { lte: checkedAt } }],
            },
            data: {
              circuitState: "CLOSED",
              circuitOpenedAt: null,
              circuitOpenUntil: null,
              circuitProbeToken: null,
              circuitProbeExpiresAt: null,
              runtimeFailureCount: 0,
              lastRuntimeErrorCode: null,
            },
          });
        }
      }
      await transaction.auditLog.create({
        data: {
          action: "model-route.qualification",
          actorType: "USER",
          actorUserId: principal.userId,
          resourceId: routeId,
          resourceType: "ModelRoute",
          stateAfter: {
            configurationFingerprint: fingerprint,
            deliveryMode,
            errorCode,
            estimatedCost,
            qualificationId,
            status,
            storageVerified,
          },
          tenantId: context.route.tenantId,
        },
      });
      return created;
    });
    return qualificationResponse(qualification);
  }

  async assessRoute(
    routeId: string,
    policy: RuntimePolicy,
    now = new Date(),
    requiresImage = true,
  ): Promise<RouteQualificationAssessment> {
    let context = await this.loadRouteContext(routeId, this.prisma, requiresImage);
    await this.providerHealth.ensureFresh(
      context.models.map((model) => model.providerId),
      policy,
    );
    context = await this.loadRouteContext(routeId, this.prisma, requiresImage);
    const fingerprint = configurationFingerprint(context.route, context.models, requiresImage);
    const mode = generationDeliveryMode();
    const reasons = routeEligibilityReasons(
      context.route,
      context.models,
      policy,
      now,
      mode,
      requiresImage,
    );
    if (mode === "DEVELOPMENT" && context.models.every((model) => model.synthetic)) {
      return {
        configurationFingerprint: fingerprint,
        eligible: reasons.length === 0,
        qualification: null,
        runtimeHealth: null,
        reasons,
        route: context.route,
      };
    }
    const qualification = await this.currentQualification(
      context,
      mode,
      requiresImage,
      this.prisma,
    );
    const passed = qualification && qualificationPassed(qualification, fingerprint, requiresImage);
    if (!passed) {
      reasons.push({
        code: "ROUTE_QUALIFICATION_REQUIRED",
        message: "当前配置尚未通过功能验证，或最近一次复验未通过；请执行功能验证",
      });
    }
    const runtimeHealth = passed
      ? await readRouteRuntimeHealth(this.prisma, {
          routeId,
          configurationFingerprint: fingerprint,
          deliveryMode: mode,
          qualifiedAt: qualification.checkedAt,
          ...(requiresImage
            ? {}
            : {
                requiredCapabilities: ["TEXT"] as const,
                configurationFingerprints: [fingerprint, qualification.configurationFingerprint],
              }),
        })
      : null;
    if (runtimeHealth?.state === "REVALIDATION_REQUIRED") {
      reasons.push({
        code: "ROUTE_RUNTIME_REVALIDATION_REQUIRED",
        message: `当前路由连续 ${runtimeHealth.failureThreshold} 个任务在多轮重试后仍因模型调用失败，请复验后再创建生成任务`,
      });
    }
    return {
      configurationFingerprint: fingerprint,
      eligible: reasons.length === 0,
      qualification: passed
        ? {
            checkedAt: qualification.checkedAt,
            estimatedCost: Number(qualification.estimatedCost),
            expiresAt: null,
            id: qualification.id,
          }
        : null,
      reasons,
      runtimeHealth: runtimeHealth
        ? {
            ...runtimeHealth,
            notificationStatus:
              runtimeHealth.state === "REVALIDATION_REQUIRED"
                ? ((await routeNotificationStatus(
                    this.prisma,
                    routeId,
                    fingerprint,
                    qualification?.id,
                  )) ?? "PENDING")
                : null,
          }
        : null,
      route: context.route,
    };
  }

  async assertCurrent(
    input: Readonly<{
      configurationFingerprint: string;
      deliveryMode: "DEVELOPMENT" | "PRODUCTION";
      qualificationId: string | null;
      routeId: string;
      requiresImage?: boolean;
    }>,
    policy: RuntimePolicy,
    client: QualificationClient = this.prisma,
    now = new Date(),
  ): Promise<void> {
    const requiresImage = input.requiresImage !== false;
    const context = await this.loadRouteContext(input.routeId, client, requiresImage);
    const fingerprint = configurationFingerprint(context.route, context.models, requiresImage);
    if (fingerprint !== input.configurationFingerprint) {
      throw new ConflictException({
        code: "GENERATION_PREFLIGHT_STALE",
        message: "Model route configuration changed after generation preflight",
      });
    }
    const reasons = routeEligibilityReasons(
      context.route,
      context.models,
      policy,
      now,
      input.deliveryMode,
      requiresImage,
    );
    if (reasons.length > 0) {
      throw new ConflictException({
        code: "GENERATION_PREFLIGHT_STALE",
        details: reasons,
        message: "Model route is no longer eligible for generation",
      });
    }
    const synthetic = context.models.every((model) => model.synthetic && model.provider.synthetic);
    if (input.deliveryMode === "DEVELOPMENT" && synthetic) {
      if (input.qualificationId !== null) {
        throw new ConflictException({
          code: "GENERATION_PREFLIGHT_STALE",
          message: "Synthetic development routes cannot reference real qualification runs",
        });
      }
      return;
    }
    if (!input.qualificationId) {
      throw new ConflictException({
        code: "GENERATION_PREFLIGHT_STALE",
        message: "Qualified real model route is required",
      });
    }
    const qualification = await this.currentQualification(
      context,
      input.deliveryMode,
      requiresImage,
      client,
    );
    if (
      !qualification ||
      qualification.id !== input.qualificationId ||
      !qualificationPassed(qualification, fingerprint, requiresImage)
    ) {
      throw new ConflictException({
        code: "GENERATION_PREFLIGHT_STALE",
        message: "Model route qualification changed or failed after generation preflight",
      });
    }
    const health = await readRouteRuntimeHealth(client, {
      routeId: input.routeId,
      configurationFingerprint: fingerprint,
      deliveryMode: input.deliveryMode,
      qualifiedAt: qualification.checkedAt,
      ...(requiresImage
        ? {}
        : {
            requiredCapabilities: ["TEXT"] as const,
            configurationFingerprints: [fingerprint, qualification.configurationFingerprint],
          }),
    });
    if (health.state === "REVALIDATION_REQUIRED") {
      throw new ConflictException({
        code: "GENERATION_PREFLIGHT_STALE",
        message: "模型连续失败且重试未恢复，当前路由需要功能复验",
      });
    }
  }

  async runtimeHealthForRoutes(routeIds: readonly string[]) {
    const result = new Map<
      string,
      Omit<RouteRuntimeHealth, "state"> & {
        state: RouteRuntimeHealth["state"] | "QUALIFICATION_REQUIRED";
        notificationStatus: string | null;
      }
    >();
    for (const routeId of routeIds) {
      let context: Awaited<ReturnType<ModelQualificationService["loadRouteContext"]>>;
      try {
        context = await this.loadRouteContext(routeId);
      } catch (error) {
        if (!(error instanceof ConflictException || error instanceof NotFoundException))
          throw error;
        result.set(routeId, {
          ...summarizeRouteRuntimeHealth([], []),
          state: "QUALIFICATION_REQUIRED",
          notificationStatus: null,
        });
        continue;
      }
      const fingerprint = configurationFingerprint(context.route, context.models);
      const mode = generationDeliveryMode();
      const qualification = await this.prisma.modelRouteQualification.findFirst({
        where: { routeId, configurationFingerprint: fingerprint, deliveryMode: mode },
        orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
      });
      const health =
        qualification?.status === "PASSED" && qualification.storageVerified
          ? await readRouteRuntimeHealth(this.prisma, {
              routeId,
              configurationFingerprint: fingerprint,
              deliveryMode: mode,
              qualifiedAt: qualification.checkedAt,
            })
          : { ...summarizeRouteRuntimeHealth([], []), state: "QUALIFICATION_REQUIRED" as const };
      const notificationStatus = qualification
        ? await routeNotificationStatus(
            this.prisma,
            routeId,
            fingerprint,
            qualification.status === "PASSED" ? qualification.id : undefined,
          )
        : null;
      result.set(routeId, {
        ...health,
        notificationStatus:
          health.state === "REVALIDATION_REQUIRED"
            ? (notificationStatus ?? "PENDING")
            : health.state === "QUALIFICATION_REQUIRED"
              ? notificationStatus
              : null,
      });
    }
    return result;
  }

  async latestForRoutes(routeIds: readonly string[]) {
    if (routeIds.length === 0) return new Map<string, ReturnType<typeof qualificationResponse>>();
    const rows = await this.prisma.modelRouteQualification.findMany({
      orderBy: { checkedAt: "desc" },
      where: { routeId: { in: [...routeIds] } },
    });
    const result = new Map<string, ReturnType<typeof qualificationResponse>>();
    for (const row of rows) {
      if (!result.has(row.routeId)) result.set(row.routeId, qualificationResponse(row));
    }
    return result;
  }

  private async loadRouteContext(
    routeId: string,
    client: QualificationClient = this.prisma,
    requiresImage = true,
  ) {
    const route = await client.modelRoute.findUnique({
      include: QUALIFICATION_ROUTE_INCLUDE,
      where: { id: routeId },
    });
    if (!route) throw new NotFoundException("Model route was not found");
    const fallbackIds = [
      ...route.textFallbackModelIds,
      ...(requiresImage ? route.imageFallbackModelIds : []),
    ];
    const fallbacks = await client.modelDefinition.findMany({
      include: { provider: { include: { activeCredential: true } } },
      where: { id: { in: fallbackIds } },
    });
    if (fallbacks.length !== new Set(fallbackIds).size) {
      throw new ConflictException("Model route contains a missing fallback model");
    }
    return {
      models: uniqueModels([
        route.textModel,
        ...(requiresImage ? [route.imageModel] : []),
        ...fallbacks,
      ]),
      route,
    };
  }

  private async currentQualification(
    context: { route: QualificationRoute; models: QualificationModel[] },
    mode: "DEVELOPMENT" | "PRODUCTION",
    requiresImage: boolean,
    client: QualificationClient,
  ) {
    const fingerprint = configurationFingerprint(context.route, context.models, requiresImage);
    if (requiresImage)
      return client.modelRouteQualification.findFirst({
        orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
        where: {
          routeId: context.route.id,
          deliveryMode: mode,
          configurationFingerprint: fingerprint,
        },
      });
    const fallbackIds = [
      ...new Set([...context.route.textFallbackModelIds, ...context.route.imageFallbackModelIds]),
    ];
    const fallbacks = await client.modelDefinition.findMany({
      include: { provider: { include: { activeCredential: true } } },
      where: { id: { in: fallbackIds } },
    });
    const requiredIds = new Set(context.models.map(({ id }) => id));
    // Legacy passes required ACTIVE resources; normalize only unused IMAGE availability.
    // shortcut: old receipts cannot prove unchanged TEXT after other IMAGE edits; requalify TEXT once.
    const legacyFingerprint =
      fallbacks.length === fallbackIds.length
        ? configurationFingerprint(
            context.route,
            uniqueModels([context.route.textModel, context.route.imageModel, ...fallbacks]).map(
              (model) =>
                requiredIds.has(model.id)
                  ? model
                  : {
                      ...model,
                      status: "ACTIVE" as const,
                      provider: { ...model.provider, status: "ACTIVE" as const },
                    },
            ),
          )
        : undefined;
    return client.modelRouteQualification.findFirst({
      orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
      where: {
        routeId: context.route.id,
        deliveryMode: mode,
        OR: [
          { configurationFingerprint: fingerprint },
          {
            AND: [
              { diagnostics: { path: ["textConfigurationFingerprint"], equals: fingerprint } },
              {
                OR: [
                  { diagnostics: { path: ["steps", "TEXT"], equals: "PASSED" } },
                  { diagnostics: { path: ["steps", "TEXT"], equals: "FAILED" } },
                ],
              },
            ],
          },
          ...(legacyFingerprint
            ? [
                {
                  AND: [
                    { configurationFingerprint: legacyFingerprint },
                    {
                      OR: [
                        { diagnostics: { equals: Prisma.DbNull } },
                        {
                          diagnostics: {
                            path: ["textConfigurationFingerprint"],
                            equals: Prisma.AnyNull,
                          },
                        },
                      ],
                    },
                  ],
                },
              ]
            : []),
        ],
      },
    });
  }

  private async runtimeProvider(model: QualificationModel) {
    const credential = model.provider.activeCredential;
    if (credential?.status !== "ACTIVE") {
      throw new ConflictException("Model provider has no active platform credential");
    }
    return createRuntimeProviderWithApiKey(
      {
        baseUrl: model.provider.baseUrl,
        id: model.provider.id,
        modelPricing: {
          [model.externalModelId]: modelPricing(model.metadata),
        },
        protocol: model.provider.protocol,
        synthetic: model.provider.synthetic,
        timeoutMs: model.provider.timeoutMs,
      },
      this.credentials.decrypt(credential),
    );
  }

  private async probeProvider(provider: QualificationModel["provider"], checkedBy: string) {
    const result = await this.providerHealth.testConnection(provider.id, checkedBy);
    if (!result.healthy) {
      throw new ProviderInvocationError(
        result.errorMessage ?? "Provider connection failed",
        result.errorCode ?? "NETWORK_ERROR",
        true,
      );
    }
  }

  private requirePlatform() {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") {
      throw new ForbiddenException("Model qualification requires platform scope");
    }
    return principal;
  }
}

function routeEligibilityReasons(
  route: QualificationRoute,
  models: readonly QualificationModel[],
  _policy: RuntimePolicy,
  now: Date,
  mode: "DEVELOPMENT" | "PRODUCTION",
  requiresImage = true,
): Array<{ code: string; message: string }> {
  const reasons: Array<{ code: string; message: string }> = [];
  const syntheticKinds = new Set(
    models.map((model) => model.synthetic || model.provider.synthetic),
  );
  if (syntheticKinds.size > 1) {
    reasons.push({
      code: "ROUTE_MIXES_SYNTHETIC_AND_REAL",
      message: "The resolved model route mixes synthetic and real resources",
    });
  }
  if (mode === "PRODUCTION" && syntheticKinds.has(true)) {
    reasons.push({
      code: "SYNTHETIC_ROUTE_FORBIDDEN",
      message: "Synthetic model routes cannot deliver production customer campaigns",
    });
  }
  for (const model of models) {
    if (model.status !== "ACTIVE" || model.provider.status !== "ACTIVE") {
      reasons.push({
        code: "MODEL_RESOURCE_DISABLED",
        message: "A routed model resource is disabled",
      });
    }
    if (!model.synthetic && model.provider.activeCredential?.status !== "ACTIVE") {
      reasons.push({
        code: "PROVIDER_CREDENTIAL_MISSING",
        message: "A routed provider has no active credential",
      });
    }
    if (!model.synthetic) {
      const cooling =
        model.provider.circuitState === "OPEN"
          ? model.provider.circuitOpenUntil && model.provider.circuitOpenUntil > now
          : model.provider.circuitState === "HALF_OPEN"
            ? model.provider.circuitProbeExpiresAt && model.provider.circuitProbeExpiresAt > now
            : false;
      if (cooling) {
        reasons.push({
          code: "PROVIDER_CIRCUIT_OPEN",
          message: "A routed provider circuit is not closed",
        });
      }
    }
  }
  if (!supports(route.textModel.capabilities, "TEXT")) {
    reasons.push({
      code: "TEXT_CAPABILITY_MISSING",
      message: "The primary text model lacks TEXT capability",
    });
  }
  if (requiresImage && !supports(route.imageModel.capabilities, "IMAGE")) {
    reasons.push({
      code: "IMAGE_CAPABILITY_MISSING",
      message: "The primary image model lacks IMAGE capability",
    });
  }
  return deduplicateReasons(reasons);
}

function assertRealQualificationContext(
  _route: QualificationRoute,
  models: readonly QualificationModel[],
): void {
  if (models.some((model) => model.synthetic || model.provider.synthetic)) {
    throw new ConflictException("Synthetic routes do not use real model qualification runs");
  }
  if (models.some((model) => model.status !== "ACTIVE" || model.provider.status !== "ACTIVE")) {
    throw new ConflictException("All routed model resources must be active before qualification");
  }
}

export function configurationFingerprint(
  route: QualificationRoute,
  models: readonly QualificationModel[],
  requiresImage = true,
): string {
  const modelConfigurations = [...models]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((model) => ({
      activeCredentialId: model.provider.activeCredentialId,
      capabilities: [...model.capabilities].sort(),
      externalModelId: model.externalModelId,
      id: model.id,
      metadata: model.metadata,
      modelStatus: model.status,
      providerBaseUrl: model.provider.baseUrl,
      providerId: model.provider.id,
      providerProtocol: model.provider.protocol,
      providerStatus: model.provider.status,
      providerSynthetic: model.provider.synthetic,
      providerTimeoutMs: model.provider.timeoutMs,
      synthetic: model.synthetic,
      tier: model.tier,
    }));
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...(requiresImage
          ? { imageFallbackModelIds: route.imageFallbackModelIds, imageModelId: route.imageModelId }
          : { requiredCapabilities: ["TEXT"] }),
        maxAttemptsPerModel: route.maxAttemptsPerModel,
        models: modelConfigurations,
        routeId: route.id,
        scopeId: route.scopeId,
        scopeType: route.scopeType,
        textFallbackModelIds: route.textFallbackModelIds,
        textModelId: route.textModelId,
      }),
    )
    .digest("hex");
}

function qualificationResponse(qualification: {
  checkedAt: Date;
  checkedBy: string;
  configurationFingerprint: string;
  deliveryMode: string;
  diagnostics: Prisma.JsonValue | null;
  errorCode: string | null;
  errorMessage: string | null;
  estimatedCost: Prisma.Decimal;
  expiresAt: Date;
  id: string;
  imageLatencyMs: number | null;
  imageModelId: string;
  imageProviderId: string;
  routeId: string;
  status: string;
  storageVerified: boolean;
  textLatencyMs: number | null;
  textModelId: string;
  textProviderId: string;
}) {
  return {
    ...qualification,
    // Kept for wire compatibility; qualification is invalidated by configuration
    // changes and exhausted runtime failures, never by the clock.
    expiresAt: null,
    estimatedCost: Number(qualification.estimatedCost),
  };
}

function qualificationPassed(
  qualification: {
    status: string;
    storageVerified: boolean;
    configurationFingerprint: string;
    diagnostics: Prisma.JsonValue | null;
  },
  fingerprint: string,
  requiresImage: boolean,
) {
  if (requiresImage) return qualification.status === "PASSED" && qualification.storageVerified;
  const diagnostics = qualification.diagnostics;
  if (
    diagnostics &&
    typeof diagnostics === "object" &&
    !Array.isArray(diagnostics) &&
    diagnostics.textConfigurationFingerprint === fingerprint
  ) {
    const steps = diagnostics.steps;
    return Boolean(
      steps && typeof steps === "object" && !Array.isArray(steps) && steps.TEXT === "PASSED",
    );
  }
  return (
    qualification.status === "PASSED" &&
    qualification.storageVerified &&
    qualification.configurationFingerprint !== fingerprint
  );
}

function uniqueModels(models: readonly QualificationModel[]): QualificationModel[] {
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

function uniqueProviders(models: readonly QualificationModel[]) {
  return [...new Map(models.map((model) => [model.provider.id, model.provider])).values()];
}

function supports(capabilities: readonly string[], capability: "IMAGE" | "TEXT"): boolean {
  return capabilities.includes(capability) || capabilities.includes("MULTIMODAL");
}

function modelPricing(value: Prisma.JsonValue | null): {
  imageCost?: number;
  inputCostPerMillionUnits?: number;
  outputCostPerMillionUnits?: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    ["imageCost", "inputCostPerMillionUnits", "outputCostPerMillionUnits"].flatMap((key) => {
      const candidate = value[key];
      return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
        ? [[key, candidate]]
        : [];
    }),
  );
}

function qualificationErrorCode(error: unknown): string {
  if (error instanceof ProviderInvocationError) return error.code.slice(0, 120);
  if (error instanceof ConflictException) return "QUALIFICATION_CONFIGURATION_INVALID";
  return "QUALIFICATION_FAILED";
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown qualification failure").slice(0, 500);
}

function deduplicateReasons(reasons: Array<{ code: string; message: string }>) {
  return [...new Map(reasons.map((reason) => [reason.code, reason])).values()];
}
