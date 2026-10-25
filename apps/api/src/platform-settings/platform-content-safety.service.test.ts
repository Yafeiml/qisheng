import "reflect-metadata";
import { ModelCredentialCipher, modelCredentialAssociatedData } from "@xhs-agentic/ai-gateway";
import { ContentSafetyInvocationError, probeContentSafety } from "@xhs-agentic/content-safety";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformContentSafetyService } from "./platform-content-safety.service";
import { PlatformSettingCrypto } from "./platform-setting-crypto";

vi.mock("@xhs-agentic/content-safety", async (original) => ({
  ...(await original<typeof import("@xhs-agentic/content-safety")>()),
  probeContentSafety: vi.fn(),
}));

function fixture() {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("GENERATION_DELIVERY_MODE", "DEVELOPMENT");
  const encrypt = (key: string) => ({
    ...ModelCredentialCipher.fromEnvironment().encrypt(
      key,
      modelCredentialAssociatedData("provider", "credential"),
    ),
    id: "credential",
    status: "ACTIVE",
  });
  const provider = {
    id: "provider",
    name: "示例审核供应商",
    code: "cloud",
    baseUrl: "https://models.example.com/v1",
    status: "ACTIVE",
    synthetic: false,
    protocol: "OPENAI_COMPATIBLE",
    activeCredential: encrypt("provider-key-123456"),
  };
  const settings = new Map(
    Object.entries({
      mode: "MODEL",
      model_provider_id: "provider",
      model: "vision-model",
      timeout_ms: 30000,
      endpoint: "https://unused.example.com/v1",
      provider: "old",
      api_key: "unused-secret",
    }).map(([key, value]) => [`content_safety.${key}`, { value }]),
  );
  const receipts = new Map<string, boolean>();
  const prisma = {
    modelProvider: {
      findUnique: vi.fn(async () => provider),
      findMany: vi.fn(async () => [{ id: provider.id, name: provider.name }]),
    },
    auditLog: {
      findFirst: vi.fn(async (input) => {
        const fp = input.where.metadata.equals;
        return receipts.has(fp)
          ? { metadata: { success: receipts.get(fp) }, createdAt: new Date("2020-01-01") }
          : null;
      }),
      create: vi.fn(async (input) => {
        receipts.set(input.data.metadata.configurationFingerprint, input.data.metadata.success);
        return { id: "audit-test-123" };
      }),
    },
    $transaction: vi.fn(),
  };
  const principal = { userId: "admin", scope: { type: "PLATFORM" } };
  const service = new PlatformContentSafetyService(
    prisma as never,
    { requireSaasAdmin: () => principal } as never,
    { resolveMany: async () => new Map(settings) } as never,
    new PlatformSettingCrypto(),
  );
  return { service, settings, prisma, provider, receipts, principal, encrypt };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(probeContentSafety).mockReset();
});
describe("platform model content safety", () => {
  it("reuses a provider credential without exposing it and preserves old successful verification", async () => {
    const f = fixture();
    const current = await f.service.current();
    expect(current).toMatchObject({ mode: "MODEL", verified: false, configured: true });
    f.receipts.set(current.fingerprint, true);
    expect(await f.service.current()).toMatchObject({
      verified: true,
      checkedAt: "2020-01-01T00:00:00.000Z",
    });
    const publicConfig = JSON.stringify(await f.service.configuration());
    expect(publicConfig).not.toContain("provider-key-123456");
    expect(publicConfig).not.toContain("unused-secret");
  });
  it("invalidates a test after model changes, key rotation or a later failed test", async () => {
    const f = fixture();
    const initial = await f.service.current();
    f.receipts.set(initial.fingerprint, true);
    f.settings.set("content_safety.model", { value: "vision-2" });
    expect((await f.service.current()).verified).toBe(false);
    f.settings.set("content_safety.model", { value: "vision-model" });
    f.provider.activeCredential = f.encrypt("rotated-key-987654");
    expect((await f.service.current()).verified).toBe(false);
    f.provider.activeCredential = f.encrypt("provider-key-123456");
    f.receipts.set(initial.fingerprint, false);
    expect((await f.service.current()).verified).toBe(false);
  });
  it("rejects inactive or synthetic providers before saving", async () => {
    const f = fixture();
    f.provider.synthetic = true;
    await expect(
      f.service.save({
        mode: "MODEL",
        modelProviderId: "provider",
        model: "vision-model",
        timeoutMs: 30000,
      }),
    ).rejects.toThrow("供应商不可用");
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it("rejects non-platform configuration access", async () => {
    const f = fixture();
    f.principal.scope.type = "TENANT";
    await expect(f.service.configuration()).rejects.toThrow("平台管理员");
  });
  it("does not consider untested configuration production-ready", async () => {
    const f = fixture();
    vi.stubEnv("GENERATION_DELIVERY_MODE", "PRODUCTION");
    expect(await f.service.readiness()).toMatchObject({
      configured: false,
      verified: false,
      required: true,
    });
  });
  it.each([
    ["CONTENT_SAFETY_PROBE_FAILED", "neutral", "REVIEW", false, undefined],
    ["CONTENT_SAFETY_VISION_PROBE_FAILED", "image-risk", "PASS", false, undefined],
    ["CONTENT_SAFETY_HTTP_503", "image-risk", undefined, true, 503],
    ["CONTENT_SAFETY_NETWORK", "neutral", undefined, true, undefined],
  ] as const)(
    "records %s without losing the failure stage or exposing provider data",
    async (code, probeStage, decision, retryable, httpStatus) => {
      const f = fixture();
      vi.mocked(probeContentSafety).mockRejectedValue(
        new ContentSafetyInvocationError("private-provider-response", code, retryable, {
          provider: "private-provider",
          model: "private-model",
          providerRequestId: "request-123",
          probeStage,
          decision,
          httpStatus,
        }),
      );
      const response = await f.service
        .verifyForOperations("deployment probe")
        .catch((error) => error.getResponse());
      const failure = {
        code,
        probeStage,
        decision: decision ?? null,
        retryable,
        httpStatus: httpStatus ?? null,
        providerRequestId: "request-123",
      };
      expect(response).toMatchObject({ code, auditId: "audit-test-123", failure });
      expect(f.prisma.auditLog.create.mock.calls[0]?.[0]).toMatchObject({
        data: {
          actorType: "SYSTEM",
          metadata: {
            success: false,
            failure,
            policyVersion: "xhs-employee-medical-publishing-v3",
          },
        },
      });
      expect(JSON.stringify(response)).not.toContain("private-");
      expect(JSON.stringify(f.prisma.auditLog.create.mock.calls)).not.toContain("private-");
      expect((await f.service.current()).verified).toBe(false);
    },
  );
  it("does not expose arbitrary exceptions or provider error codes", async () => {
    const f = fixture();
    for (const error of [
      new Error("private-database-connection"),
      new ContentSafetyInvocationError("private-provider-response", "PRIVATE_KEY", false, {
        provider: "private-provider",
        providerRequestId: "Authorization: private-key",
      }),
    ]) {
      vi.mocked(probeContentSafety).mockRejectedValue(error);
      const response = await f.service.test("admin test").catch((reason) => reason.getResponse());
      expect(response).toMatchObject({
        code: "CONTENT_SAFETY_TEST_FAILED",
        failure: { code: "CONTENT_SAFETY_TEST_FAILED", providerRequestId: null },
      });
      expect(JSON.stringify(response)).not.toContain("private-");
    }
    expect(f.prisma.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      actorType: "USER",
      actorUserId: "admin",
    });
  });
  it("requires durable auditing even when the probe passes and preserves a primary failure code", async () => {
    const f = fixture();
    f.prisma.auditLog.create.mockRejectedValue(new Error("private-database-connection"));
    const passed = {
      categories: [],
      checkedAt: "2026-10-13T01:00:00.000Z",
      decision: "PASS",
      latencyMs: 3,
      provider: "cloud",
      providerRequestId: "request-123",
      imageRiskDetected: true,
    } as const;
    vi.mocked(probeContentSafety).mockResolvedValue(passed);
    const response = await f.service
      .verifyForOperations("deployment probe")
      .catch((error) => error.getResponse());
    expect(response).toMatchObject({ code: "CONTENT_SAFETY_TEST_AUDIT_FAILED", auditId: null });
    expect((await f.service.current()).verified).toBe(false);
    vi.mocked(probeContentSafety).mockRejectedValue(
      new ContentSafetyInvocationError("timeout", "CONTENT_SAFETY_TIMEOUT", true, {
        provider: "cloud",
        probeStage: "neutral",
      }),
    );
    const failed = await f.service
      .verifyForOperations("deployment probe")
      .catch((error) => error.getResponse());
    expect(failed).toMatchObject({
      code: "CONTENT_SAFETY_TEST_AUDIT_FAILED",
      failure: { code: "CONTENT_SAFETY_TIMEOUT", probeStage: "neutral" },
    });
    expect(JSON.stringify(failed)).not.toContain("private-");
  });
  it("stores successful probes as reusable receipts and rejects configuration drift", async () => {
    const f = fixture();
    const passed = {
      categories: [],
      checkedAt: "2026-10-13T01:00:00.000Z",
      decision: "PASS",
      latencyMs: 3,
      provider: "cloud",
      providerRequestId: "request-123",
      imageRiskDetected: true,
    } as const;
    vi.mocked(probeContentSafety).mockResolvedValue(passed);
    expect(await f.service.verifyForOperations("deployment probe")).toEqual({
      categoryCount: 0,
      checkedAt: passed.checkedAt,
      decision: "PASS",
      latencyMs: 3,
      provider: "cloud",
      imageRiskDetected: true,
    });
    expect((await f.service.current()).verified).toBe(true);
    const original = await f.service.current();
    vi.spyOn(f.service, "current")
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce({ ...original, fingerprint: "changed" });
    const response = await f.service
      .verifyForOperations("deployment probe")
      .catch((error) => error.getResponse());
    expect(response).toMatchObject({
      code: "CONTENT_SAFETY_CONFIGURATION_CHANGED",
      failure: { code: "CONTENT_SAFETY_CONFIGURATION_CHANGED" },
    });
    expect(f.receipts.get(original.fingerprint)).toBe(false);
  });
});
