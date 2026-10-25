import "reflect-metadata";
import { ProviderInvocationError } from "@xhs-agentic/ai-gateway";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelProviderHealthService } from "./model-provider-health.service";
import { configurationFingerprint, ModelQualificationService } from "./model-qualification.service";

const mocks = vi.hoisted(() => ({ factory: vi.fn(), probe: vi.fn() }));
vi.mock("@xhs-agentic/ai-gateway", async (original) => ({
  ...(await original<typeof import("@xhs-agentic/ai-gateway")>()),
  createRuntimeProviderWithApiKey: mocks.factory,
}));
vi.mock("@xhs-agentic/network-security", () => ({ withPublicHttpResponse: mocks.probe }));

function fixture() {
  const provider = {
    id: "provider",
    baseUrl: "https://provider.example/v1",
    protocol: "OPENAI_COMPATIBLE",
    activeCredentialId: "credential",
    activeCredential: { status: "ACTIVE" },
    status: "ACTIVE",
    synthetic: false,
    timeoutMs: 60000,
    updatedAt: new Date(),
    healthStatus: "HEALTHY",
    lastHealthCheckedAt: new Date(0),
    circuitState: "CLOSED",
    circuitOpenUntil: new Date(Date.now() + 60_000),
    circuitProbeExpiresAt: new Date(Date.now() + 120_000),
  };
  const model = (id: string, capabilities: string[], metadata: object) => ({
    id,
    externalModelId: id,
    providerId: provider.id,
    provider,
    capabilities,
    metadata,
    status: "ACTIVE",
    synthetic: false,
    tier: "STANDARD",
  });
  const route = {
    id: "route",
    scopeType: "PLATFORM",
    scopeId: "platform",
    maxAttemptsPerModel: 1,
    textModelId: "text",
    imageModelId: "image",
    textFallbackModelIds: [],
    imageFallbackModelIds: [],
    textModel: model("text", ["TEXT"], { inputCostPerMillionUnits: 1 }),
    imageModel: model("image", ["IMAGE"], { imageCost: 0.25 }),
  };
  const text = vi.fn().mockResolvedValue({
    text: "READY",
    usage: { estimatedCost: 0.01 },
    finishReason: "stop",
    providerRequestId: "text-1",
  });
  const image = vi.fn().mockResolvedValue({
    bytes: new Uint8Array([137, 80, 78, 71]),
    mimeType: "image/png",
    usage: { estimatedCost: 0.25 },
    providerRequestId: "image-1",
  });
  const storage = vi.fn().mockResolvedValue({ byteSize: 4, checksum: "checksum" });
  mocks.factory.mockResolvedValue({ text: { generate: text }, image: { generate: image } });
  const transaction = {
    modelProviderHealthCheck: { create: vi.fn().mockResolvedValue({ createdAt: new Date() }) },
    modelProvider: {
      updateMany: vi.fn().mockImplementation(({ data }) => {
        Object.assign(provider, data);
        return { count: 1 };
      }),
    },
    modelRouteQualification: { create: vi.fn().mockImplementation(({ data }) => data) },
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    modelProvider: {
      findUnique: vi.fn().mockResolvedValue(provider),
      findMany: vi.fn().mockResolvedValue([provider]),
    },
    modelRouteQualification: {
      findFirst: vi.fn().mockResolvedValue({
        id: "passed",
        checkedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        estimatedCost: 0.26,
        status: "PASSED",
        storageVerified: true,
      }),
    },
    auditLog: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    modelRouteIncident: { findFirst: vi.fn().mockResolvedValue(null) },
    modelRoute: { findUnique: vi.fn().mockResolvedValue(route) },
    modelDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: (fn: (client: typeof transaction) => unknown) => fn(transaction),
  };
  const service = new ModelQualificationService(
    prisma as never,
    { requireSaasAdmin: () => ({ userId: "admin", scope: { type: "PLATFORM" } }) } as never,
    { decrypt: () => "secret-not-for-diagnostics" } as never,
    { verifyImageRoundTrip: storage } as never,
    { current: async () => ({ routeQualificationMaxAgeSeconds: 86400 }) } as never,
    new ModelProviderHealthService(prisma as never, { decrypt: () => "test-key" } as never),
  );
  return { service, text, image, storage, route, provider, prisma, transaction };
}

describe("qualification step diagnostics", () => {
  it("qualifies TEXT alone while unused IMAGE is disabled, without image or storage calls", async () => {
    const f = fixture();
    f.route.imageModel.status = "DISABLED";
    const result = await f.service.qualify("route", false);
    expect(result).toMatchObject({
      status: "PASSED",
      storageVerified: false,
      estimatedCost: 0.01,
      diagnostics: {
        requiredCapabilities: ["TEXT"],
        steps: { TEXT: "PASSED", IMAGE: "NOT_RUN", STORAGE: "NOT_RUN" },
      },
    });
    expect(f.text).toHaveBeenCalledOnce();
    expect(f.image).not.toHaveBeenCalled();
    expect(f.storage).not.toHaveBeenCalled();
  });

  it("assesses and freezes current TEXT qualification when IMAGE capability is unavailable", async () => {
    const f = fixture();
    f.route.imageModel.status = "DISABLED";
    f.route.imageModel.capabilities = [];
    const fingerprint = configurationFingerprint(
      f.route as never,
      [f.route.textModel] as never,
      false,
    );
    f.prisma.modelRouteQualification.findFirst.mockResolvedValue({
      id: "text-passed",
      checkedAt: new Date(0),
      estimatedCost: 0.01,
      status: "PASSED",
      storageVerified: false,
      configurationFingerprint: fingerprint,
      diagnostics: {
        textConfigurationFingerprint: fingerprint,
        requiredCapabilities: ["TEXT"],
        steps: { TEXT: "PASSED", IMAGE: "NOT_RUN" },
      },
    } as never);
    const policy = { providerHealthMaxAgeSeconds: 900 } as never;
    const assessment = await f.service.assessRoute("route", policy, new Date(), false);
    expect(assessment.eligible).toBe(true);
    expect(assessment.qualification?.id).toBe("text-passed");
    await expect(
      f.service.assertCurrent(
        {
          routeId: "route",
          configurationFingerprint: assessment.configurationFingerprint,
          deliveryMode: "DEVELOPMENT",
          qualificationId: "text-passed",
          requiresImage: false,
        },
        policy,
      ),
    ).resolves.toBeUndefined();
    expect((await f.service.assessRoute("route", policy)).eligible).toBe(false);
    expect(f.image).not.toHaveBeenCalled();
  });

  it("reuses an old complete receipt only when its fingerprint still proves the TEXT configuration", async () => {
    const f = fixture();
    const legacy = configurationFingerprint(
      f.route as never,
      [f.route.textModel, f.route.imageModel] as never,
    );
    f.route.imageModel.status = "DISABLED";
    f.prisma.modelRouteQualification.findFirst.mockResolvedValue({
      id: "legacy-passed",
      checkedAt: new Date(0),
      estimatedCost: 0.26,
      status: "PASSED",
      storageVerified: true,
      configurationFingerprint: legacy,
      diagnostics: null,
    } as never);
    const assessment = await f.service.assessRoute(
      "route",
      { providerHealthMaxAgeSeconds: 900 } as never,
      new Date(),
      false,
    );
    expect(assessment.eligible).toBe(true);
    expect(f.prisma.modelRouteQualification.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      OR: expect.arrayContaining([
        expect.objectContaining({
          AND: expect.arrayContaining([{ configurationFingerprint: legacy }]),
        }),
      ]),
    });
    const oldTextFingerprint = assessment.configurationFingerprint;
    f.route.textModel.metadata = { inputCostPerMillionUnits: 9 };
    expect(
      configurationFingerprint(f.route as never, [f.route.textModel] as never, false),
    ).not.toBe(oldTextFingerprint);
    f.prisma.modelRouteQualification.findFirst.mockResolvedValue(null as never);
    expect(
      (
        await f.service.assessRoute(
          "route",
          { providerHealthMaxAgeSeconds: 900 } as never,
          new Date(),
          false,
        )
      ).eligible,
    ).toBe(false);
  });

  it("does not let a later TEXT failure reuse a passed capability receipt", async () => {
    const f = fixture();
    const fingerprint = configurationFingerprint(
      f.route as never,
      [f.route.textModel] as never,
      false,
    );
    f.prisma.modelRouteQualification.findFirst.mockResolvedValue({
      id: "failed-text",
      checkedAt: new Date(),
      estimatedCost: 0.01,
      status: "FAILED",
      storageVerified: false,
      configurationFingerprint: fingerprint,
      diagnostics: { textConfigurationFingerprint: fingerprint, steps: { TEXT: "FAILED" } },
    } as never);
    expect(
      (
        await f.service.assessRoute(
          "route",
          { providerHealthMaxAgeSeconds: 900 } as never,
          new Date(),
          false,
        )
      ).eligible,
    ).toBe(false);
  });
  it("reuses proved TEXT after a full qualification fails only at IMAGE", async () => {
    const f = fixture();
    f.image.mockRejectedValue(new Error("IMAGE unsupported"));
    const receipt = await f.service.qualify("route");
    expect(receipt.status).toBe("FAILED");
    f.route.imageModel.status = "DISABLED";
    f.prisma.modelRouteQualification.findFirst.mockResolvedValue(receipt as never);
    const assessment = await f.service.assessRoute(
      "route",
      { providerHealthMaxAgeSeconds: 900 } as never,
      new Date(),
      false,
    );
    expect(assessment.eligible).toBe(true);
    expect(f.text).toHaveBeenCalledOnce();
    expect(f.image).toHaveBeenCalledOnce();
  });
  it("ignores IMAGE exhausted outcomes for TEXT-only plans while retaining TEXT failures", async () => {
    const f = fixture();
    const fingerprint = configurationFingerprint(
      f.route as never,
      [f.route.textModel] as never,
      false,
    );
    f.prisma.modelRouteQualification.findFirst.mockResolvedValue({
      id: "text-pass",
      checkedAt: new Date(0),
      estimatedCost: 0.01,
      status: "PASSED",
      storageVerified: false,
      configurationFingerprint: fingerprint,
      diagnostics: { textConfigurationFingerprint: fingerprint, steps: { TEXT: "PASSED" } },
    } as never);
    const failures = Array.from({ length: 3 }, () => ({
      action: "model-route.runtime.exhausted",
      createdAt: new Date(),
    }));
    f.prisma.auditLog.findMany.mockImplementation(async ({ where }) =>
      where.AND.some(
        (filter: { metadata?: { equals: string } }) => filter.metadata?.equals === "IMAGE",
      )
        ? failures
        : [],
    );
    expect(
      (
        await f.service.assessRoute(
          "route",
          { providerHealthMaxAgeSeconds: 900 } as never,
          new Date(),
          false,
        )
      ).eligible,
    ).toBe(true);
    f.prisma.auditLog.findMany.mockResolvedValue(failures as never);
    expect(
      (
        await f.service.assessRoute(
          "route",
          { providerHealthMaxAgeSeconds: 900 } as never,
          new Date(),
          false,
        )
      ).eligible,
    ).toBe(false);
  });
  it("keeps a passed unchanged configuration eligible after the old daily expiry", async () => {
    const f = fixture();
    f.prisma.modelRouteQualification.findFirst.mockResolvedValue({
      id: "old-passed",
      checkedAt: new Date(0),
      expiresAt: new Date(1),
      estimatedCost: 0.26,
      status: "PASSED",
      storageVerified: true,
    });
    const assessment = await f.service.assessRoute("route", {
      providerHealthMaxAgeSeconds: 900,
    } as never);
    expect(assessment.eligible).toBe(true);
    expect(assessment.qualification?.expiresAt).toBeNull();
    expect(f.prisma.modelRouteQualification.findFirst.mock.calls[0]?.[0].where).not.toHaveProperty(
      "expiresAt",
    );
    expect(f.image).not.toHaveBeenCalled();
  });

  it("requires revalidation only after three terminal model failures, scoped separately by capability", async () => {
    const f = fixture();
    f.prisma.auditLog.findMany.mockImplementation(async ({ where }) =>
      where.AND.some(
        (filter: { metadata: { equals: string } }) => filter.metadata.equals === "IMAGE",
      )
        ? Array.from({ length: 3 }, () => ({
            action: "model-route.runtime.exhausted",
            createdAt: new Date(),
          }))
        : [{ action: "model-route.runtime.succeeded", createdAt: new Date() }],
    );
    const assessment = await f.service.assessRoute("route", {
      providerHealthMaxAgeSeconds: 900,
    } as never);
    expect(assessment.eligible).toBe(false);
    expect(assessment.qualification?.id).toBe("passed");
    expect(assessment.runtimeHealth).toMatchObject({
      textFailures: 0,
      imageFailures: 3,
      state: "REVALIDATION_REQUIRED",
    });
    expect(assessment.reasons.map(({ code }) => code)).toContain(
      "ROUTE_RUNTIME_REVALIDATION_REQUIRED",
    );
    expect(f.image).not.toHaveBeenCalled();
    expect(f.text).not.toHaveBeenCalled();
  });

  it("does not reuse an older pass after the current configuration's latest validation failed", async () => {
    const f = fixture();
    f.prisma.modelRouteQualification.findFirst.mockResolvedValue({
      id: "failed",
      status: "FAILED",
      checkedAt: new Date(),
      storageVerified: false,
      estimatedCost: 0,
      expiresAt: new Date(),
    });
    const assessment = await f.service.assessRoute("route", {
      providerHealthMaxAgeSeconds: 900,
    } as never);
    expect(assessment.eligible).toBe(false);
    expect(f.prisma.modelRouteQualification.findFirst.mock.calls[0]?.[0].where).not.toHaveProperty(
      "status",
    );
  });
  it("automatically refreshes an expired connection before generation without repeating qualification", async () => {
    const f = fixture();
    const assessment = await f.service.assessRoute("route", {
      providerHealthMaxAgeSeconds: 900,
    } as never);
    expect(assessment.eligible).toBe(true);
    expect(assessment.qualification?.id).toBe("passed");
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    expect(f.text).not.toHaveBeenCalled();
    expect(f.image).not.toHaveBeenCalled();
    expect(f.storage).not.toHaveBeenCalled();
  });

  it.each(["circuit"])(
    "still blocks a real %s failure after automatic refresh",
    async (failure) => {
      const f = fixture();
      if (failure === "connection") mocks.probe.mockResolvedValue({ ok: false, status: 401 });
      else f.provider.circuitState = "OPEN";
      const assessment = await f.service.assessRoute("route", {
        providerHealthMaxAgeSeconds: 900,
      } as never);
      expect(assessment.eligible).toBe(false);
      expect(assessment.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "PROVIDER_CIRCUIT_OPEN",
          }),
        ]),
      );
      expect(f.text).not.toHaveBeenCalled();
      expect(f.image).not.toHaveBeenCalled();
    },
  );

  it.each(["OPEN", "HALF_OPEN"])(
    "allows recovery after %s cooldown or probe lease expires",
    async (state) => {
      const f = fixture();
      f.provider.circuitState = state;
      f.provider.circuitOpenUntil = new Date(0);
      f.provider.circuitProbeExpiresAt = new Date(0);
      expect(
        (await f.service.assessRoute("route", { providerHealthMaxAgeSeconds: 900 } as never))
          .eligible,
      ).toBe(true);
    },
  );

  it("does not gate a validated route on a single failed connectivity probe", async () => {
    const f = fixture();
    mocks.probe.mockResolvedValue({ ok: false, status: 503 });
    const result = await f.service.assessRoute("route", {
      providerHealthMaxAgeSeconds: 900,
    } as never);
    expect(result.eligible).toBe(true);
    expect(f.image).not.toHaveBeenCalled();
  });

  it("rechecks failures inside the task admission transaction", async () => {
    const f = fixture();
    const policy = { providerHealthMaxAgeSeconds: 900 } as never;
    const before = await f.service.assessRoute("route", policy);
    f.prisma.auditLog.findMany.mockResolvedValue(
      Array.from({ length: 3 }, () => ({
        action: "model-route.runtime.exhausted",
        createdAt: new Date(),
      })),
    );
    await expect(
      f.service.assertCurrent(
        {
          routeId: "route",
          configurationFingerprint: before.configurationFingerprint,
          deliveryMode: "PRODUCTION",
          qualificationId: "passed",
        },
        policy,
      ),
    ).rejects.toThrow("模型连续失败");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.probe.mockResolvedValue({ ok: true, status: 200 });
  });

  it("retains passed text and unsupported image details without running storage or retrying", async () => {
    const f = fixture();
    f.image.mockRejectedValue(
      new ProviderInvocationError("Provider request failed", "GW_REQUEST_NOT_SUPPORTED", false, {
        httpStatus: 404,
        requestPath: "/images/generations",
        requestId: "req-1",
        upstreamStage: "cpa_absorption_pending",
      }),
    );
    const result = await f.service.qualify("route");
    expect(result).toMatchObject({
      status: "FAILED",
      storageVerified: false,
      estimatedCost: 0.01,
      diagnostics: {
        failureStep: "IMAGE",
        steps: {
          CONFIGURATION: "PASSED",
          CONNECTION: "PASSED",
          TEXT: "PASSED",
          IMAGE: "FAILED",
          STORAGE: "NOT_RUN",
        },
        request: { httpStatus: 404, requestPath: "/images/generations", requestId: "req-1" },
      },
    });
    expect(result.errorMessage).toContain("图片生成失败");
    expect(result.errorMessage).toContain("不能据此认定 API Key 错误");
    expect(result.textLatencyMs).not.toBeNull();
    expect(result.imageLatencyMs).toBeNull();
    expect(f.text).toHaveBeenCalledTimes(1);
    expect(f.image).toHaveBeenCalledTimes(1);
    expect(f.storage).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret-not-for-diagnostics");
  });

  it.each(["TEXT", "STORAGE", "CONNECTION"] as const)(
    "attributes %s failure without claiming later steps passed",
    async (step) => {
      const f = fixture();
      if (step === "CONNECTION") mocks.probe.mockResolvedValue({ ok: false, status: 401 });
      else (step === "TEXT" ? f.text : f.storage).mockRejectedValue(new Error("Failed"));
      const result = await f.service.qualify("route");
      expect(result.status).toBe("FAILED");
      expect(result.diagnostics).toMatchObject({ failureStep: step, steps: { [step]: "FAILED" } });
      if (step !== "STORAGE") expect(f.image).not.toHaveBeenCalled();
      if (step === "CONNECTION") expect(f.text).not.toHaveBeenCalled();
    },
  );

  it("uses separate image pricing on a shared provider and passes only after storage", async () => {
    const f = fixture();
    const result = await f.service.qualify("route");
    expect(result).toMatchObject({
      status: "PASSED",
      storageVerified: true,
      estimatedCost: 0.26,
      diagnostics: { steps: { TEXT: "PASSED", IMAGE: "PASSED", STORAGE: "PASSED" } },
    });
    expect(mocks.factory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ modelPricing: { image: { imageCost: 0.25 } } }),
      expect.any(String),
    );
    expect(f.image).toHaveBeenCalledWith(
      "image",
      expect.objectContaining({ width: 1024, height: 1536 }),
    );
  });
});
