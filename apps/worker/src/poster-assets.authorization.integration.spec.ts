import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@xhs-agentic/database";
import { MemoryObjectStorage } from "@xhs-agentic/object-storage";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { loadPosterAssets } from "./poster-assets";

it("rechecks generic image authorization, archived purpose and scene privacy when a queued task executes", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "http://invalid");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/dev_xhs_agentic")
    throw new Error("Poster authorization test requires the local dev_xhs_agentic database");
  const prisma = new PrismaClient();
  const storage = new MemoryObjectStorage();
  const get = vi.spyOn(storage, "get");
  let tenantId: string | undefined;
  try {
    const tenant = await prisma.tenant.create({
      data: { name: `poster-authorization-${randomUUID()}`, customerType: "SINGLE_ENTERPRISE" },
    });
    tenantId = tenant.id;
    const material = await prisma.material.create({
      data: {
        tenantId,
        scopeKey: "__tenant__",
        title: "通用场景照",
        content: "已授权场景照",
        createdBy: "poster-test",
        type: "IMAGE_REFERENCE",
        authorizationStatus: "AUTHORIZED",
      },
    });
    const bytes = await sharp({
      create: { width: 12, height: 8, channels: 3, background: "#dedede" },
    })
      .png()
      .toBuffer();
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `poster-test/${tenantId}/image.png`;
    await storage.put({ key: objectKey, bytes, checksum, mimeType: "image/png" });
    const artifact = await prisma.materialArtifact.create({
      data: {
        tenantId,
        materialId: material.id,
        scopeKey: "__tenant__",
        kind: "IMAGE_SOURCE",
        status: "STORED",
        objectKey,
        checksum,
        mimeType: "image/png",
        byteSize: bytes.length,
      },
    });
    const assets = [
      {
        artifactId: artifact.id,
        materialId: material.id,
        objectKey,
        checksum,
        mimeType: "image/png",
        description: "通用照片",
        usage: "REFERENCE" as const,
      },
    ];
    expect(await loadPosterAssets(prisma, storage, tenantId, assets)).toHaveLength(1);
    await expect(loadPosterAssets(prisma, storage, tenantId, assets, true)).rejects.toMatchObject({
      code: "REFERENCE_IMAGE_UNAVAILABLE",
    });
    const blockedUpdates: Prisma.MaterialUpdateInput[] = [
      { authorizationStatus: "REJECTED" },
      { status: "DISABLED" },
      { expiresAt: new Date(Date.now() - 60000) },
      { validFrom: new Date(Date.now() + 60000) },
      {
        structuredFacts: {
          medicalMaterial: { schemaVersion: "medical-material-v1", purpose: "ARCHIVE" },
        },
      },
    ];
    for (const data of blockedUpdates) {
      await prisma.material.update({
        where: { id: material.id },
        data: {
          authorizationStatus: "AUTHORIZED",
          status: "ACTIVE",
          expiresAt: null,
          validFrom: null,
          structuredFacts: Prisma.DbNull,
          ...data,
        },
      });
      get.mockClear();
      await expect(loadPosterAssets(prisma, storage, tenantId, assets)).rejects.toMatchObject({
        code: "REFERENCE_IMAGE_UNAVAILABLE",
      });
      expect(get).not.toHaveBeenCalled();
    }
    const scene = {
      schemaVersion: "medical-material-v1",
      purpose: "REAL_SCENE",
      sceneType: "ENVIRONMENT",
      privacyConfirmed: true,
    };
    await prisma.material.update({
      where: { id: material.id },
      data: { structuredFacts: { medicalMaterial: scene } },
    });
    await prisma.materialArtifact.update({
      where: { id: artifact.id },
      data: { metadata: { medicalMaterial: scene, usage: "REFERENCE", usabilityStatus: "USABLE" } },
    });
    expect(await loadPosterAssets(prisma, storage, tenantId, assets)).toHaveLength(1);
    expect(
      await loadPosterAssets(
        prisma,
        storage,
        tenantId,
        assets.map((asset) => ({ ...asset, authorizationConfirmed: true, privacyConfirmed: true })),
        true,
      ),
    ).toHaveLength(1);
    await prisma.materialArtifact.update({
      where: { id: artifact.id },
      data: {
        metadata: {
          medicalMaterial: { ...scene, privacyConfirmed: false },
          usage: "REFERENCE",
          usabilityStatus: "USABLE",
        },
      },
    });
    get.mockClear();
    await expect(loadPosterAssets(prisma, storage, tenantId, assets)).rejects.toMatchObject({
      code: "REFERENCE_IMAGE_UNAVAILABLE",
    });
    expect(get).not.toHaveBeenCalled();
  } finally {
    if (tenantId) {
      await prisma.materialArtifact.deleteMany({ where: { tenantId } });
      await prisma.material.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
  }
});
