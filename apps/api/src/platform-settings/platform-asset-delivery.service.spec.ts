import { createHash } from "node:crypto";
import { MemoryObjectStorage } from "@xhs-agentic/object-storage";
import { describe, expect, it } from "vitest";
import { PlatformAssetDeliveryService } from "./platform-asset-delivery.service";
import type { PlatformObjectStorageService } from "./platform-object-storage.service";
import type { PlatformSettingsReader } from "./platform-settings.reader";

describe("PlatformAssetDeliveryService", () => {
  it("creates a short-lived edge URL and serves only an untampered tenant object", async () => {
    const storage = new MemoryObjectStorage();
    const key = "tenants/tenant-a/campaigns/campaign-a/contents/content-a/1-image.png";
    const bytes = Buffer.from("private-image");
    await storage.put({
      bytes,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      key,
      mimeType: "image/png",
    });
    const values = new Map<string, string>([
      ["storage.delivery_base_url", "https://cdn.example.test"],
      ["storage.delivery_mode", "EDGE_SIGNED"],
      ["storage.delivery_signing_key", "edge-signing-key-that-is-at-least-32-characters"],
    ]);
    const service = new PlatformAssetDeliveryService(
      {
        string: async (settingKey: string) => values.get(settingKey) ?? "",
      } as unknown as PlatformSettingsReader,
      {
        current: async () => ({ signedUrlTtlSeconds: 900, storage }),
      } as unknown as PlatformObjectStorageService,
    );

    const url = await service.signedUrl(key);
    expect(url).toMatch(/^https:\/\/cdn\.example\.test\/assets\//u);
    const token = url.split("/assets/")[1];
    if (!token) throw new Error("Expected a signed asset token");
    await expect(service.read(token)).resolves.toMatchObject({
      byteSize: bytes.byteLength,
      contentType: "image/png",
    });
    await expect(service.read(`${token.slice(0, -1)}x`)).rejects.toThrow("Asset was not found");
  });

  it("keeps S3 signed delivery as the safe default", async () => {
    const storage = new MemoryObjectStorage();
    const key = "tenants/tenant-a/materials/material-a/artifact-a.txt";
    const bytes = Buffer.from("material");
    await storage.put({
      bytes,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      key,
      mimeType: "text/plain",
    });
    const service = new PlatformAssetDeliveryService(
      { string: async () => "S3_SIGNED" } as unknown as PlatformSettingsReader,
      {
        current: async () => ({ signedUrlTtlSeconds: 900, storage }),
      } as unknown as PlatformObjectStorageService,
    );
    await expect(service.signedUrl(key)).resolves.toContain("memory://object/");
  });
});
