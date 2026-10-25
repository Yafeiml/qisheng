import { ModelCredentialCipher, modelCredentialAssociatedData } from "@xhs-agentic/ai-gateway";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationQueueMetrics } from "../campaign/generation-queue.service";
import type { MaterialIngestionQueueMetrics } from "../content/material-ingestion-queue.service";
import { PlatformContentSafetyService } from "../platform-settings/platform-content-safety.service";
import { ProductionReadinessService } from "./production-readiness.service";

const ENVIRONMENT_KEYS = [
  "ADMIN_JWT_SECRET",
  "ADMIN_OTP_HMAC_SECRET",
  "ADMIN_WEB_ORIGIN",
  "EMPLOYEE_JWT_SECRET",
  "EMPLOYEE_OTP_HMAC_SECRET",
  "ENABLE_DEV_AUTH",
  "GENERATION_DELIVERY_MODE",
  "GENERATION_EXECUTION_MODE",
  "MODEL_CREDENTIAL_ENCRYPTION_KEY",
  "MVP_GENERATION_ADAPTER",
  "NODE_ENV",
  "PUBLICATION_COLLECTOR_HMAC_KEY",
  "PUBLICATION_COLLECTOR_ID",
] as const;

describe("production readiness service", () => {
  const before = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENVIRONMENT_KEYS) before.set(key, process.env[key]);
    process.env.NODE_ENV = "production";
    process.env.GENERATION_DELIVERY_MODE = "PRODUCTION";
    process.env.ENABLE_DEV_AUTH = "false";
    process.env.GENERATION_EXECUTION_MODE = "queue";
    process.env.MVP_GENERATION_ADAPTER = "openai-compatible";
    process.env.ADMIN_WEB_ORIGIN = "https://admin.example.com";
    process.env.ADMIN_JWT_SECRET = "admin-jwt-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    process.env.EMPLOYEE_JWT_SECRET = "employee-jwt-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789";
    process.env.ADMIN_OTP_HMAC_SECRET = "admin-otp-9876543210-ZYXWVUTSRQPONMLKJIHGFEDCBA";
    process.env.EMPLOYEE_OTP_HMAC_SECRET = "employee-otp-ZYXWVUTSRQPONMLKJIHGFEDCBA-9876543210";
    process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY = Buffer.from(
      Array.from({ length: 32 }, (_, index) => index + 1),
    ).toString("base64");
  });

  afterEach(() => {
    for (const key of ENVIRONMENT_KEYS) {
      const value = before.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    before.clear();
  });

  it.each(["http://localhost:3101", "http://127.0.0.1:3101", "http://[::1]:3101"])(
    "accepts the local self-hosted administration origin %s",
    async (origin) => {
      process.env.ADMIN_WEB_ORIGIN = origin;
      const result = await minimalService(
        readySettings({ content: "a", publication: "b", sms: "c" }),
      ).audit();
      expect(result.checks.find(({ code }) => code === "SECURITY_NETWORK_ENDPOINTS")?.status).toBe(
        "READY",
      );
    },
  );
  it.each([
    "http://192.168.1.2:3101",
    "https://192.168.1.2",
    "http://user@localhost:3101",
    "http://localhost:3101/path",
  ])("rejects unsafe administration origins %s", async (origin) => {
    process.env.ADMIN_WEB_ORIGIN = origin;
    const result = await minimalService(
      readySettings({ content: "a", publication: "b", sms: "c" }),
    ).audit();
    expect(result.checks.find(({ code }) => code === "SECURITY_NETWORK_ENDPOINTS")?.status).toBe(
      "BLOCKED",
    );
  });

  it("supports password accounts without SMS, Cap or metrics services", async () => {
    const settings = readySettings({ content: "a", publication: "b", sms: "c" });
    for (const key of [...settings.keys()])
      if (
        key.startsWith("security.admin_sms") ||
        key.startsWith("security.cap_") ||
        key === "publication.metrics_ingest_key"
      )
        settings.delete(key);
    const result = await minimalService(settings).audit();
    expect(result.checks.map(({ code }) => code)).not.toContain("ADAPTER_ADMIN_SMS");
    expect(result.checks.find(({ code }) => code === "ADAPTER_CAP")).toMatchObject({
      status: "READY",
      evidence: { enabled: false },
    });
    expect(
      result.checks.find(({ code }) => code === "SECURITY_PUBLICATION_METRICS_SECRET"),
    ).toMatchObject({ status: "READY", evidence: { enabled: false } });
    settings.set("security.cap_enabled", setting(true));
    expect(
      (await minimalService(settings).audit()).checks.find(({ code }) => code === "ADAPTER_CAP")
        ?.status,
    ).toBe("BLOCKED");
    settings.set("security.cap_endpoint", setting("https://cap.example.com/site-key/"));
    settings.set("security.cap_secret", setting("private-cap-secret"));
    const configured = await minimalService(settings).audit();
    expect(configured.checks.find(({ code }) => code === "ADAPTER_CAP")?.status).toBe("READY");
    expect(JSON.stringify(configured)).not.toContain("private-cap-secret");
  });

  it.each([true, false])(
    "checks local storage connectivity without S3 credentials or cloud lifecycle: %s",
    async (connected) => {
      const settings = readySettings({ content: "a", publication: "b", sms: "c" });
      for (const key of [...settings.keys()]) if (key.startsWith("storage.")) settings.delete(key);
      settings.set("storage.provider", setting("LOCAL"));
      settings.set("storage.versioning_required", setting(true));
      const lifecycleRead = vi.fn();
      const result = await minimalService(settings, {
        storageConnected: connected,
        lifecycleRead,
      }).audit();
      const check = result.checks.find(({ code }) => code === "INFRASTRUCTURE_STORAGE_GOVERNANCE");
      expect(check).toMatchObject({
        status: connected ? "READY" : "BLOCKED",
        evidence: {
          provider: "LOCAL",
          deliveryMode: "LOCAL_SIGNED",
          versioning: "UNSUPPORTED",
          versioningCheckSkipped: true,
        },
      });
      expect(check?.stages?.find(({ code }) => code === "VALIDATION")?.status).toBe("SKIPPED");
      expect(check?.stages?.find(({ code }) => code === "CONNECTION")?.status).toBe(
        connected ? "READY" : "BLOCKED",
      );
      expect(lifecycleRead).not.toHaveBeenCalled();
    },
  );

  it.each([
    "ready",
    "local-index",
    "publication-advisory",
    "health-expired",
    "health-invalidated",
    "health-failed",
    "no-qualification",
    "storage-401",
    "storage-403",
    "lifecycle-off",
    "optional",
    "optional-connection-failed",
    "optional-credentials-invalid",
    "optional-endpoint-invalid",
  ])("reports precise stages without relaxing production gates: %s", async (scenario) => {
    const secrets = {
      content: "content-safety-production-secret",
      publication: "publication-production-secret",
      sms: "sms-production-secret",
    };
    const settings = readySettings(secrets);
    if (scenario === "publication-advisory") {
      settings.set("publication.mode", setting("DEVELOPMENT"));
      settings.set("publication.require_image_match", setting(false));
    }
    if (scenario.startsWith("optional"))
      settings.set("storage.versioning_required", setting(false));
    if (scenario === "optional-credentials-invalid")
      settings.set("storage.secret_access_key", setting("dev-placeholder"));
    if (scenario === "optional-endpoint-invalid")
      settings.set("storage.endpoint", setting("http://127.0.0.1:9000"));
    let lifecycleReads = 0;
    const models = readyModels();
    if (scenario === "health-expired") {
      for (const model of models) model.provider.lastHealthCheckedAt = new Date(0);
    }
    if (scenario === "health-invalidated") {
      for (const model of models) model.provider.healthStatus = "UNKNOWN";
    }
    const prisma = {
      publishSubmission: { count: async () => 0 },
      modelDefinition: { findMany: async () => models },
      modelRoute: {
        findMany: async () => [
          {
            id: "route-1",
            imageFallbackModelIds: [],
            imageModelId: "image-model",
            textFallbackModelIds: [],
            textModelId: "text-model",
          },
        ],
      },
      publicationVerificationPolicyEvidence: {
        findFirst: async () => ({
          benchmarkId: "p014-production-20260831",
          policyVersion: "xhs-public-v1",
          providerCode: "PUBLICATION_VENDOR_V1",
          sampleCount: 30,
        }),
      },
    };
    const refreshModels = vi.fn(async () => {
      for (const model of models) {
        model.provider.lastHealthCheckedAt = new Date();
        model.provider.healthStatus = scenario === "health-failed" ? "UNHEALTHY" : "HEALTHY";
      }
    });
    const service = new ProductionReadinessService(
      prisma as never,
      {
        checkDependencies: async () => ({
          checks: {
            database: { latencyMs: 2, status: "ok" },
            generationQueue: { latencyMs: 1, status: "ok" },
            objectStorage: {
              latencyMs: 3,
              status:
                scenario.startsWith("storage-") || scenario === "optional-connection-failed"
                  ? "error"
                  : "ok",
            },
            redis: { latencyMs: 1, status: "ok" },
          },
          status: "ok",
        }),
      } as never,
      {
        getOperationalMetrics: async () => ({
          active: 0,
          completed: 12,
          delayed: 0,
          failed: 0,
          paused: false,
          waiting: 0,
          workers: 2,
        }),
      } as never,
      {
        getOperationalMetrics: async () => ({
          active: 0,
          delayed: 0,
          failed: 0,
          paused: false,
          waiting: 0,
          workers: 1,
        }),
      } as never,
      {
        assessRoute: async () => ({
          eligible: scenario !== "no-qualification",
          qualification: scenario === "no-qualification" ? null : { id: "qualification-1" },
          reasons: [],
          route: { imageModel: { synthetic: false }, textModel: { synthetic: false } },
        }),
      } as never,
      {
        current: async () => ({
          embeddingModelId: scenario === "local-index" ? null : "embedding-model",
          maxQueueBacklog: 100,
          minimumGenerationWorkers: 1,
          providerHealthMaxAgeSeconds: 900,
        }),
      } as never,
      {
        current: async () => ({
          storage: {
            lifecycleState: async () => {
              lifecycleReads += 1;
              if (scenario.startsWith("storage-"))
                throw Object.assign(new Error("sensitive-provider-response"), {
                  $metadata: { httpStatusCode: Number(scenario.split("-")[1]) },
                });
              return {
                abortIncompleteMultipartUploadDays: 7,
                enabled: scenario !== "lifecycle-off",
                noncurrentVersionExpirationDays: 30,
                versioning: "ENABLED",
              };
            },
          },
        }),
      } as never,
      { resolveMany: async () => settings } as never,
      { refreshModels } as never,
      safetyService(settings),
    );

    const audit = await service.audit();
    expect(refreshModels).toHaveBeenCalledWith(
      expect.arrayContaining(
        scenario === "local-index"
          ? ["text-model", "image-model"]
          : ["text-model", "image-model", "embedding-model"],
      ),
      expect.objectContaining({ providerHealthMaxAgeSeconds: 900 }),
    );

    const modelCheck = audit.checks.find(({ code }) => code === "MODEL_ROUTE_QUALIFICATION");
    const storageCheck = audit.checks.find(
      ({ code }) => code === "INFRASTRUCTURE_STORAGE_GOVERNANCE",
    );
    expect(modelCheck?.stages?.find(({ code }) => code === "CONFIGURATION")?.status).toBe("READY");
    expect(storageCheck?.stages?.find(({ code }) => code === "CONFIGURATION")?.status).toBe(
      "READY",
    );
    expect(JSON.stringify(audit)).not.toContain("sensitive-provider-response");
    if (scenario.startsWith("optional")) {
      expect(lifecycleReads).toBe(0);
      expect(storageCheck?.evidence).toMatchObject({
        versioningRequired: false,
        versioningCheckSkipped: true,
        lifecycleEnabled: null,
      });
      expect(storageCheck?.stages?.find(({ code }) => code === "VALIDATION")?.status).toBe(
        "SKIPPED",
      );
      expect(storageCheck?.status).toBe(scenario === "optional" ? "READY" : "BLOCKED");
      expect(audit.state).toBe(scenario === "optional" ? "READY" : "BLOCKED");
      settings.set("storage.versioning_required", setting(true));
      const strict = await service.audit();
      expect(lifecycleReads).toBe(1);
      expect(
        strict.checks.find(({ code }) => code === "INFRASTRUCTURE_STORAGE_GOVERNANCE")?.evidence
          .versioningCheckSkipped,
      ).toBe(false);
      return;
    }
    expect(lifecycleReads).toBe(1);
    if (scenario === "health-failed") {
      expect(audit.state).toBe("READY");
      expect(modelCheck?.stages?.find(({ code }) => code === "CONNECTION")).toMatchObject({
        status: "WARNING",
        message: expect.stringContaining("自动连接检查未通过"),
      });
      expect(modelCheck?.stages?.find(({ code }) => code === "VALIDATION")?.status).toBe("READY");
      return;
    }
    if (
      ![
        "ready",
        "local-index",
        "publication-advisory",
        "health-expired",
        "health-invalidated",
      ].includes(scenario)
    ) {
      expect(audit.state).toBe("BLOCKED");

      if (scenario === "no-qualification") {
        expect(modelCheck?.stages?.find(({ code }) => code === "VALIDATION")).toMatchObject({
          status: "BLOCKED",
          message: expect.stringContaining("当前配置尚未通过功能验证"),
        });
        expect(modelCheck?.stages?.find(({ code }) => code === "CONNECTION")?.status).toBe("READY");
      } else if (scenario.startsWith("storage-")) {
        expect(storageCheck?.message).toContain(`HTTP ${scenario.split("-")[1]}`);
        expect(storageCheck?.message).not.toContain("未启用");
        expect(storageCheck?.evidence.lifecycleEnabled).toBeNull();
        expect(storageCheck?.stages?.find(({ code }) => code === "VALIDATION")?.status).toBe(
          "UNKNOWN",
        );
      } else {
        expect(storageCheck?.message).toContain("历史版本生命周期未启用");
        expect(storageCheck?.stages?.find(({ code }) => code === "VALIDATION")?.status).toBe(
          "BLOCKED",
        );
      }
      return;
    }
    expect(modelCheck?.stages?.every(({ status }) => status === "READY")).toBe(true);
    expect(storageCheck?.stages?.every(({ status }) => status === "READY")).toBe(true);

    expect(audit.checks.filter(({ status }) => status === "BLOCKED")).toEqual([]);
    expect(audit).toMatchObject({
      deliveryMode: "PRODUCTION",
      state: "READY",
      summary: { blocked: 0, ready: 13, total: 13, warning: 0 },
    });
    expect(audit.checks.every(({ status }) => status === "READY")).toBe(true);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(secrets.content);
    expect(serialized).not.toContain(secrets.publication);
    expect(serialized).not.toContain(secrets.sms);
  });

  it("fails closed when an external endpoint is local even if credentials exist", async () => {
    const settings = readySettings({ content: "a", publication: "b", sms: "c" });
    settings.set("content_safety.endpoint", setting("http://127.0.0.1:9009/v1/scan"));
    const service = minimalService(settings);

    const audit = await service.audit();

    expect(audit.state).toBe("BLOCKED");
    expect(audit.checks.find(({ code }) => code === "ADAPTER_CONTENT_SAFETY")).toMatchObject({
      status: "BLOCKED",
    });
  });

  it("rejects a development placeholder used as the metrics ingestion HMAC key", async () => {
    const settings = readySettings({ content: "a", publication: "b", sms: "c" });
    settings.set(
      "publication.metrics_ingest_key",
      setting("dev-hermes-ingest-key-replace-before-production"),
    );
    const service = minimalService(settings);

    const audit = await service.audit();

    expect(
      audit.checks.find(({ code }) => code === "SECURITY_PUBLICATION_METRICS_SECRET"),
    ).toMatchObject({ status: "BLOCKED" });
  });

  it("does not surface legacy publication adapter or P-014 checks in production audit", async () => {
    const settings = readySettings({ content: "a", publication: "b", sms: "c" });
    const evidenceRead = vi.fn();
    for (const mode of ["DEVELOPMENT", "BROWSER", "HTTP"]) {
      settings.set("publication.mode", setting(mode));
      const audit = await minimalService(settings, { evidenceRead }).audit();
      expect(audit.checks.map(({ code }) => code)).not.toContain(
        "ADAPTER_PUBLICATION_VERIFICATION",
      );
      expect(audit.checks.map(({ code }) => code)).not.toContain(
        "ADAPTER_PUBLICATION_POLICY_EVIDENCE",
      );
      expect(audit.summary).toMatchObject({ total: 13, warning: 0 });
    }
    expect(evidenceRead).not.toHaveBeenCalled();
  });

  it("blocks production when the material ingestion queue has no worker", async () => {
    const service = minimalService(readySettings({ content: "a", publication: "b", sms: "c" }), {
      materialQueue: { workers: 0 },
    });

    const audit = await service.audit();

    expect(
      audit.checks.find(({ code }) => code === "INFRASTRUCTURE_WORKER_CAPACITY"),
    ).toMatchObject({
      status: "BLOCKED",
      message: expect.stringContaining("素材入库队列没有在线消费者"),
    });
  });

  it("accepts a single co-located Worker consuming every generation and material queue", async () => {
    const audit = await minimalService(
      readySettings({ content: "a", publication: "b", sms: "c" }),
    ).audit();
    expect(
      audit.checks.find(({ code }) => code === "INFRASTRUCTURE_WORKER_CAPACITY"),
    ).toMatchObject({
      status: "READY",
      action: expect.stringContaining("无需独立服务器"),
      evidence: { workers: 1, materialWorkers: 1, minimumWorkers: 1 },
    });
  });

  it("keeps a saved minimum above one instead of lowering the capacity requirement", async () => {
    const audit = await minimalService(
      readySettings({ content: "a", publication: "b", sms: "c" }),
      { minimumWorkers: 2 },
    ).audit();
    expect(
      audit.checks.find(({ code }) => code === "INFRASTRUCTURE_WORKER_CAPACITY"),
    ).toMatchObject({
      status: "BLOCKED",
      message: expect.stringContaining("每个队列要求至少 2"),
      evidence: { workers: 1, minimumWorkers: 2 },
    });
  });

  it("accepts queue backlogs exactly at the saved limit", async () => {
    const audit = await minimalService(
      readySettings({ content: "a", publication: "b", sms: "c" }),
      { generationQueue: { waiting: 80, delayed: 20 }, materialQueue: { waiting: 100 } },
    ).audit();
    expect(
      audit.checks.find(({ code }) => code === "INFRASTRUCTURE_WORKER_CAPACITY"),
    ).toMatchObject({
      status: "READY",
      evidence: { backlog: 100, materialBacklog: 100 },
    });
  });

  it.each([
    [{ generationQueue: { workers: 0 } }, "生成队列在线消费者不足"],
    [{ generationQueue: { paused: true } }, "生成队列已暂停"],
    [{ materialQueue: { paused: true } }, "素材入库队列已暂停"],
    [{ generationQueue: { waiting: 80, delayed: 21 } }, "生成队列积压 101，超过运行策略上限 100"],
    [{ materialQueue: { waiting: 80, delayed: 21 } }, "素材入库队列积压 101，超过运行策略上限 100"],
    [{ runtimePolicyUnavailable: true }, "运行策略无法读取"],
    [{ generationQueueUnavailable: true }, "生成队列状态无法读取"],
    [{ materialQueueUnavailable: true }, "素材入库队列状态无法读取"],
  ] as const)(
    "keeps queue failures blocked and identifies their cause: %j",
    async (options, cause) => {
      const audit = await minimalService(
        readySettings({ content: "a", publication: "b", sms: "c" }),
        options,
      ).audit();
      expect(
        audit.checks.find(({ code }) => code === "INFRASTRUCTURE_WORKER_CAPACITY"),
      ).toMatchObject({
        status: "BLOCKED",
        message: expect.stringContaining(cause),
      });
      expect(JSON.stringify(audit)).not.toContain("private-runtime-error");
    },
  );

  it("explains storage and safety configuration while consumers are waiting without declaring readiness", async () => {
    const settings = readySettings({ content: "a", publication: "b", sms: "c" });
    settings.set("content_safety.mode", setting("DISABLED"));
    const audit = await minimalService(settings, {
      generationQueue: { workers: 0 },
      materialQueue: { workers: 0 },
      storageConnected: false,
    }).audit();
    const capacity = audit.checks.find(({ code }) => code === "INFRASTRUCTURE_WORKER_CAPACITY");
    expect(capacity?.status).toBe("BLOCKED");
    expect(capacity?.message).toContain("生成队列在线消费者不足");
    expect(capacity?.message).toContain("素材入库队列没有在线消费者");
    expect(capacity?.message).toContain("存储尚未就绪");
    expect(capacity?.message).toContain("内容审核未配置或未验证");
    expect(audit.checks.find(({ code }) => code === "ADAPTER_CONTENT_SAFETY")?.status).toBe(
      "BLOCKED",
    );
  });

  it("does not blame material consumer availability on generation safety configuration", async () => {
    const settings = readySettings({ content: "a", publication: "b", sms: "c" });
    settings.set("content_safety.mode", setting("DISABLED"));
    const audit = await minimalService(settings, { materialQueue: { workers: 0 } }).audit();
    const capacity = audit.checks.find(({ code }) => code === "INFRASTRUCTURE_WORKER_CAPACITY");
    expect(capacity?.status).toBe("BLOCKED");
    expect(capacity?.message).toContain("素材入库队列没有在线消费者");
    expect(capacity?.message).not.toContain("生成消费者会等待审核配置");
  });

  it("blocks incomplete enabled WeChat notification configuration", async () => {
    const settings = readySettings({ content: "a", publication: "b", sms: "c" });
    settings.set("notification.enabled", setting(true));
    const audit = await minimalService(settings).audit();
    expect(audit.checks.find(({ code }) => code === "RUNTIME_PRODUCTION_MODE")).toMatchObject({
      status: "BLOCKED",
      message: expect.stringContaining("任务通知配置"),
    });
  });

  it("accepts complete enabled WeChat subscription notification configuration", async () => {
    const settings = readySettings({ content: "a", publication: "b", sms: "c" });
    for (const [key, value] of Object.entries({
      "notification.enabled": true,
      "notification.channel": "WECHAT_TEMPLATE",
      "miniapp.wechat_app_id": "wx1111111111111111",
      "miniapp.wechat_app_secret": "A".repeat(32),
      "notification.wechat_template_id": "template_id",
      "notification.wechat_template_fields": '{"thing4":"TASK_TITLE","time5":"EXPIRES_AT"}',
      "notification.wechat_environment": "formal",
    }))
      settings.set(key, setting(value));
    const audit = await minimalService(settings).audit();
    expect(audit.checks.find(({ code }) => code === "RUNTIME_PRODUCTION_MODE")?.status).toBe(
      "READY",
    );
  });

  it("checks material SMS independently of the login template and WeChat subscription settings", async () => {
    const settings = readySettings({ content: "a", publication: "b", sms: "c" });
    for (const [key, value] of Object.entries({
      "notification.enabled": true,
      "notification.channel": "ALIYUN_SMS",
      "notification.sms_template_code": "SMS_987654",
      "notification.sms_daily_limit": 3,
      "security.admin_sms_access_key_id": "LTAI0123456789",
      "security.admin_sms_access_key_secret": "AliyunRealKey0123456789",
      "security.admin_sms_sign_name": "企声共创",
    }))
      settings.set(key, setting(value));
    settings.delete("security.admin_sms_template_code");
    const audit = await minimalService(settings).audit();
    expect(audit.checks.find(({ code }) => code === "RUNTIME_PRODUCTION_MODE")?.status).toBe(
      "READY",
    );
    settings.delete("notification.sms_template_code");
    const incomplete = await minimalService(settings).audit();
    expect(incomplete.checks.find(({ code }) => code === "RUNTIME_PRODUCTION_MODE")?.status).toBe(
      "BLOCKED",
    );
    expect(JSON.stringify(incomplete)).not.toContain("AliyunRealKey0123456789");
  });

  it.each([
    ["NODE_ENV", "development", "运行环境"],
    ["GENERATION_DELIVERY_MODE", "DEVELOPMENT", "内容交付"],
    ["ENABLE_DEV_AUTH", "true", "开发认证"],
    ["GENERATION_EXECUTION_MODE", "inline", "任务队列"],
    ["GENERATION_EXECUTION_MODE", undefined, "任务队列"],
    ["MVP_GENERATION_ADAPTER", "synthetic", "模拟生成"],
  ])("reports the specific invalid runtime setting %s=%s", async (key, value, issue) => {
    if (value === undefined) delete process.env[key as string];
    else process.env[key as string] = value;
    const settings = readySettings({ content: "a", publication: "b", sms: "c" });
    const audit = await minimalService(settings).audit();
    const runtime = audit.checks.find(({ code }) => code === "RUNTIME_PRODUCTION_MODE");
    expect(runtime).toMatchObject({
      status: "BLOCKED",
      message: expect.stringContaining(issue as string),
    });
    expect(runtime?.message).not.toContain("支付");
  });
});

function minimalService(
  settings: Map<string, ReturnType<typeof setting>>,
  options: Readonly<{
    countQuery?: (where: unknown) => void;
    evidenceRead?: () => void;
    generationQueue?: Partial<GenerationQueueMetrics>;
    generationQueueUnavailable?: boolean;
    minimumWorkers?: number;
    materialQueue?: Partial<MaterialIngestionQueueMetrics>;
    materialQueueUnavailable?: boolean;
    runtimePolicyUnavailable?: boolean;
    publicationEvidence?: Record<string, unknown>;
    publicationMonitoringFails?: boolean;
    submittedLast24h?: number;
    staleUnverified?: number;
    storageConnected?: boolean;
    lifecycleRead?: () => void;
  }> = {},
) {
  return new ProductionReadinessService(
    {
      publishSubmission: {
        count: async ({ where }: { where: { status?: unknown } }) => {
          options.countQuery?.(where);
          return options.publicationMonitoringFails
            ? Promise.reject(new Error("private-database-error"))
            : where.status
              ? (options.staleUnverified ?? 0)
              : (options.submittedLast24h ?? 0);
        },
      },
      modelDefinition: { findMany: async () => [] },
      modelRoute: { findMany: async () => [] },
      publicationVerificationPolicyEvidence: {
        findFirst: async () => {
          options.evidenceRead?.();
          return options.publicationEvidence ?? null;
        },
      },
    } as never,
    {
      checkDependencies: async () => ({
        checks: {
          database: { latencyMs: 1, status: "ok" },
          generationQueue: { latencyMs: 1, status: "ok" },
          objectStorage: {
            latencyMs: 1,
            status: options.storageConnected === false ? "error" : "ok",
          },
          redis: { latencyMs: 1, status: "ok" },
        },
        status: "ok",
      }),
    } as never,
    {
      getOperationalMetrics: async () => {
        if (options.generationQueueUnavailable) throw new Error("private-runtime-error");
        return {
          active: 0,
          completed: 0,
          delayed: 0,
          failed: 0,
          paused: false,
          waiting: 0,
          workers: 1,
          ...options.generationQueue,
        };
      },
    } as never,
    {
      getOperationalMetrics: async () => {
        if (options.materialQueueUnavailable) throw new Error("private-runtime-error");
        return {
          active: 0,
          delayed: 0,
          failed: 0,
          paused: false,
          waiting: 0,
          workers: 1,
          ...options.materialQueue,
        };
      },
    } as never,
    { assessRoute: async () => null } as never,
    {
      current: async () => {
        if (options.runtimePolicyUnavailable) throw new Error("private-runtime-error");
        return {
          embeddingModelId: null,
          maxQueueBacklog: 100,
          minimumGenerationWorkers: options.minimumWorkers ?? 1,
          providerHealthMaxAgeSeconds: 900,
        };
      },
    } as never,
    {
      current: async () => ({
        storage: {
          lifecycleState: async () => {
            options.lifecycleRead?.();
            return {
              abortIncompleteMultipartUploadDays: 7,
              enabled: true,
              noncurrentVersionExpirationDays: 30,
              versioning: "ENABLED",
            };
          },
        },
      }),
    } as never,
    { resolveMany: async () => settings } as never,
    { refreshModels: async () => {} } as never,
    safetyService(settings),
  );
}

function readySettings(secrets: { content: string; publication: string; sms: string }) {
  return new Map([
    ["content_safety.api_key", setting(secrets.content)],
    ["content_safety.endpoint", setting("https://safety.example.com/v1/scan")],
    ["content_safety.mode", setting("HTTP")],
    ["content_safety.provider", setting("SAFETY_VENDOR_V1")],
    ["notification.enabled", setting(false)],
    ["publication.api_key", setting(secrets.publication)],
    ["publication.endpoint", setting("https://publication.example.com/v1/resolve")],
    ["publication.image_similarity_threshold", setting(0.8)],
    ["publication.manual_review_margin", setting(0.08)],
    ["publication.metrics_ingest_key", setting("metrics-ingest-production-secret-2026-strong")],
    ["publication.mode", setting("HTTP")],
    ["publication.policy_version", setting("xhs-public-v1")],
    ["publication.provider", setting("PUBLICATION_VENDOR_V1")],
    ["publication.require_image_match", setting(true)],
    ["publication.text_similarity_threshold", setting(0.72)],
    ["security.admin_sms_api_key", setting(secrets.sms)],
    ["security.admin_sms_endpoint", setting("https://sms.example.com/v1/messages")],
    ["security.admin_sms_mode", setting("HTTP")],
    ["security.admin_sms_provider", setting("SMS_VENDOR_V1")],
    ["security.admin_sms_sender", setting("明澈助手")],
    ["security.admin_sms_template_id", setting("ADMIN_LOGIN_V1")],
    ["storage.abort_incomplete_upload_days", setting(7)],
    ["storage.access_key_id", setting("AKIAPRODUCTIONREADY")],
    ["storage.bucket", setting("xhs-production-assets")],
    ["storage.delivery_base_url", setting("")],
    ["storage.delivery_mode", setting("S3_SIGNED")],
    ["storage.delivery_signing_key", setting("")],
    ["storage.endpoint", setting("")],
    ["storage.noncurrent_version_expiration_days", setting(30)],
    ["storage.region", setting("cn-east-1")],
    ["storage.secret_access_key", setting("storage-production-credential-value")],
  ]);
}

function readyModels() {
  const providerId = "provider-1";
  const credentialId = "credential-1";
  const encrypted = ModelCredentialCipher.fromEnvironment().encrypt(
    "provider-production-api-key",
    modelCredentialAssociatedData(providerId, credentialId),
  );
  const provider = {
    activeCredential: {
      ...encrypted,
      id: credentialId,
      providerId,
      status: "ACTIVE",
    },
    baseUrl: "https://models.example.com/v1",
    circuitState: "CLOSED",
    healthStatus: "HEALTHY",
    id: providerId,
    lastHealthCheckedAt: new Date(),
    status: "ACTIVE",
    synthetic: false,
  };
  return [
    {
      capabilities: ["TEXT"],
      id: "text-model",
      provider,
      providerId,
      status: "ACTIVE",
      synthetic: false,
    },
    {
      capabilities: ["IMAGE"],
      id: "image-model",
      provider,
      providerId,
      status: "ACTIVE",
      synthetic: false,
    },
    {
      capabilities: ["EMBEDDING"],
      id: "embedding-model",
      provider,
      providerId,
      status: "ACTIVE",
      synthetic: false,
    },
  ];
}

function setting(value: boolean | number | string) {
  return {
    configured: true,
    lastFour: null,
    source: "DATABASE" as const,
    updatedAt: new Date(),
    updatedBy: "platform-admin",
    value,
    version: 1,
  };
}

function safetyService(settings: Map<string, ReturnType<typeof setting>>) {
  return new PlatformContentSafetyService(
    {
      auditLog: { findFirst: async () => ({ metadata: { success: true }, createdAt: new Date() }) },
    } as never,
    {} as never,
    { resolveMany: async () => settings } as never,
    {} as never,
  );
}
