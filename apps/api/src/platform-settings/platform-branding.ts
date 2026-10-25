import { ConflictException } from "@nestjs/common";
import sharp from "sharp";

export async function normalizePlatformLogo(input: unknown): Promise<string> {
  if (input === "") return "";
  if (
    typeof input !== "string" ||
    input.length > 82_000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(input)
  ) {
    throw new ConflictException("请通过上传控件选择有效的 Logo 图片。");
  }
  const bytes = Buffer.from(input.slice("data:image/png;base64,".length), "base64");
  if (bytes.length > 60_000) throw new ConflictException("Logo 图片过大，请压缩后重新上传。");
  try {
    const image = sharp(bytes, { limitInputPixels: 512 * 512 });
    const metadata = await image.metadata();
    if (
      metadata.format !== "png" ||
      !metadata.width ||
      metadata.width !== metadata.height ||
      (metadata.pages ?? 1) > 1
    ) {
      throw new Error("Expected a square static PNG");
    }
    const clean = await image
      .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    if (clean.length > 60_000) throw new Error("Image is too large");
    return `data:image/png;base64,${clean.toString("base64")}`;
  } catch {
    throw new ConflictException("Logo 必须是有效的 1:1 静态图片，请重新选择文件。");
  }
}
