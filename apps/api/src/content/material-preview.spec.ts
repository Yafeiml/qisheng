import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import type { StorageQuotaService } from "../resource-policy/storage-quota.service";
import type { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import { MaterialIngestionService } from "./material-ingestion.service";
import type { MaterialIngestionQueueService } from "./material-ingestion-queue.service";
import type { MaterialStorageService } from "./material-storage.service";

const scope = { tenantId: "tenant-1", enterpriseId: "enterprise-1" };

function setup(mimeType: string, source: Uint8Array) {
  const findFirst = vi.fn().mockResolvedValue({ objectKey: "materials/test", mimeType });
  const readPreviewSource = vi.fn().mockResolvedValue(source);
  const signedPreview = vi.fn().mockResolvedValue("https://files.example/original");
  const service = new MaterialIngestionService(
    { materialArtifact: { findFirst } } as unknown as PrismaService,
    {
      requireSaasAdmin: () => ({
        scope: { type: "ENTERPRISE", ...scope },
      }),
    } as unknown as RequestAccessContext,
    {} as TenantCapabilityService,
    {} as StorageQuotaService,
    {} as MaterialIngestionQueueService,
    { readPreviewSource, signedPreview } as unknown as MaterialStorageService,
  );
  return { findFirst, readPreviewSource, service, signedPreview };
}

describe("material preview", () => {
  it("returns a bounded WebP preview without inlining the original image", async () => {
    const pixels = randomBytes(1000 * 800 * 3);
    const source = await sharp(pixels, { raw: { width: 1000, height: 800, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();
    const { readPreviewSource, service } = setup("image/jpeg", source);

    const result = await service.previewArtifact(scope, "material-1", "artifact-1");
    expect(readPreviewSource).toHaveBeenCalledWith("materials/test", 25 * 1024 * 1024);
    expect(result.url).toBe("https://files.example/original");
    expect(result.optimizedDataUrl).toMatch(/^data:image\/webp;base64,/);
    const thumbnail = Buffer.from(result.optimizedDataUrl?.split(",")[1] ?? "", "base64");
    expect(thumbnail.byteLength).toBeLessThan(source.byteLength);
    expect(thumbnail.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect((await sharp(thumbnail).metadata()).width).toBeLessThanOrEqual(960);
  });

  it("does not download documents to build previews", async () => {
    const { readPreviewSource, service } = setup("application/pdf", new Uint8Array());
    expect(await service.previewArtifact(scope, "material-1", "artifact-1")).toMatchObject({
      optimizedDataUrl: null,
      url: "https://files.example/original",
    });
    expect(readPreviewSource).not.toHaveBeenCalled();
  });

  it("does not fall back to the original image when thumbnail creation fails", async () => {
    const { service } = setup("image/png", new Uint8Array([0, 1, 2]));
    const result = await service.previewArtifact(scope, "material-1", "artifact-1");
    expect(result.optimizedDataUrl).toBeNull();
    expect(result.url).toBe("https://files.example/original");
  });

  it("enforces scope and artifact status before accessing storage", async () => {
    const { findFirst, readPreviewSource, service, signedPreview } = setup(
      "image/png",
      new Uint8Array(),
    );
    await expect(
      service.previewArtifact({ ...scope, enterpriseId: "other" }, "material-1", "artifact-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findFirst).not.toHaveBeenCalled();
    findFirst.mockResolvedValueOnce(null);
    await expect(service.previewArtifact(scope, "material-1", "artifact-1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          enterpriseId: scope.enterpriseId,
          tenantId: scope.tenantId,
          status: { in: ["STORED", "VERIFIED"] },
        }),
      }),
    );
    expect(readPreviewSource).not.toHaveBeenCalled();
    expect(signedPreview).not.toHaveBeenCalled();
  });
});
