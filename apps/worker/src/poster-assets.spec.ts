import type { PrismaClient } from "@xhs-agentic/database";
import type { ObjectStorage } from "@xhs-agentic/object-storage";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { composePoster, loadPosterAssets } from "./poster-assets";

describe("original logo composition", () => {
  it("rechecks current medical image authorization and validity before downloading", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const get = vi.fn();
    await expect(
      loadPosterAssets(
        { materialArtifact: { findFirst } } as unknown as PrismaClient,
        { get } as unknown as ObjectStorage,
        "tenant",
        [
          {
            artifactId: "artifact",
            materialId: "material",
            objectKey: "image",
            checksum: "checksum",
            mimeType: "image/png",
            description: "授权原图",
            usage: "REFERENCE",
            authorizationConfirmed: true,
            privacyConfirmed: true,
          },
        ],
        true,
      ),
    ).rejects.toMatchObject({ code: "REFERENCE_IMAGE_UNAVAILABLE" });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant",
          material: expect.objectContaining({
            authorizationStatus: "AUTHORIZED",
            status: "ACTIVE",
            AND: expect.any(Array),
          }),
        }),
      }),
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("places the original logo at the top left without cropping or changing other corners", async () => {
    const poster = await sharp({
      create: { width: 108, height: 144, channels: 4, background: "#eeeeee" },
    })
      .png()
      .toBuffer();
    const logo = await sharp({
      create: { width: 12, height: 8, channels: 4, background: "#17a465" },
    })
      .png()
      .toBuffer();
    const result = await composePoster(poster, logo, 108, 144);
    const originalPixels = await sharp(logo).removeAlpha().raw().toBuffer();
    const placedPixels = await sharp(result)
      .extract({
        left: Math.round(108 * 0.04),
        top: Math.round(144 * 0.04),
        width: 12,
        height: 8,
      })
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(placedPixels).toEqual(originalPixels);
    const bottomRight = { left: 92, top: 130, width: 12, height: 8 };
    expect(await sharp(result).extract(bottomRight).raw().toBuffer()).toEqual(
      await sharp(poster).extract(bottomRight).raw().toBuffer(),
    );
    expect(await sharp(result).metadata()).toMatchObject({ width: 108, height: 144 });
  });

  it.each(["#ffffff", "#000000"])(
    "chooses contrast against the actual overlay area on %s",
    async (background) => {
      const image = (width: number, height: number, color: string) =>
        sharp({
          create: { width, height, channels: 4, background: color },
        })
          .png()
          .toBuffer();
      const light = await image(12, 8, "#ffffff");
      const dark = await image(12, 8, "#000000");
      const left = Math.round(108 * 0.04);
      const top = Math.round(144 * 0.04);
      const poster = await sharp(
        await image(108, 144, background === "#ffffff" ? "#000000" : "#ffffff"),
      )
        .composite([{ input: await image(12, 8, background), left, top }])
        .png()
        .toBuffer();
      const transparent = await image(12, 8, "#00000000");
      const result = await composePoster(poster, [transparent, light, dark], 108, 144);
      const pixels = await sharp(result)
        .extract({ left, top, width: 12, height: 8 })
        .removeAlpha()
        .raw()
        .toBuffer();
      const expected = await sharp(background === "#ffffff" ? dark : light)
        .removeAlpha()
        .raw()
        .toBuffer();
      expect(pixels).toEqual(expected);
    },
  );

  it("uses the only logo and accepts no logo without changing the poster", async () => {
    const poster = await sharp({
      create: { width: 108, height: 144, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();
    const logo = await sharp({
      create: { width: 12, height: 8, channels: 4, background: "#345678" },
    })
      .png()
      .toBuffer();
    expect(await composePoster(poster, [logo], 108, 144)).toEqual(
      await composePoster(poster, logo, 108, 144),
    );
    expect(await composePoster(poster, [], 108, 144)).toEqual(
      await composePoster(poster, undefined, 108, 144),
    );
  });
});
