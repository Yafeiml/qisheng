import { createHash } from "node:crypto";
import {
  assetRecord,
  type FrozenImageAsset,
  imageAssetDetails,
  readMedicalMaterial,
} from "@xhs-agentic/ai-gateway";
import type { PrismaClient } from "@xhs-agentic/database";
import type { ObjectStorage } from "@xhs-agentic/object-storage";
import sharp from "sharp";
import { PermanentGenerationError } from "./generation-execution";

export async function loadPosterAssets(
  prisma: PrismaClient,
  storage: ObjectStorage,
  tenantId: string,
  assets: FrozenImageAsset[],
  strictMedical = false,
) {
  const loaded = [];
  for (const asset of assets) {
    const now = new Date();
    const artifact = await prisma.materialArtifact.findFirst({
      where: {
        id: asset.artifactId,
        materialId: asset.materialId,
        tenantId,
        objectKey: asset.objectKey,
        checksum: asset.checksum,
        status: { in: ["STORED", "VERIFIED"] },
        material: {
          authorizationStatus: "AUTHORIZED",
          status: "ACTIVE",
          AND: [
            { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          ],
        },
      },
      include: { material: { select: { structuredFacts: true } } },
    });
    if (!artifact)
      throw new PermanentGenerationError(
        "参考图片不存在或已变更，请重新选择",
        "REFERENCE_IMAGE_UNAVAILABLE",
      );
    const materialPolicy = assetRecord(
      assetRecord(artifact.material.structuredFacts).medicalMaterial,
    );
    const artifactPolicy = assetRecord(assetRecord(artifact.metadata).medicalMaterial);
    const scene =
      strictMedical ||
      materialPolicy.purpose === "REAL_SCENE" ||
      artifactPolicy.purpose === "REAL_SCENE";
    const details = imageAssetDetails(artifact.metadata);
    if (
      materialPolicy.purpose === "ARCHIVE" ||
      artifactPolicy.purpose === "ARCHIVE" ||
      (scene &&
        (readMedicalMaterial(materialPolicy)?.purpose !== "REAL_SCENE" ||
          readMedicalMaterial(artifactPolicy)?.purpose !== "REAL_SCENE" ||
          details.usage !== "REFERENCE" ||
          details.usabilityStatus !== "USABLE" ||
          asset.usage !== "REFERENCE" ||
          (strictMedical &&
            (asset.privacyConfirmed !== true || asset.authorizationConfirmed !== true))))
    )
      throw new PermanentGenerationError(
        "参考图片授权、隐私或用途已变更，请重新选择",
        "REFERENCE_IMAGE_UNAVAILABLE",
      );
    const original = await storage.get(asset.objectKey, 25 * 1024 * 1024);
    if (createHash("sha256").update(original).digest("hex") !== asset.checksum) {
      throw new PermanentGenerationError("参考图片校验失败", "REFERENCE_IMAGE_CHECKSUM_MISMATCH");
    }
    // Only ordinary references are compressed for the provider. Logos never enter the model.
    const bytes =
      asset.usage === "LOGO"
        ? original
        : await sharp(original)
            .rotate()
            .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
            .png()
            .toBuffer();
    loaded.push({
      ...asset,
      bytes,
      mimeType: asset.usage === "LOGO" ? asset.mimeType : "image/png",
    });
  }
  return loaded;
}

/** Preserve the logo's colors, aspect ratio and transparency. No model or logo review. */
export async function composePoster(
  bytes: Uint8Array,
  logo?: Uint8Array | readonly Uint8Array[],
  width = 1080,
  height = 1440,
): Promise<Uint8Array> {
  const poster = await sharp(bytes)
    .rotate()
    .resize(width, height, { fit: "contain", background: "#ffffff" })
    .png()
    .toBuffer();
  const logos = !logo ? [] : logo instanceof Uint8Array ? [logo] : logo;
  if (!logos.length) return new Uint8Array(poster);
  let overlay: { data: Buffer; info: sharp.OutputInfo } | undefined;
  let bestContrast = -1;
  for (const candidate of logos) {
    const prepared = await sharp(candidate)
      .rotate()
      .resize({
        width: Math.round(width * 0.22),
        height: Math.round(height * 0.1),
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (logos.length === 1) {
      overlay = prepared;
      break;
    }
    const foreground = await sharp(prepared.data)
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer();
    const background = await sharp(poster)
      .extract({
        left: Math.round(width * 0.04),
        top: Math.round(height * 0.04),
        width: prepared.info.width,
        height: prepared.info.height,
      })
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer();
    let difference = 0;
    let opacity = 0;
    // Transparent padding must not influence which original logo is readable on this region.
    for (let pixel = 0; pixel < prepared.info.width * prepared.info.height; pixel++) {
      const alpha = (foreground[pixel * 4 + 3] ?? 0) / 255;
      const foregroundTone =
        (foreground[pixel * 4] ?? 0) * 0.2126 +
        (foreground[pixel * 4 + 1] ?? 0) * 0.7152 +
        (foreground[pixel * 4 + 2] ?? 0) * 0.0722;
      const backgroundTone =
        (background[pixel * 3] ?? 0) * 0.2126 +
        (background[pixel * 3 + 1] ?? 0) * 0.7152 +
        (background[pixel * 3 + 2] ?? 0) * 0.0722;
      difference += Math.abs(foregroundTone - backgroundTone) * alpha;
      opacity += alpha;
    }
    const contrast = opacity > 0 ? difference / opacity : -1;
    if (!overlay || contrast > bestContrast) {
      overlay = prepared;
      bestContrast = contrast;
    }
  }
  if (!overlay) return new Uint8Array(poster);
  return new Uint8Array(
    await sharp(poster)
      .composite([
        {
          input: overlay.data,
          left: Math.round(width * 0.04),
          top: Math.round(height * 0.04),
        },
      ])
      .png()
      .toBuffer(),
  );
}
