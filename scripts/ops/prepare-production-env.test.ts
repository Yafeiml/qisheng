import { describe, expect, it } from "vitest";
import { applyStorageEnvironment } from "./prepare-production-env.mjs";

describe("production environment storage selection", () => {
  it("writes only local storage configuration and removes stale S3 connection secrets", () => {
    const values = {
      DATABASE_URL: "postgresql://example.invalid/test",
      OBJECT_STORAGE_ENDPOINT: "https://storage.example.invalid",
      OBJECT_STORAGE_REGION: "old-region",
      OBJECT_STORAGE_BUCKET: "old-bucket",
      OBJECT_STORAGE_ACCESS_KEY: "obsolete-access",
      OBJECT_STORAGE_SECRET_KEY: "obsolete-secret",
      OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
      OBJECT_STORAGE_PROVIDER: "S3",
    };
    applyStorageEnvironment(values, {
      provider: "LOCAL",
      rootDirectory: "/var/lib/qisheng/storage",
      signingKey: "independent-local-signing-key-32-characters",
    });
    expect(values).toEqual({
      DATABASE_URL: "postgresql://example.invalid/test",
      OBJECT_STORAGE_PROVIDER: "LOCAL",
      OBJECT_STORAGE_LOCAL_ROOT: "/var/lib/qisheng/storage",
    });
  });

  it.each([undefined, "S3"] as const)("preserves S3 fields for provider %s", (provider) => {
    const values = {
      OBJECT_STORAGE_PROVIDER: "LOCAL",
      OBJECT_STORAGE_LOCAL_ROOT: "/stale/local/root",
      ADMIN_WEB_ORIGIN: "https://app.example.invalid",
    };
    applyStorageEnvironment(values, {
      provider,
      endpoint: "https://storage.example.invalid",
      region: "test-region",
      bucket: "private-test-bucket",
      accessKeyId: "sample-access",
      secretAccessKey: "sample-secret",
      forcePathStyle: true,
    });
    expect(values).toEqual({
      ADMIN_WEB_ORIGIN: "https://app.example.invalid",
      OBJECT_STORAGE_PROVIDER: "S3",
      OBJECT_STORAGE_ENDPOINT: "https://storage.example.invalid",
      OBJECT_STORAGE_REGION: "test-region",
      OBJECT_STORAGE_BUCKET: "private-test-bucket",
      OBJECT_STORAGE_ACCESS_KEY: "sample-access",
      OBJECT_STORAGE_SECRET_KEY: "sample-secret",
      OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
    });
  });
});
