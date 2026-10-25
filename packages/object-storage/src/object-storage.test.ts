import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryObjectStorage } from "./memory-storage";
import { generatedImageObjectKey } from "./object-key";

describe("generated image object storage", () => {
  it("builds tenant-scoped non-PII keys and verifies checksums", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const key = generatedImageObjectKey({
      campaignId: "campaign_1",
      checksum,
      employeeContentId: "content_1",
      mimeType: "image/png",
      sequence: 1,
      tenantId: "tenant_1",
    });
    const storage = new MemoryObjectStorage();
    const stored = await storage.put({ bytes, checksum, key, mimeType: "image/png" });

    expect(key).toBe(
      `tenants/tenant_1/campaigns/campaign_1/contents/content_1/1-${checksum.slice(0, 16)}.png`,
    );
    expect(stored).toMatchObject({ byteSize: 3, checksum, key });
    await expect(storage.head(key)).resolves.toMatchObject({
      byteSize: 3,
      checksum,
      contentType: "image/png",
    });
    await expect(storage.get(key, 3)).resolves.toEqual(bytes);
    await expect(
      storage.signedPutUrl({ byteSize: 3, key: "pending/material.txt", mimeType: "text/plain" }),
    ).resolves.toContain("memory://upload/");
    await expect(storage.signedGetUrl(key)).resolves.toContain("memory://object/");
    await storage.delete(key);
    await expect(storage.signedGetUrl(key)).rejects.toThrow("Object does not exist");
  });

  it("rejects traversal-like identifiers", () => {
    expect(() =>
      generatedImageObjectKey({
        campaignId: "../outside",
        checksum: "a".repeat(64),
        employeeContentId: "content",
        mimeType: "image/jpeg",
        sequence: 1,
        tenantId: "tenant",
      }),
    ).toThrow("unsupported characters");
  });
});
