import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { normalizePlatformLogo } from "./platform-branding";
import { PlatformBrandingController } from "./platform-branding.controller";
import type { PlatformSettingsReader } from "./platform-settings.reader";

async function png(width: number, height = width) {
  const bytes = await sharp({ create: { width, height, channels: 4, background: "#c42535" } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

describe("platform branding", () => {
  it("publishes only display name and logo, including before login", async () => {
    const resolveMany = vi.fn().mockResolvedValue(
      new Map([
        ["general.platform_name", { value: "用户自定义名称" }],
        ["general.platform_logo", { value: "" }],
        ["private.secret", { value: "must not be exposed" }],
      ]),
    );
    const controller = new PlatformBrandingController({
      resolveMany,
    } as unknown as PlatformSettingsReader);
    expect(await controller.current()).toEqual({ name: "用户自定义名称", logoDataUrl: null });
    expect(resolveMany).toHaveBeenCalledWith(["general.platform_name", "general.platform_logo"]);
  });

  it("normalizes square logos and preserves alpha", async () => {
    const normalized = await normalizePlatformLogo(await png(400));
    const metadata = await sharp(Buffer.from(normalized.split(",")[1] ?? "", "base64")).metadata();
    expect(metadata).toMatchObject({ width: 256, height: 256, format: "png", hasAlpha: true });
  });

  it("supports removing a logo", async () => {
    expect(await normalizePlatformLogo("")).toBe("");
  });

  it("rejects non-square logos", async () => {
    await expect(normalizePlatformLogo(await png(80, 40))).rejects.toThrow("1:1");
  });

  it.each([
    "https://example.test/logo.png",
    "data:image/svg+xml,<svg />",
    "data:image/png;base64,YmFk",
    12,
  ])("rejects unsafe or invalid images", async (value) => {
    await expect(normalizePlatformLogo(value)).rejects.toThrow();
  });

  it("rejects excessive dimensions and request size", async () => {
    await expect(normalizePlatformLogo(await png(800))).rejects.toThrow();
    await expect(
      normalizePlatformLogo(`data:image/png;base64,${"A".repeat(83_000)}`),
    ).rejects.toThrow();
  });
});
