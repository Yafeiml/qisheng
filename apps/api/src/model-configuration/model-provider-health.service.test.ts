import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelProviderHealthService } from "./model-provider-health.service";

const mocks = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("@xhs-agentic/network-security", () => ({ withPublicHttpResponse: mocks.probe }));
const policy = { providerHealthMaxAgeSeconds: 900 };

function fixture() {
  const provider = {
    id: "provider",
    updatedAt: new Date(),
    baseUrl: "https://models.example/v1/",
    activeCredential: { status: "ACTIVE" },
    activeCredentialId: "key-1",
    healthStatus: "HEALTHY",
    lastHealthCheckedAt: new Date(Date.now() - 901_000),
    status: "ACTIVE",
    synthetic: false,
    circuitState: "OPEN",
    timeoutMs: 60_000,
  };
  const check = vi.fn();
  const update = vi.fn(({ where, data }) => {
    if (where.updatedAt.getTime() !== provider.updatedAt.getTime()) return { count: 0 };
    Object.assign(provider, data, { updatedAt: new Date(provider.updatedAt.getTime() + 1) });
    return { count: 1 };
  });
  const prisma = {
    modelProvider: {
      findMany: vi.fn(async () =>
        provider.status === "ACTIVE" && !provider.synthetic ? [structuredClone(provider)] : [],
      ),
      findUnique: vi.fn(async () => structuredClone(provider)),
    },
    modelDefinition: { findMany: vi.fn(async () => [{ providerId: "provider" }]) },
    modelRoute: {
      findMany: vi.fn(async () => [
        {
          textModelId: "text",
          imageModelId: "image",
          textFallbackModelIds: ["fallback"],
          imageFallbackModelIds: [],
        },
      ]),
    },
    runtimePolicy: {
      findUnique: vi.fn(async () => ({
        ...policy,
        embeddingModelId: "embedding",
        materialAnalysisModelId: "vision",
      })),
    },
    auditLog: { create: vi.fn() },
    $transaction: async (run: (tx: unknown) => unknown) =>
      run({
        modelProvider: { updateMany: update },
        modelProviderHealthCheck: { create: check },
      }),
  };
  const service = new ModelProviderHealthService(
    prisma as never,
    { decrypt: () => "secret-key" } as never,
  );
  return { service, provider, prisma, check, update };
}

describe("automatic provider connection checks", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T08:00:00Z"));
    vi.clearAllMocks();
    mocks.probe.mockResolvedValue({ ok: true, status: 200 });
  });
  afterEach(() => vi.useRealTimers());

  it("refreshes once after cache expiry and preserves runtime circuit protection", async () => {
    const f = fixture();
    await f.service.ensureFresh(["provider", "provider"], policy);
    await f.service.ensureFresh(["provider"], policy);
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    expect(mocks.probe).toHaveBeenCalledWith(
      "https://models.example/v1/models",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
      expect.any(Object),
      expect.any(Function),
    );
    expect(f.provider.healthStatus).toBe("HEALTHY");
    expect(f.provider.circuitState).toBe("OPEN");
    expect(f.check).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ checkedBy: "system:connection-refresh" }),
      }),
    );
    expect(JSON.stringify(f.check.mock.calls)).not.toContain("secret-key");
    vi.setSystemTime(Date.now() + 900_000);
    await f.service.ensureFresh(["provider"], policy);
    expect(mocks.probe).toHaveBeenCalledTimes(2);
  });

  it("merges concurrent refreshes for the same provider", async () => {
    const f = fixture();
    await Promise.all(
      Array.from({ length: 10 }, () => f.service.ensureFresh(["provider"], policy)),
    );
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    expect(f.check).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 503])(
    "records HTTP %s and waits before retrying automatically",
    async (status) => {
      const f = fixture();
      mocks.probe.mockResolvedValue({ ok: false, status });
      await f.service.ensureFresh(["provider"], policy);
      await f.service.ensureFresh(["provider"], policy);
      expect(f.provider.healthStatus).toBe("UNHEALTHY");
      expect(mocks.probe).toHaveBeenCalledTimes(1);
      expect(f.check).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ httpStatus: status }) }),
      );
      vi.setSystemTime(Date.now() + 60_000);
      mocks.probe.mockResolvedValue({ ok: true, status: 200 });
      await f.service.ensureFresh(["provider"], policy);
      expect(f.provider.healthStatus).toBe("HEALTHY");
      expect(mocks.probe).toHaveBeenCalledTimes(2);
    },
  );

  it("sanitizes network errors and releases the probe after a timeout", async () => {
    const f = fixture();
    mocks.probe.mockRejectedValue(new DOMException("secret-key", "TimeoutError"));
    await f.service.ensureFresh(["provider"], policy);
    expect(f.check).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorCode: "TIMEOUT" }) }),
    );
    expect(JSON.stringify(f.check.mock.calls)).not.toContain("secret-key");
    mocks.probe.mockResolvedValue({ ok: true, status: 200 });
    const result = await f.service.testConnection("provider", "admin");
    expect(result.healthy).toBe(true);
    expect(f.prisma.auditLog.create).toHaveBeenCalled();
  });

  it("never applies an old probe to a changed credential or endpoint", async () => {
    const f = fixture();
    mocks.probe.mockImplementation(async () => {
      f.provider.updatedAt = new Date(Date.now() + 1);
      f.provider.activeCredentialId = "key-2";
      f.provider.healthStatus = "UNKNOWN";
      return { ok: true, status: 200 };
    });
    await expect(f.service.ensureFresh(["provider"], policy)).rejects.toThrow("已更新");
    expect(f.provider.healthStatus).toBe("UNKNOWN");
    expect(f.check).not.toHaveBeenCalled();
  });

  it.each(["disabled", "synthetic", "revoked"])(
    "skips %s providers during automatic checks",
    async (kind) => {
      const f = fixture();
      if (kind === "disabled") f.provider.status = "DISABLED";
      if (kind === "synthetic") f.provider.synthetic = true;
      if (kind === "revoked") f.provider.activeCredential.status = "REVOKED";
      await f.service.ensureFresh(["provider"], policy);
      expect(mocks.probe).not.toHaveBeenCalled();
    },
  );

  it("automatically checks changed settings even within the previous cache period", async () => {
    const f = fixture();
    f.provider.lastHealthCheckedAt = new Date();
    f.provider.healthStatus = "UNKNOWN";
    await f.service.ensureFresh(["provider"], policy);
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    expect(f.provider.healthStatus).toBe("HEALTHY");
  });

  it("includes all four configured model roles and route fallbacks", async () => {
    const f = fixture();
    await f.service.refreshConfigured();
    expect(f.prisma.modelDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["text", "image", "fallback", "embedding", "vision"] },
        }),
      }),
    );
    expect(mocks.probe).toHaveBeenCalledTimes(1);
  });
});
