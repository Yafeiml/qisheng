import { Inject, Injectable } from "@nestjs/common";
import {
  generationDeliveryMode,
  ModelCredentialCipher,
  modelCredentialAssociatedData,
} from "@xhs-agentic/ai-gateway";
import type { ObjectStorageLifecycleState } from "@xhs-agentic/object-storage";
import { GenerationQueueService } from "../campaign/generation-queue.service";
import { MaterialIngestionQueueService } from "../content/material-ingestion-queue.service";
import { PrismaService } from "../database/prisma.service";
import { HealthService } from "../health/health.service";
import { ModelProviderHealthService } from "../model-configuration/model-provider-health.service";
import { ModelQualificationService } from "../model-configuration/model-qualification.service";
import { RuntimePolicyService } from "../model-configuration/runtime-policy.service";
import { normalizeCapEndpoint } from "../platform-settings/cap-endpoint";
import {
  materialNotificationKeys,
  validateMaterialNotificationConfiguration,
} from "../platform-settings/material-notification.configuration";
import { PlatformContentSafetyService } from "../platform-settings/platform-content-safety.service";
import { PlatformObjectStorageService } from "../platform-settings/platform-object-storage.service";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import {
  hasMinimumByteDiversity,
  isProductionCredential,
  isProductionRandomSecret,
} from "../platform-settings/production-secret";
import { isProductionHttpsEndpoint } from "../platform-settings/publication-policy-evidence";
import { isPublicationMetricsSecretAllowed } from "../publication/publication-metrics-security";

export type ReadinessStage = Readonly<{
  code: "CONFIGURATION" | "CONNECTION" | "VALIDATION" | "PRODUCTION";
  title: string;
  status: "READY" | "BLOCKED" | "UNKNOWN" | "SKIPPED" | "WARNING";
  message: string;
  action: string;
  href: string;
}>;

export type ProductionReadinessCheck = Readonly<{
  action: string;
  category: "ADAPTER" | "INFRASTRUCTURE" | "MODEL" | "RUNTIME" | "SECURITY";
  code: string;
  evidence: Readonly<Record<string, boolean | number | string | null>>;
  href: string;
  message: string;
  status: "BLOCKED" | "READY" | "WARNING";
  title: string;
  stages?: readonly ReadinessStage[];
}>;

export type ProductionReadinessAudit = Readonly<{
  checks: readonly ProductionReadinessCheck[];
  deliveryMode: "DEVELOPMENT" | "PRODUCTION";
  generatedAt: string;
  schemaVersion: 1;
  state: "BLOCKED" | "READY";
  summary: Readonly<{ blocked: number; ready: number; total: number; warning: number }>;
}>;

type Captured<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; httpStatus?: number }>;

const SETTING_KEYS = [
  "security.cap_enabled",
  "security.cap_endpoint",
  "security.cap_secret",
  "storage.versioning_required",
  "storage.provider",
  "content_safety.api_key",
  "content_safety.endpoint",
  "content_safety.mode",
  "content_safety.provider",
  "publication.metrics_ingest_key",
  ...materialNotificationKeys,
  "storage.abort_incomplete_upload_days",
  "storage.access_key_id",
  "storage.bucket",
  "storage.delivery_base_url",
  "storage.delivery_mode",
  "storage.delivery_signing_key",
  "storage.endpoint",
  "storage.noncurrent_version_expiration_days",
  "storage.region",
  "storage.secret_access_key",
] as const;

@Injectable()
export class ProductionReadinessService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(HealthService) private readonly health: HealthService,
    @Inject(GenerationQueueService) private readonly generationQueue: GenerationQueueService,
    @Inject(MaterialIngestionQueueService)
    private readonly materialIngestionQueue: MaterialIngestionQueueService,
    @Inject(ModelQualificationService)
    private readonly modelQualifications: ModelQualificationService,
    @Inject(RuntimePolicyService) private readonly runtimePolicy: RuntimePolicyService,
    @Inject(PlatformObjectStorageService)
    private readonly objectStorage: PlatformObjectStorageService,
    @Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader,
    @Inject(ModelProviderHealthService) private readonly providerHealth: ModelProviderHealthService,
    @Inject(PlatformContentSafetyService)
    private readonly contentSafetyService: PlatformContentSafetyService,
  ) {}

  async audit(): Promise<ProductionReadinessAudit> {
    const generatedAt = new Date();
    const deliveryMode = generationDeliveryMode();
    const settingsRequest = capture(() => this.settings.resolveMany(SETTING_KEYS));
    const [health, policy, queue, materialQueue, settings, routes, storageState, contentSafety] =
      await Promise.all([
        capture(() => this.health.checkDependencies()),
        capture(() => this.runtimePolicy.current()),
        capture(() => this.generationQueue.getOperationalMetrics()),
        capture(() => this.materialIngestionQueue.getOperationalMetrics()),
        settingsRequest,
        capture(() => this.routeReadiness(generatedAt)),
        settingsRequest.then(async (resolved): Promise<Captured<ObjectStorageLifecycleState>> => {
          if (
            resolved.ok &&
            (settingString(resolved.value, "storage.provider") === "LOCAL" ||
              settingBoolean(resolved.value, "storage.versioning_required") === false)
          )
            return { ok: false };
          return capture(async () => {
            const { storage } = await this.objectStorage.current();
            if (!("lifecycleState" in storage)) throw new Error("Cloud lifecycle is unavailable");
            return storage.lifecycleState();
          });
        }),
        this.contentSafetyService.readiness(),
      ]);
    const checks: ProductionReadinessCheck[] = [];
    const resolved = settings.ok ? settings.value : null;

    const runtimeIssues: string[] = [];
    if (process.env.NODE_ENV !== "production") runtimeIssues.push("运行环境尚未设为 production");
    if (deliveryMode !== "PRODUCTION") runtimeIssues.push("内容交付仍为开发模式");
    if (process.env.ENABLE_DEV_AUTH === "true") runtimeIssues.push("开发认证尚未关闭");
    if (process.env.GENERATION_EXECUTION_MODE !== "queue")
      runtimeIssues.push("生成执行方式尚未设为任务队列");
    if (process.env.MVP_GENERATION_ADAPTER === "synthetic") runtimeIssues.push("仍启用了模拟生成");
    if (settingBoolean(resolved, "notification.enabled") === true) {
      try {
        validateMaterialNotificationConfiguration(resolved ?? new Map());
      } catch {
        runtimeIssues.push("任务通知配置尚未完整，请检查所选渠道的短信或微信配置");
      }
    }
    const runtimeReady = runtimeIssues.length === 0;
    checks.push(
      check({
        action: "按提示修正运行配置；Worker 是否在线由“队列与 Worker 容量”单独检查。",
        category: "RUNTIME",
        code: "RUNTIME_PRODUCTION_MODE",
        evidence: {
          deliveryMode,
          developmentAuthentication: process.env.ENABLE_DEV_AUTH === "true",
          generationAdapter: process.env.MVP_GENERATION_ADAPTER ?? "unset",
          generationExecutionMode: process.env.GENERATION_EXECUTION_MODE ?? "unset",
          notificationEnabled: settingBoolean(resolved, "notification.enabled"),
          nodeEnvironment: process.env.NODE_ENV ?? "unset",
        },
        href: "/platform/settings/generation",
        message: runtimeReady
          ? "API 已启用生产环境、正式内容交付及队列执行，开发认证与模拟生成已关闭。"
          : `生产运行配置未通过：${runtimeIssues.join("；")}。`,
        ready: runtimeReady,
        title: "生产运行模式",
      }),
    );

    const secrets = applicationSecretReadiness();
    checks.push(
      check({
        action: "为 JWT、OTP 和平台凭据配置独立随机密钥，移除所有开发占位值。",
        category: "SECURITY",
        code: "SECURITY_APPLICATION_SECRETS",
        evidence: { configuredSecrets: secrets.configured, requiredSecrets: secrets.required },
        href: "/platform/settings/security",
        message: secrets.ready
          ? "JWT、OTP 和平台凭据加密密钥均满足生产强度要求。"
          : `缺少或仍为开发占位值的密钥：${secrets.invalid.join("、")}`,
        ready: secrets.ready,
        title: "应用密钥基线",
      }),
    );

    const network = productionNetworkReadiness();
    checks.push(
      check({
        action: "公网管理端使用 HTTPS；本机回环地址可使用 HTTP。",
        category: "SECURITY",
        code: "SECURITY_NETWORK_ENDPOINTS",
        evidence: {
          configuredOrigins: network.originCount,
        },
        href: "/platform/settings/security",
        message: network.ready
          ? "管理端 CORS 使用公开 HTTPS 或本机回环 HTTP。"
          : `生产网络配置存在问题：${network.invalid.join("、")}`,
        ready: network.ready,
        title: "网络安全",
      }),
    );

    for (const dependency of ["database", "redis", "generationQueue", "objectStorage"] as const) {
      const result = health.ok ? health.value.checks[dependency] : null;
      checks.push(
        check({
          action: "检查对应服务连接、凭据、网络和容器/云资源状态。",
          category: "INFRASTRUCTURE",
          code: `INFRASTRUCTURE_${dependency.replace(/([A-Z])/gu, "_$1").toUpperCase()}`,
          evidence: { latencyMs: result?.latencyMs ?? null },
          href: "/platform/operations",
          message:
            result?.status === "ok"
              ? `${dependencyLabel(dependency)}实时探针通过。`
              : `${dependencyLabel(dependency)}实时探针失败或未能执行。`,
          ready: result?.status === "ok",
          title: dependencyLabel(dependency),
        }),
      );
    }

    const backlog = queue.ok ? queue.value.waiting + queue.value.delayed : null;
    const materialBacklog = materialQueue.ok
      ? materialQueue.value.waiting + materialQueue.value.delayed
      : null;
    const workerIssues: string[] = [];
    if (!policy.ok) workerIssues.push("运行策略无法读取");
    if (!queue.ok) workerIssues.push("生成队列状态无法读取");
    else {
      if (queue.value.paused) workerIssues.push("生成队列已暂停");
      if (policy.ok && queue.value.workers < policy.value.minimumGenerationWorkers)
        workerIssues.push(
          `生成队列在线消费者不足：最少 ${queue.value.workers}，每个队列要求至少 ${policy.value.minimumGenerationWorkers}`,
        );
      if (policy.ok && backlog !== null && backlog > policy.value.maxQueueBacklog)
        workerIssues.push(
          `生成队列积压 ${backlog}，超过运行策略上限 ${policy.value.maxQueueBacklog}`,
        );
    }
    if (!materialQueue.ok) workerIssues.push("素材入库队列状态无法读取");
    else {
      if (materialQueue.value.paused) workerIssues.push("素材入库队列已暂停");
      if (materialQueue.value.workers < 1) workerIssues.push("素材入库队列没有在线消费者");
      if (policy.ok && materialBacklog !== null && materialBacklog > policy.value.maxQueueBacklog)
        workerIssues.push(
          `素材入库队列积压 ${materialBacklog}，超过运行策略上限 ${policy.value.maxQueueBacklog}`,
        );
    }
    const generationWorkersMissing =
      queue.ok && queue.value.workers < (policy.ok ? policy.value.minimumGenerationWorkers : 1);
    const materialWorkersMissing = materialQueue.ok && materialQueue.value.workers < 1;
    const storageReady = health.ok && health.value.checks.objectStorage.status === "ok";
    if ((generationWorkersMissing || materialWorkersMissing) && !storageReady)
      workerIssues.push(
        "存储尚未就绪或无法确认，相关消费者会等待存储配置，请先完成存储设置并检查 Worker 日志",
      );
    if (generationWorkersMissing && (!contentSafety.configured || !contentSafety.verified))
      workerIssues.push("内容审核未配置或未验证，生成消费者会等待审核配置，请先保存并测试内容审核");
    const operational = workerIssues.length === 0;
    checks.push(
      check({
        action:
          "默认同一台主机用 Compose 同时启动 API、Web 和 Worker，一个 Worker 容器即可处理多个队列，无需独立服务器。先完成存储和模型审核配置，检查 worker 日志与队列暂停状态；只有积压超限时才按需扩容或限流。",
        category: "INFRASTRUCTURE",
        code: "INFRASTRUCTURE_WORKER_CAPACITY",
        evidence: {
          backlog,
          materialBacklog,
          materialPaused: materialQueue.ok ? materialQueue.value.paused : null,
          materialWorkers: materialQueue.ok ? materialQueue.value.workers : null,
          minimumWorkers: policy.ok ? policy.value.minimumGenerationWorkers : null,
          paused: queue.ok ? queue.value.paused : null,
          workers: queue.ok ? queue.value.workers : null,
          storageReady,
          contentSafetyConfigured: contentSafety.configured,
          contentSafetyVerified: contentSafety.verified,
        },
        href: "/platform/operations",
        message: operational
          ? "生成与素材入库队列均在运行，Worker 数量和当前积压符合运行策略。"
          : `${workerIssues.join("；")}。`,
        ready: operational,
        title: "队列与 Worker 容量",
      }),
    );

    const routeReady =
      routes.ok &&
      routes.value.total > 0 &&
      routes.value.blocked === 0 &&
      routes.value.embeddingReady;
    checks.push(
      check({
        action: "移除 synthetic 路由，完成真实 Provider 健康检查和所有生效路由的资格验证。",
        stages: routes.ok
          ? routes.value.stages
          : (["CONFIGURATION", "CONNECTION", "VALIDATION", "PRODUCTION"] as const).map((code) =>
              stage(
                code,
                "UNKNOWN",
                "模型配置或验证记录读取失败，尚无法确认此阶段。",
                "检查平台运行策略和数据库连接后刷新。",
                "/platform/models",
              ),
            ),
        category: "MODEL",
        code: "MODEL_ROUTE_QUALIFICATION",
        evidence: routes.ok
          ? {
              blockedRoutes: routes.value.blocked,
              credentialFailures: routes.value.credentialFailures,
              embeddingConfigured: routes.value.embeddingConfigured,
              embeddingReady: routes.value.embeddingReady,
              qualifiedRoutes: routes.value.qualified,
              syntheticRoutes: routes.value.synthetic,
              totalRoutes: routes.value.total,
            }
          : {
              blockedRoutes: null,
              credentialFailures: null,
              embeddingConfigured: null,
              embeddingReady: null,
              qualifiedRoutes: null,
              syntheticRoutes: null,
              totalRoutes: null,
            },
        href: "/platform/models",
        message: routeReady
          ? "所有生效生成路由与已配置的外部 Embedding 模型均可用；未配置外部 Embedding 时使用本地字符特征基础检索。"
          : routes.ok
            ? `${routes.value.blocked} 条路由被阻断，其中 ${routes.value.synthetic} 条包含 synthetic 模型；Embedding 就绪：${routes.value.embeddingReady ? "是" : "否"}。`
            : "模型路由资格无法完成审计。",
        ready: routeReady,
        title: "真实模型与路由资格",
      }),
    );

    checks.push(
      check({
        action: "选择多模态审核模型或独立审核服务，保存后通过图文审核测试。",
        category: "ADAPTER",
        code: "ADAPTER_CONTENT_SAFETY",
        evidence: {
          mode: contentSafety.mode,
          configured: contentSafety.configured,
          verified: contentSafety.verified,
        },
        href: "/platform/settings/content-safety",
        message:
          contentSafety.configured && contentSafety.verified
            ? "当前内容审核配置已通过图文测试；配置未变更时无需定期重测。"
            : "内容审核尚未配置或当前配置未通过图文测试，请在内容安全设置中保存并测试。",
        ready: contentSafety.configured && contentSafety.verified,
        title: "多模态内容安全",
      }),
    );

    const capEnabled = settingBoolean(resolved, "security.cap_enabled") === true;
    let capReady = !capEnabled;
    if (capEnabled) {
      try {
        normalizeCapEndpoint(settingString(resolved, "security.cap_endpoint") ?? "");
        capReady = Boolean(settingString(resolved, "security.cap_secret"));
      } catch {
        capReady = false;
      }
    }
    checks.push(
      check({
        action: "Cap 为可选验证；开启后需配置 Cap 验证服务 Endpoint 和 Secret Key。",
        category: "ADAPTER",
        code: "ADAPTER_CAP",
        evidence: { enabled: capEnabled, configured: capReady },
        href: "/platform/settings/security",
        message: capEnabled
          ? capReady
            ? "已启用 Cap，Endpoint 和 Secret Key 配置完整。"
            : "已启用 Cap，但 Endpoint 或 Secret Key 未正确配置。"
          : "未启用 Cap，账号密码登录和注册不要求外部人机验证服务。",
        ready: capReady,
        title: "可选 Cap 验证",
      }),
    );

    const metricsSecret = resolved?.get("publication.metrics_ingest_key") ?? null;
    const metricsEnabled = Boolean(settingString(resolved, "publication.metrics_ingest_key"));
    const metricsSecretReady =
      !metricsEnabled || isPublicationMetricsSecretAllowed(metricsSecret?.value, true);
    checks.push(
      check({
        action:
          "配置独立随机的公开指标 HMAC 密钥，并移除 dev-only、example 或 replace-before-production 占位值。",
        category: "SECURITY",
        code: "SECURITY_PUBLICATION_METRICS_SECRET",
        evidence: {
          enabled: metricsEnabled,
          configured: metricsSecret?.configured ?? false,
          source: metricsSecret?.source ?? "UNCONFIGURED",
          strong: metricsSecretReady,
        },
        href: "/platform/settings/security",
        message: !metricsEnabled
          ? "未配置公开指标接入密钥，外部指标回填保持关闭，不影响人工发布回填。"
          : metricsSecretReady
            ? "公开指标回填使用独立的生产强度 HMAC 密钥。"
            : "公开指标回填密钥缺失、长度不足或仍为开发占位值。",
        ready: metricsSecretReady,
        title: "公开指标回填签名密钥",
      }),
    );

    const lifecycle = storageLifecycleReadiness(
      resolved,
      storageState,
      health.ok ? health.value.checks.objectStorage.status === "ok" : null,
    );
    checks.push(
      check({
        action:
          lifecycle.evidence.provider === "LOCAL"
            ? "确认本机持久化目录读写正常，并按需安排文件备份；本机存储不提供云端版本控制。"
            : lifecycle.versioningRequired
              ? "启用 Bucket Versioning 与非当前版本生命周期；不支持的供应商可在存储设置关闭强制版本控制，接受无历史版本保护的策略。"
              : "版本控制按已保存策略不作强制要求；仍需修复连接、凭据或私有交付配置中的阻断项。",
        category: "INFRASTRUCTURE",
        code: "INFRASTRUCTURE_STORAGE_GOVERNANCE",
        evidence: lifecycle.evidence,
        stages: lifecycle.stages,
        href: "/platform/settings/storage",
        message: lifecycle.ready
          ? lifecycle.evidence.provider === "LOCAL"
            ? "本机私有存储连接与签名交付可用；未提供云端版本控制和历史版本保护。"
            : lifecycle.versioningRequired
              ? "对象存储版本控制、历史版本生命周期和私有签名交付均符合生产要求。"
              : "按当前策略通过：存储连接和私有交付配置正常；版本控制与历史版本生命周期已按策略跳过，未验证历史版本保护。"
          : `对象存储治理未达到生产要求：${lifecycle.invalid.join("、")}`,
        ready: lifecycle.ready,
        title: "对象存储治理",
      }),
    );

    const blocked = checks.filter(({ status }) => status === "BLOCKED").length;
    const warning = checks.filter(({ status }) => status === "WARNING").length;
    return {
      checks,
      deliveryMode,
      generatedAt: generatedAt.toISOString(),
      schemaVersion: 1,
      state: blocked === 0 ? "READY" : "BLOCKED",
      summary: { blocked, ready: checks.length - blocked - warning, total: checks.length, warning },
    };
  }

  private async routeReadiness(now: Date) {
    const [policy, routes] = await Promise.all([
      this.runtimePolicy.current(),
      this.prisma.modelRoute.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          scopeType: true,
          imageFallbackModelIds: true,
          imageModelId: true,
          textFallbackModelIds: true,
          textModelId: true,
        },
      }),
    ]);
    const requiredModelIds = new Set(
      routes.flatMap((route) => [
        route.textModelId,
        route.imageModelId,
        ...route.textFallbackModelIds,
        ...route.imageFallbackModelIds,
      ]),
    );
    if (policy.embeddingModelId) requiredModelIds.add(policy.embeddingModelId);
    if (policy.materialAnalysisModelId) requiredModelIds.add(policy.materialAnalysisModelId);
    await this.providerHealth.refreshModels([...requiredModelIds], policy);
    const models = await this.prisma.modelDefinition.findMany({
      include: { provider: { include: { activeCredential: true } } },
      where: { id: { in: [...requiredModelIds] } },
    });
    const modelsById = new Map(models.map((model) => [model.id, model]));
    const decryptableModelIds = new Set<string>();
    const productionEndpointModelIds = new Set(
      models
        .filter(
          (model) =>
            !model.synthetic &&
            !model.provider.synthetic &&
            isProductionHttpsEndpoint(model.provider.baseUrl),
        )
        .map((model) => model.id),
    );
    let cipher: ModelCredentialCipher | null = null;
    try {
      cipher = ModelCredentialCipher.fromEnvironment();
    } catch {
      // Report every required real model as blocked below without exposing credential details.
    }
    for (const model of models) {
      const credential = model.provider.activeCredential;
      if (
        model.synthetic ||
        model.provider.synthetic ||
        credential?.status !== "ACTIVE" ||
        !cipher
      ) {
        continue;
      }
      try {
        const apiKey = cipher.decrypt(
          {
            authenticationTag: credential.authenticationTag,
            ciphertext: credential.ciphertext,
            initializationVector: credential.initializationVector,
            keyVersion: credential.keyVersion,
          },
          modelCredentialAssociatedData(model.providerId, credential.id),
        );
        if (isProductionCredential(apiKey, 4)) decryptableModelIds.add(model.id);
      } catch {
        // The aggregate count is enough for readiness; never expose provider secrets or ciphertext.
      }
    }
    const assessments = await Promise.all(
      routes.map(async ({ id }) => {
        try {
          return await this.modelQualifications.assessRoute(id, policy, now);
        } catch {
          return null;
        }
      }),
    );
    let synthetic = 0;
    let qualified = 0;
    for (const [index, assessment] of assessments.entries()) {
      if (!assessment) continue;
      const route = routes[index];
      if (!route) continue;
      const routeModelIds = [
        route.textModelId,
        route.imageModelId,
        ...route.textFallbackModelIds,
        ...route.imageFallbackModelIds,
      ];
      const routeModels = routeModelIds.map((id) => modelsById.get(id));
      if (routeModels.some((model) => !model || model.synthetic || model.provider.synthetic)) {
        synthetic += 1;
      } else if (
        assessment.eligible &&
        routeModelIds.every(
          (modelId) => decryptableModelIds.has(modelId) && productionEndpointModelIds.has(modelId),
        )
      ) {
        qualified += 1;
      }
    }
    const embeddingModel = policy.embeddingModelId
      ? modelsById.get(policy.embeddingModelId)
      : undefined;
    const healthBoundary = now.getTime() - policy.providerHealthMaxAgeSeconds * 1_000;
    const embeddingReady =
      !policy.embeddingModelId ||
      Boolean(
        embeddingModel &&
          !embeddingModel.synthetic &&
          !embeddingModel.provider.synthetic &&
          embeddingModel.status === "ACTIVE" &&
          embeddingModel.provider.status === "ACTIVE" &&
          embeddingModel.capabilities.includes("EMBEDDING") &&
          !(
            embeddingModel.provider.circuitState === "OPEN" &&
            embeddingModel.provider.circuitOpenUntil &&
            embeddingModel.provider.circuitOpenUntil > now
          ) &&
          !(
            embeddingModel.provider.circuitState === "HALF_OPEN" &&
            embeddingModel.provider.circuitProbeExpiresAt &&
            embeddingModel.provider.circuitProbeExpiresAt > now
          ) &&
          decryptableModelIds.has(embeddingModel.id) &&
          productionEndpointModelIds.has(embeddingModel.id),
      );
    const configurationIssues: string[] = [];
    if (routes.length === 0) configurationIssues.push("尚未配置文案与图片路由");
    if (policy.embeddingModelId && !embeddingModel)
      configurationIssues.push("已配置的 Embedding 模型不可用");
    for (const modelId of requiredModelIds) {
      const model = modelsById.get(modelId);
      if (!model) configurationIssues.push(`模型 ${modelId} 不存在`);
      else if (model.status !== "ACTIVE" || model.provider.status !== "ACTIVE")
        configurationIssues.push(`模型 ${modelId} 或供应商未启用`);
      else if (!model.synthetic && !decryptableModelIds.has(modelId))
        configurationIssues.push(`模型 ${modelId} 的凭据缺失、无效或无法解密`);
    }
    if (embeddingModel && !embeddingModel.capabilities.includes("EMBEDDING"))
      configurationIssues.push("所选模型不具备 Embedding 能力");
    const connectionIssues: string[] = [];
    const checkedProviders = new Set<string>();
    for (const model of models) {
      if (model.synthetic || model.provider.synthetic || checkedProviders.has(model.providerId))
        continue;
      checkedProviders.add(model.providerId);
      const provider = model.provider;
      const label = provider.name ?? model.providerId;
      if (!provider.lastHealthCheckedAt)
        connectionIssues.push(`${label}：尚未取得自动连接检查结果，请检查地址及凭据`);
      else if (provider.healthStatus === "UNKNOWN")
        connectionIssues.push(`${label}：连接配置已更新，等待系统自动复查`);
      else if (provider.healthStatus !== "HEALTHY")
        connectionIssues.push(`${label}：自动连接检查未通过`);
      else if (provider.lastHealthCheckedAt.getTime() < healthBoundary)
        connectionIssues.push(`${label}：自动连接检查尚未取得最新结果，请稍后刷新`);
      if (
        (provider.circuitState === "OPEN" &&
          provider.circuitOpenUntil &&
          provider.circuitOpenUntil > now) ||
        (provider.circuitState === "HALF_OPEN" &&
          provider.circuitProbeExpiresAt &&
          provider.circuitProbeExpiresAt > now)
      )
        connectionIssues.push(`${label}：连接熔断正在冷却，稍后自动探测恢复`);
    }
    const validationIssues: string[] = [];
    for (const [index, assessment] of assessments.entries()) {
      const route = routes[index];
      if (!route) continue;
      const routeLabel = route.scopeType === "PLATFORM" ? "平台默认路由" : `路由 ${route.id}`;
      if (!assessment) {
        validationIssues.push(`${routeLabel}：无法读取资格验证结果`);
        continue;
      }
      if (!assessment.qualification)
        validationIssues.push(
          `${routeLabel}：当前配置尚未通过功能验证，或最近复验失败，请执行功能验证`,
        );
      for (const reason of assessment.reasons) {
        if (reason.code === "ROUTE_RUNTIME_REVALIDATION_REQUIRED")
          validationIssues.push(`${routeLabel}：${reason.message}`);
        if (reason.code === "TEXT_CAPABILITY_MISSING")
          configurationIssues.push(`路由 ${route.id}：文案模型缺少文本能力`);
        if (reason.code === "IMAGE_CAPABILITY_MISSING")
          configurationIssues.push(`路由 ${route.id}：图片模型缺少图片能力`);
      }
    }
    const productionIssues: string[] = [];
    if (models.some((model) => model.synthetic || model.provider.synthetic))
      productionIssues.push("路由或 Embedding 仍包含模拟模型");
    if (
      models.some(
        (model) =>
          !model.synthetic &&
          !model.provider.synthetic &&
          !productionEndpointModelIds.has(model.id),
      )
    )
      productionIssues.push("真实供应商地址必须使用公开 HTTPS");
    const stages: ReadinessStage[] = [
      stage(
        "CONFIGURATION",
        configurationIssues.length ? "BLOCKED" : "READY",
        configurationIssues.join("；") ||
          "文案、图片路由与已启用的外部 Embedding 配置完整；未启用时使用本地基础检索。",
        "补齐模型、能力与凭据配置。",
        "/platform/models",
      ),
      stage(
        "CONNECTION",
        checkedProviders.size === 0 ? "UNKNOWN" : connectionIssues.length ? "WARNING" : "READY",
        connectionIssues.join("；") ||
          (checkedProviders.size
            ? "所有关联真实供应商的连接检查均有效，熔断已关闭。"
            : "尚无可检查的真实供应商。"),
        "连接检查用于诊断，单次失败不使功能验证失效。持续任务失败才触发复验；短时调用保护冷却后自动探测。",
        "/platform/models#verification",
      ),
      stage(
        "VALIDATION",
        routes.length === 0 || assessments.some((assessment) => !assessment)
          ? "UNKNOWN"
          : validationIssues.length
            ? "BLOCKED"
            : "READY",
        validationIssues.join("；") ||
          (routes.length
            ? "当前配置已通过功能验证；验证不按天失效，持续依据真实任务的重试结果判断。"
            : "配置路由后才能进行功能验证。"),
        "执行路由资格验证：实际生成文案、图片并验证图片存储，可能产生供应商费用。",
        "/platform/models#verification",
      ),
      stage(
        "PRODUCTION",
        requiredModelIds.size === 0 ? "UNKNOWN" : productionIssues.length ? "BLOCKED" : "READY",
        productionIssues.join("；") ||
          (requiredModelIds.size
            ? "所引用模型均为真实资源，供应商地址符合生产要求。"
            : "配置真实模型后检查生产要求。"),
        "使用真实模型和公开 HTTPS 供应商地址；以上阶段均通过后才可生产验收。",
        "/platform/models",
      ),
    ];
    return {
      stages,
      blocked: routes.length - qualified,
      credentialFailures: [...requiredModelIds].filter(
        (modelId) =>
          !modelsById.get(modelId)?.synthetic &&
          (!decryptableModelIds.has(modelId) || !productionEndpointModelIds.has(modelId)),
      ).length,
      embeddingConfigured: Boolean(policy.embeddingModelId),
      embeddingReady,
      qualified,
      synthetic,
      total: routes.length,
    };
  }
}

function check(
  input: Readonly<{
    action: string;
    advisory?: boolean;
    category: ProductionReadinessCheck["category"];
    code: string;
    evidence: ProductionReadinessCheck["evidence"];
    href: string;
    message: string;
    ready: boolean;
    title: string;
    stages?: readonly ReadinessStage[];
  }>,
): ProductionReadinessCheck {
  const { ready, advisory, ...result } = input;
  return { ...result, status: ready ? "READY" : advisory ? "WARNING" : "BLOCKED" };
}

async function capture<T>(operation: () => Promise<T>): Promise<Captured<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    // Only preserve an HTTP status, never provider response text, URLs or credentials.
    const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
      ?.httpStatusCode;
    return { ok: false, httpStatus: typeof status === "number" ? status : undefined };
  }
}

function stage(
  code: ReadinessStage["code"],
  status: ReadinessStage["status"],
  message: string,
  action: string,
  href: string,
): ReadinessStage {
  const titles = {
    CONFIGURATION: "配置完整性",
    CONNECTION: "连接检查",
    VALIDATION: "功能验证",
    PRODUCTION: "生产要求",
  };
  return { code, title: titles[code], status, message, action, href };
}

function dependencyLabel(value: "database" | "generationQueue" | "objectStorage" | "redis") {
  return {
    database: "PostgreSQL",
    generationQueue: "BullMQ 生成队列",
    objectStorage: "对象存储连接",
    redis: "Redis",
  }[value];
}

function applicationSecretReadiness() {
  const required = [
    "ADMIN_JWT_SECRET",
    "EMPLOYEE_JWT_SECRET",
    "ADMIN_OTP_HMAC_SECRET",
    "EMPLOYEE_OTP_HMAC_SECRET",
  ] as const;
  const invalid: string[] = required.filter((name) => !strongSecret(process.env[name]));
  if (!validEncryptionKey(process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY)) {
    invalid.push("MODEL_CREDENTIAL_ENCRYPTION_KEY");
  }
  return {
    configured: required.length + 1 - invalid.length,
    invalid,
    ready: invalid.length === 0,
    required: required.length + 1,
  };
}

function strongSecret(value: string | undefined): boolean {
  return isProductionRandomSecret(value, 32);
}

function validEncryptionKey(value: string | undefined): boolean {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  const key = Buffer.from(value, "base64");
  return key.byteLength === 32 && hasMinimumByteDiversity(key);
}

function productionNetworkReadiness() {
  const invalid: string[] = [];
  const origins = (process.env.ADMIN_WEB_ORIGIN ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (origins.length === 0 || origins.some((origin) => !isProductionOrigin(origin))) {
    invalid.push("ADMIN_WEB_ORIGIN");
  }
  return {
    invalid,
    originCount: origins.length,
    ready: invalid.length === 0,
  };
}

function isProductionOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const local =
      url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (
      (local || isProductionHttpsEndpoint(value)) &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function storageLifecycleReadiness(
  settings: Awaited<ReturnType<PlatformSettingsReader["resolveMany"]>> | null,
  state: Captured<ObjectStorageLifecycleState>,
  connectionReady: boolean | null,
) {
  if (settingString(settings, "storage.provider") === "LOCAL") {
    const signingReady = strongSecret(process.env.ADMIN_JWT_SECRET);
    const invalid = [
      ...(signingReady ? [] : ["本机文件签名所依赖的管理员密钥不符合生产要求"]),
      ...(connectionReady === true ? [] : ["本机存储目录读写未通过或无法确认"]),
    ];
    const href = "/platform/settings/storage";
    return {
      versioningRequired: false,
      stages: [
        stage(
          "CONFIGURATION",
          "READY",
          "已选择本机存储；不需要 S3 地址、Bucket 或云端访问密钥。",
          "数据目录由部署环境管理，保存后重启 Worker。",
          href,
        ),
        stage(
          "CONNECTION",
          connectionReady === null ? "UNKNOWN" : connectionReady ? "READY" : "BLOCKED",
          connectionReady ? "本机存储目录检查通过。" : "无法确认本机存储目录可读写。",
          "检查持久化挂载和目录权限，并执行存储读写测试。",
          href,
        ),
        stage(
          "VALIDATION",
          "SKIPPED",
          "本机存储不支持 S3 版本控制和云端生命周期，未验证历史版本保护。",
          "按需自行安排文件备份；需要云端版本保护时使用支持该能力的 S3 服务。",
          href,
        ),
        stage(
          "PRODUCTION",
          signingReady ? "READY" : "BLOCKED",
          signingReady
            ? "本机文件使用短期签名访问，不公开静态目录。"
            : "本机文件签名所依赖的管理员密钥不符合生产要求。",
          "使用正式随机管理员密钥，并验证文件上传和私有签名读取。",
          href,
        ),
      ],
      evidence: {
        provider: "LOCAL",
        versioningRequired: false,
        versioningCheckSkipped: true,
        deliveryMode: "LOCAL_SIGNED",
        objectStorageCredentialsStrong: signingReady,
        lifecycleEnabled: null,
        noncurrentVersionExpirationDays: null,
        versioning: "UNSUPPORTED",
      },
      invalid,
      ready: invalid.length === 0,
    };
  }
  const invalid: string[] = [];
  // Only an explicit saved false opts out; missing/unreadable policy remains mandatory.
  const versioningRequired = settingBoolean(settings, "storage.versioning_required") !== false;
  const deliveryMode = settingString(settings, "storage.delivery_mode");
  const storageEndpoint = settingString(settings, "storage.endpoint");
  const accessKeyId = settingString(settings, "storage.access_key_id");
  const secretAccessKey = settingString(settings, "storage.secret_access_key");
  const bucket = settingString(settings, "storage.bucket");
  const region = settingString(settings, "storage.region");
  if (!bucket) invalid.push("Bucket 未配置");
  if (!region) invalid.push("Region 未配置");
  if (!isProductionCredential(accessKeyId, 3)) {
    invalid.push("Access Key ID 缺失或仍为开发占位值");
  }
  if (!isProductionCredential(secretAccessKey, 8)) {
    invalid.push("Secret Access Key 缺失或仍为开发占位值");
  }
  if (deliveryMode !== "S3_SIGNED" && deliveryMode !== "EDGE_SIGNED") {
    invalid.push("私有交付模式无效");
  }
  if (storageEndpoint && !isProductionHttpsEndpoint(storageEndpoint)) {
    invalid.push("对象存储 Endpoint 不是公开 HTTPS");
  }
  if (deliveryMode === "EDGE_SIGNED") {
    const baseUrl = settingString(settings, "storage.delivery_base_url");
    const signingKey = settingString(settings, "storage.delivery_signing_key");
    if (!baseUrl || !isProductionHttpsEndpoint(baseUrl)) invalid.push("Edge 交付域名无效");
    if (!strongSecret(signingKey ?? undefined)) invalid.push("Edge 签名密钥无效");
  }
  const expectedRetention = settingNumber(settings, "storage.noncurrent_version_expiration_days");
  const actual = state.ok ? state.value : null;
  const productionIssues = [...invalid];
  const readError = state.ok
    ? ""
    : state.httpStatus === 401
      ? "存储认证失败（HTTP 401），无法读取版本控制和生命周期状态"
      : state.httpStatus === 403
        ? "存储访问被拒绝（HTTP 403），请检查凭据和 Bucket 查询权限"
        : `无法读取版本控制和生命周期状态${state.httpStatus ? `（HTTP ${state.httpStatus}）` : "，请检查连接、权限及接口兼容性"}`;
  if (versioningRequired && !actual) invalid.push(readError);
  if (versioningRequired && actual && actual.versioning !== "ENABLED")
    invalid.push("Bucket Versioning 未启用");
  if (versioningRequired && actual && !actual.enabled) invalid.push("历史版本生命周期未启用");
  if (
    versioningRequired &&
    actual &&
    (expectedRetention === null || actual.noncurrentVersionExpirationDays !== expectedRetention)
  ) {
    invalid.push("历史版本保留天数与平台策略不一致");
  }
  const configured = Boolean(bucket && region && accessKeyId && secretAccessKey);
  const functionalityIssues = actual ? invalid.slice(productionIssues.length) : [];
  if (connectionReady !== true) invalid.push("存储连接未通过或无法确认");
  const stages: ReadinessStage[] = [
    stage(
      "CONFIGURATION",
      settings === null ? "UNKNOWN" : configured ? "READY" : "BLOCKED",
      settings === null
        ? "无法读取平台存储参数。"
        : configured
          ? "Bucket、Region 和访问凭据均已读取（包含环境默认值）；填写完整不代表认证成功。"
          : "Bucket、Region 或访问凭据缺失。",
      "补齐存储参数；Endpoint 应为 S3 兼容 API 地址。保存后需重启 Worker。",
      "/platform/settings/storage",
    ),
    stage(
      "CONNECTION",
      connectionReady === null ? "UNKNOWN" : connectionReady ? "READY" : "BLOCKED",
      connectionReady
        ? "Bucket 连接检查通过。"
        : !state.ok && (state.httpStatus === 401 || state.httpStatus === 403)
          ? readError
          : "Bucket 连接未通过或无法确认，请执行存储连接测试查看原因。",
      "检查 S3 API 地址、访问凭据和 Bucket 权限，然后执行存储测试。",
      "/platform/settings/storage",
    ),
    stage(
      "VALIDATION",
      !versioningRequired
        ? "SKIPPED"
        : !actual
          ? "UNKNOWN"
          : functionalityIssues.length
            ? "BLOCKED"
            : "READY",
      !versioningRequired
        ? "已关闭强制版本控制：按策略跳过版本控制与历史版本生命周期验证。未确认历史版本保护，误覆盖或误删除后可能无法恢复；对象读写仍需测试。"
        : !actual
          ? `${readError}；尚不能判断是否启用。`
          : functionalityIssues.join("；") ||
            "已读回版本控制和历史版本生命周期，配置符合策略；上传下载请另行执行存储测试。",
      !versioningRequired
        ? "需要历史版本保护时，使用支持该能力的存储并重新开启强制版本控制。此开关不会修改云端已有规则。"
        : actual
          ? "在存储设置中应用生命周期策略并确认读回结果。若应用后仍未启用，请核对 S3 API Endpoint 与 Bucket 名称，并确认供应商支持版本控制、非当前版本生命周期及账号管理权限；不能仅凭接口返回成功判断已生效。"
          : "先恢复存储访问及查询权限，再检查 Bucket Versioning 和历史版本保留策略。",
      "/platform/settings/storage",
    ),
    stage(
      "PRODUCTION",
      settings === null ? "UNKNOWN" : productionIssues.length ? "BLOCKED" : "READY",
      productionIssues.join("；") || "凭据、公开 HTTPS 地址及私有签名交付配置符合生产要求。",
      "使用正式凭据与 S3/Edge 私有签名交付；以上阶段通过后再验收。",
      "/platform/settings/storage",
    ),
  ];
  return {
    versioningRequired,
    stages,
    evidence: {
      provider: "S3",
      versioningRequired,
      versioningCheckSkipped: !versioningRequired,
      deliveryMode: deliveryMode ?? "UNCONFIGURED",
      objectStorageCredentialsStrong:
        isProductionCredential(accessKeyId, 3) && isProductionCredential(secretAccessKey, 8),
      lifecycleEnabled: actual?.enabled ?? null,
      noncurrentVersionExpirationDays: actual?.noncurrentVersionExpirationDays ?? null,
      versioning: actual?.versioning ?? "UNKNOWN",
    },
    invalid,
    ready: invalid.length === 0,
  };
}

function settingString(
  settings: Awaited<ReturnType<PlatformSettingsReader["resolveMany"]>> | null,
  key: string,
): string | null {
  const value = settings?.get(key)?.value;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function settingNumber(
  settings: Awaited<ReturnType<PlatformSettingsReader["resolveMany"]>> | null,
  key: string,
): number | null {
  const value = settings?.get(key)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function settingBoolean(
  settings: Awaited<ReturnType<PlatformSettingsReader["resolveMany"]>> | null,
  key: string,
): boolean | null {
  const value = settings?.get(key)?.value;
  return typeof value === "boolean" ? value : null;
}
