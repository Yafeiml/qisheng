import type { Page } from "playwright-core";
import sharp from "sharp";
import { NOTE_IMAGE_SELECTOR } from "./note-selectors";

const MAX_ORIGINAL_PIXELS = 4_000_000;
const MAX_RENDERED_CSS_PIXELS = 1_000_000;
const MAX_SCREENSHOT_PIXELS = 2_000_000;
const MAX_SCREENSHOT_PNG_BYTES = 2_000_000;

/** Byte-compatible with packages/ai-gateway/src/image-similarity.ts differenceHash. */
export async function differenceHash(input: Buffer): Promise<string> {
  const { data, info } = await sharp(input)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== 9 || info.height !== 8 || info.channels !== 1) {
    throw new Error("IMAGE_HASH_NORMALIZATION_FAILED");
  }
  let hash = 0n;
  let bit = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const left = data[row * 9 + column];
      const right = data[row * 9 + column + 1];
      if (left === undefined || right === undefined) {
        throw new Error("IMAGE_HASH_INCOMPLETE");
      }
      if (left > right) {
        hash |= 1n << bit;
      }
      bit += 1n;
    }
  }
  return hash.toString(16).padStart(16, "0");
}

/** Hash only an already rendered image, never fetch media through a separate API or URL. */
export async function captureFirstImageHash(
  page: Page,
  images: ReadonlyArray<Readonly<{ url?: string; perceptualHash?: string }>>,
): Promise<ReadonlyArray<Readonly<{ url?: string; perceptualHash?: string }>>> {
  if (images.length === 0) return images;
  const candidates = page.locator(NOTE_IMAGE_SELECTOR);
  try {
    const count = Math.min(await candidates.count(), 8);
    for (let candidateIndex = 0; candidateIndex < count; candidateIndex += 1) {
      const candidate = candidates.nth(candidateIndex);
      const loaded = await candidate.evaluate(
        (img: HTMLImageElement, limits) => {
          if (
            !img.getClientRects().length ||
            !img.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          ) {
            return null;
          }
          if (
            !img.complete ||
            img.naturalWidth < 48 ||
            img.naturalHeight < 48 ||
            img.naturalWidth * img.naturalHeight > limits.originalPixels
          ) {
            return { url: null };
          }
          const rect = img.getBoundingClientRect();
          if (
            rect.width < 48 ||
            rect.height < 48 ||
            rect.width > 2048 ||
            rect.height > 2048 ||
            rect.width * rect.height > limits.renderedCssPixels
          ) {
            return { url: null };
          }
          return { url: img.currentSrc || img.src };
        },
        { originalPixels: MAX_ORIGINAL_PIXELS, renderedCssPixels: MAX_RENDERED_CSS_PIXELS },
      );
      if (!loaded) continue;
      if (!loaded.url) return images;
      const source = new URL(loaded.url);
      const index = images.findIndex(({ url }) => url === `${source.origin}${source.pathname}`);
      if (index < 0) return images;
      const screenshot = await candidate.screenshot({ timeout: 8_000, animations: "disabled" });
      const hash = await hashBoundedScreenshot(screenshot);
      if (!hash) return images;
      return images.map((item, position) =>
        position === index ? { ...item, perceptualHash: hash } : item,
      );
    }
    return images;
  } catch {
    // Missing/broken image leaves VERIFY in human review; never invent a strong fingerprint.
    return images;
  }
}

/** Check PNG byte size and decoded dimensions before Sharp allocates the dHash raster. */
export async function hashBoundedScreenshot(screenshot: Buffer): Promise<string | null> {
  if (screenshot.byteLength > MAX_SCREENSHOT_PNG_BYTES) return null;
  try {
    const metadata = await sharp(screenshot).metadata();
    if (
      metadata.format !== "png" ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 2048 ||
      metadata.height > 2048 ||
      metadata.width * metadata.height > MAX_SCREENSHOT_PIXELS
    ) {
      return null;
    }
    return await differenceHash(screenshot);
  } catch {
    return null;
  }
}
