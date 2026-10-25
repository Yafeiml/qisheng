import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalObjectStorage, S3CompatibleObjectStorage } from "@xhs-agentic/object-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformAssetDeliveryService } from "./platform-asset-delivery.service";
import { PlatformObjectStorageService } from "./platform-object-storage.service";
import { PlatformSettingsService } from "./platform-settings.service";

afterEach(() => vi.unstubAllEnvs());

describe("platform storage provider selection", () => {
  it("constructs local storage without resolving any S3 credentials and uses same-origin delivery", async () => {
    vi.stubEnv("ADMIN_JWT_SECRET", randomBytes(32).toString("hex"));
    vi.stubEnv("OBJECT_STORAGE_LOCAL_ROOT", join(tmpdir(), "qisheng-local-provider"));
    const resolveMany = vi.fn(async (keys: string[]) => {
      expect(keys).toEqual(["storage.provider", "storage.signed_url_ttl_seconds"]);
      return new Map([
        ["storage.provider", { value: "LOCAL" }],
        ["storage.signed_url_ttl_seconds", { value: 900 }],
      ]);
    });
    const service = new PlatformObjectStorageService({ resolveMany } as never);
    const current = await service.current();
    expect(current.provider).toBe("LOCAL");
    expect(current.storage).toBeInstanceOf(LocalObjectStorage);
    const settings = {
      string: vi.fn(() => {
        throw new Error("Cloud delivery must not be resolved");
      }),
    };
    const delivery = new PlatformAssetDeliveryService(settings as never, service);
    await expect(delivery.signedUrl("tenants/tenant/materials/material/file.png")).resolves.toMatch(
      /^\/api\/storage\/objects\//,
    );
    expect(settings.string).not.toHaveBeenCalled();
  });

  it("preserves S3 as the compatibility default for installations without a provider setting", async () => {
    const values = new Map<string, unknown>([
      ["storage.signed_url_ttl_seconds", 900],
      ["storage.access_key_id", "access"],
      ["storage.secret_access_key", "private-key"],
      ["storage.bucket", "old-bucket"],
      ["storage.region", "us-east-1"],
      ["storage.force_path_style", true],
    ]);
    const service = new PlatformObjectStorageService({
      resolveMany: async (keys: string[]) =>
        new Map(keys.map((key) => [key, { value: values.get(key) }])),
    } as never);
    const current = await service.current();
    expect(current.provider).toBe("S3");
    expect(current.storage).toBeInstanceOf(S3CompatibleObjectStorage);
  });

  it("rejects cloud lifecycle management for local storage without accessing S3", async () => {
    const service = new PlatformSettingsService(
      {} as never,
      { requireSaasAdmin: () => ({ scope: { type: "PLATFORM" } }) } as never,
      {} as never,
      {} as never,
      {} as never,
      { current: async () => ({ provider: "LOCAL", storage: {} }) } as never,
    );
    await expect(service.applyStorageLifecycle("test")).rejects.toMatchObject({
      response: { code: "STORAGE_MANAGEMENT_UNSUPPORTED" },
    });
  });
});

const switchModels = [
  "materialArtifact",
  "generatedImage",
  "storageReservation",
  "employeeContentRevision",
  "generationRun",
  "generationWorkItem",
  "materialIngestionJob",
  "generationLabRun",
] as const;

function switchFixture(blockedModel?: (typeof switchModels)[number], current = "S3") {
  const counts = Object.fromEntries(
    switchModels.map((model) => [
      model,
      { count: vi.fn().mockResolvedValue(blockedModel === model ? 1 : 0) },
    ]),
  ) as Record<(typeof switchModels)[number], { count: ReturnType<typeof vi.fn> }>;
  const transaction = {
    ...counts,
    platformSetting: {
      upsert: vi.fn().mockResolvedValue({
        secretLastFour: null,
        updatedAt: new Date(),
        updatedBy: "admin",
        version: 1,
      }),
    },
    auditLog: { create: vi.fn() },
  };
  const service = new PlatformSettingsService(
    { $transaction: (run: (tx: unknown) => unknown) => run(transaction) } as never,
    { requireSaasAdmin: () => ({ userId: "admin", scope: { type: "PLATFORM" } }) } as never,
    {
      resolve: async () => ({ value: current }),
      resolveMany: async () => new Map([["storage.provider", { value: current }]]),
    } as never,
    {} as never,
    {} as never,
    { invalidate: vi.fn() } as never,
  );
  vi.spyOn(service, "list").mockResolvedValue({
    groups: [{ settings: [{ key: "storage.provider", value: "LOCAL" }] }],
  } as never);
  return { service, transaction };
}

describe("storage provider switch protection", () => {
  it.each(switchModels)(
    "rejects switching while %s contains stored data or active work",
    async (model) => {
      const { service, transaction } = switchFixture(model);
      await expect(
        service.update("storage.provider", { value: "LOCAL", reason: "change storage" }),
      ).rejects.toMatchObject({ response: { code: "OBJECT_STORAGE_SWITCH_REQUIRES_MIGRATION" } });
      expect(transaction.platformSetting.upsert).not.toHaveBeenCalled();
      expect(transaction.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("allows an empty installation to select local storage without clearing S3 settings", async () => {
    const { service, transaction } = switchFixture();
    await expect(
      service.update("storage.provider", { value: "LOCAL", reason: "choose local storage" }),
    ).resolves.toMatchObject({ key: "storage.provider", value: "LOCAL" });
    expect(transaction.platformSetting.upsert).toHaveBeenCalledOnce();
    expect(transaction.platformSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "storage.provider" } }),
    );
    expect(transaction.storageReservation.count).toHaveBeenCalledWith({
      where: {
        OR: [{ status: "RESERVED" }, { status: { not: "RELEASED" }, storageKey: { not: null } }],
      },
    });
  });

  it("allows saving the existing provider without blocking on existing files", async () => {
    const { service, transaction } = switchFixture("materialArtifact", "LOCAL");
    await service.update("storage.provider", { value: "LOCAL", reason: "keep existing storage" });
    expect(transaction.platformSetting.upsert).toHaveBeenCalledOnce();
  });
});
