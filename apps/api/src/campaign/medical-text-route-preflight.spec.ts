import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfigurationService } from "../model-configuration/model-configuration.service";
import {
  configurationFingerprint,
  ModelQualificationService,
} from "../model-configuration/model-qualification.service";
import { GenerationPreflightService } from "./generation-preflight.service";
import type { FrozenMedicalPlan } from "./medical-planning.service";

const scope = { tenantId: "tenant", enterpriseId: "enterprise" };
function fixture(imageMode: FrozenMedicalPlan["imageMode"] = "QUESTION_CARD") {
  const now = new Date();
  const provider = {
    id: "text-provider",
    code: "TEXT",
    protocol: "OPENAI_COMPATIBLE",
    status: "ACTIVE",
    activeCredentialId: "text-credential",
    activeCredential: { status: "ACTIVE" },
    synthetic: false,
    timeoutMs: 60000,
    baseUrl: "https://text.example/v1",
    circuitState: "CLOSED",
    updatedAt: now,
  };
  const textModel = {
    id: "text",
    externalModelId: "text-model",
    status: "ACTIVE",
    providerId: provider.id,
    provider,
    capabilities: ["TEXT"],
    metadata: { inputCostPerMillionUnits: 1, outputCostPerMillionUnits: 2 },
    synthetic: false,
    tier: "STANDARD",
    updatedAt: now,
  };
  const imageModel = {
    ...textModel,
    id: "unused-image",
    capabilities: [],
    status: "DISABLED",
    metadata: { imageCost: 999 },
    providerId: "image-provider",
    provider: {
      ...provider,
      id: "image-provider",
      status: "DISABLED",
      activeCredentialId: null,
      activeCredential: null,
    },
  };
  const route = {
    id: "route",
    scopeType: "PLATFORM",
    scopeId: "platform",
    textModelId: "text",
    imageModelId: "unused-image",
    textFallbackModelIds: [],
    imageFallbackModelIds: ["deleted-unused-image-fallback"],
    textModel,
    imageModel,
    maxAttemptsPerModel: 1,
    updatedAt: now,
  };
  const fingerprint = configurationFingerprint(route as never, [textModel] as never, false);
  const receipt = {
    id: "text-qualified",
    checkedAt: new Date(now.getTime() - 1000),
    configurationFingerprint: fingerprint,
    estimatedCost: 0.01,
    status: "PASSED",
    storageVerified: false,
    diagnostics: {
      requiredCapabilities: ["TEXT"],
      textConfigurationFingerprint: fingerprint,
      steps: { TEXT: "PASSED", IMAGE: "NOT_RUN" },
    },
  };
  const prisma = {
    enterprise: { findFirst: vi.fn().mockResolvedValue({ id: "enterprise", status: "ACTIVE" }) },
    enterpriseMembership: { findMany: vi.fn().mockResolvedValue([{ id: "member" }]) },
    material: { count: vi.fn().mockResolvedValue(1) },
    modelDefinition: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(1),
    },
    modelRoute: {
      findMany: vi.fn().mockResolvedValue([route]),
      findUnique: vi.fn().mockResolvedValue(route),
    },
    modelRouteQualification: {
      findFirst: vi.fn().mockImplementation(async ({ where }) => (where.OR ? receipt : null)),
    },
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const access = { requireSaasAdmin: () => ({ scope: { type: "ENTERPRISE", ...scope } }) };
  const policy = {
    id: "policy",
    updatedAt: now,
    embeddingModelId: "embedding",
    providerHealthMaxAgeSeconds: 900,
    costWarningThreshold: 100,
  };
  const qualifications = new ModelQualificationService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { ensureFresh: vi.fn().mockResolvedValue(undefined) } as never,
  );
  const models = new ModelConfigurationService(
    prisma as never,
    access as never,
    {} as never,
    qualifications,
    {} as never,
  );
  const medicalPlan: FrozenMedicalPlan = {
    schemaVersion: "medical-selection-v1",
    executionVersion: "medical-plan-v1",
    objective: "GEO_AND_TRANSACTION",
    priority: "BALANCED",
    topicIds: ["topic"],
    readerSituation: "FIRST_UNDERSTANDING",
    noteForm: "QUESTION_LIST",
    imageMode,
    conversionPath: "NONE",
    frozenAt: now.toISOString(),
    topics: [
      {
        id: "topic",
        seriesId: "series",
        version: 1,
        question: "首次咨询要确认什么",
        intent: "了解",
        entityId: "entity",
        entityName: "企业",
      },
    ],
    publishers: [
      {
        membershipId: "member",
        publisherContext: {
          schemaVersion: "medical-publisher-v1",
          category: "UNKNOWN",
          allowBrandAttribution: false,
          allowPlatformConsultation: false,
        },
      },
    ],
  };
  const service = new GenerationPreflightService(
    prisma as never,
    access as never,
    {
      current: vi
        .fn()
        .mockResolvedValue({ imagesPerDistribution: 3, groupSharedMaterialsEnabled: true }),
    } as never,
    models,
    qualifications,
    { current: vi.fn().mockResolvedValue(policy) } as never,
    {} as never,
    {} as never,
    { readiness: vi.fn().mockResolvedValue({ configured: true }) } as never,
    { resolve: vi.fn().mockResolvedValue(medicalPlan) } as never,
  );
  return { service, models, prisma, medicalPlan, policy };
}
beforeEach(() => vi.stubEnv("GENERATION_DELIVERY_MODE", "PRODUCTION"));
afterEach(() => vi.unstubAllEnvs());
describe("medical local-image API preflight", () => {
  it("allows production preflight with local indexing and still rejects an unavailable configured embedding model", async () => {
    const { service, prisma, policy } = fixture();
    Object.assign(service, {
      medicalPlanning: { resolve: vi.fn().mockResolvedValue(null) },
      runtimePolicy: { current: vi.fn().mockResolvedValue({ ...policy, embeddingModelId: null }) },
    });
    const checked = await service.customerPreflight(scope, {
      title: "通用活动",
      prompt: "分享授权门店资料",
    });
    expect(checked.checks.find(({ code }) => code === "RETRIEVAL_INDEX_READY")).toMatchObject({
      status: "PASSED",
      description: expect.stringContaining("本地字符特征"),
    });
    expect(prisma.modelDefinition.count).not.toHaveBeenCalled();
    Object.assign(service, { runtimePolicy: { current: vi.fn().mockResolvedValue(policy) } });
    prisma.modelDefinition.count.mockResolvedValue(0);
    const unavailable = await service.customerPreflight(scope, {
      title: "通用活动",
      prompt: "分享授权门店资料",
    });
    expect(unavailable.checks.find(({ code }) => code === "RETRIEVAL_INDEX_READY")?.status).toBe(
      "BLOCKING",
    );
  });

  it.each([undefined, "", "   ", "短", "通用品牌活动要求"])(
    "requires a usable prompt for generic preflight: %s",
    async (prompt) => {
      const { service } = fixture();
      Object.assign(service, { medicalPlanning: { resolve: vi.fn().mockResolvedValue(null) } });
      const checked = await service.customerPreflight(scope, { title: "通用活动", prompt });
      expect(checked.checks.find(({ code }) => code === "MEDICAL_SELECTION")?.status).toBe(
        (prompt?.trim().length ?? 0) >= 4 ? "PASSED" : "BLOCKING",
      );
      if ((prompt?.trim().length ?? 0) < 4) expect(checked.ready).toBe(false);
    },
  );
  it.each(["QUESTION_CARD", "ORIGINAL_EDIT"] as const)(
    "freezes and accepts %s without an active IMAGE resource or receipt",
    async (imageMode) => {
      const { service, models, medicalPlan, prisma } = fixture(imageMode);
      const frozen = await models.freezeGenerationRoute("tenant", "enterprise", false);
      expect(frozen).toMatchObject({
        requiresImage: false,
        image: { fallbacks: [] },
        text: { primary: { modelId: "text" } },
      });
      const checked = await service.requireCampaignReady(scope, {
        title: "医疗选择计划",
        selection: medicalPlan,
        imageCount: 2,
        membershipIds: ["member"],
      });
      expect(checked.ready).toBe(true);
      expect(checked.estimatedCost).toBeLessThan(1);
      expect(checked.assessment?.qualification?.id).toBe("text-qualified");
      await expect(service.assertStillCurrent(prisma as never, checked)).resolves.toBeUndefined();
    },
  );
  it("still rejects ILLUSTRATION and legacy generation when IMAGE is disabled", async () => {
    const { service, models, medicalPlan } = fixture("ILLUSTRATION");
    expect(
      (await service.customerPreflight(scope, { title: "示意插画", selection: medicalPlan })).ready,
    ).toBe(false);
    await expect(models.freezeGenerationRoute("tenant", "enterprise")).rejects.toThrow("disabled");
  });
  it("never substitutes image independence for valid TEXT qualification", async () => {
    const { service, medicalPlan, prisma } = fixture();
    prisma.modelRouteQualification.findFirst.mockResolvedValue(null as never);
    expect(
      (await service.customerPreflight(scope, { title: "问题卡", selection: medicalPlan })).ready,
    ).toBe(false);
  });
});
