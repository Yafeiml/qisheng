import { chromium } from "playwright-core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { captureFirstImageHash, differenceHash, hashBoundedScreenshot } from "./image-hash";
import { readVisibleNote } from "./parser";

describe("visible image fingerprints", () => {
  it("uses generator-compatible grayscale, 9x8 resize and 64-bit ordering", async () => {
    const horizontal = await sharp({
      create: { width: 90, height: 80, channels: 3, background: "black" },
    })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = Buffer.from(horizontal.data);
    for (let row = 0; row < 80; row += 1) {
      for (let col = 0; col < 90; col += 1) {
        pixels.fill(col * 2, (row * 90 + col) * 3, (row * 90 + col) * 3 + 3);
      }
    }
    const gradient = await sharp(pixels, { raw: { width: 90, height: 80, channels: 3 } })
      .png()
      .toBuffer();
    expect(await differenceHash(gradient)).toBe("0000000000000000");
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 600, height: 500 } });
      await page.route("**/*", (route) =>
        route.request().url() === "https://cdn.xhscdn.com/mock.png?token=private"
          ? route.fulfill({ status: 200, contentType: "image/png", body: gradient })
          : route.abort("blockedbyclient"),
      );
      await page.setContent(`
        <main id="note-detail"><div class="swiper-wrapper">
          <img width="90" height="80" src="https://cdn.xhscdn.com/mock.png?token=private"/>
        </div></main>
      `);
      const annotated = await captureFirstImageHash(page, [
        { url: "https://cdn.xhscdn.com/mock.png" },
      ]);
      expect(annotated).toEqual([
        { url: "https://cdn.xhscdn.com/mock.png", perceptualHash: await differenceHash(gradient) },
      ]);
    } finally {
      await browser.close();
    }
  });

  it("uses the parser's .note-container root to fingerprint the same visible image", async () => {
    const image = await sharp({
      create: { width: 90, height: 80, channels: 3, background: "teal" },
    })
      .png()
      .toBuffer();
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL,
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url() === "https://cdn.xhscdn.com/other.png?key=private"
          ? route.fulfill({ contentType: "image/png", body: image })
          : route.abort("blockedbyclient"),
      );
      await page.setContent(`
        <div class="note-container"><h1 id="detail-title">Mock note</h1>
          <div id="detail-desc">Mock body</div>
          <div class="swiper-wrapper"><img width="90" height="80"
            src="https://cdn.xhscdn.com/other.png?key=private"/></div>
          <div class="like-wrapper"><span class="count">2</span></div>
        </div>
      `);
      const parsed = await readVisibleNote(page);
      expect(parsed.images).toEqual([{ url: "https://cdn.xhscdn.com/other.png" }]);
      const fingerprinted = await captureFirstImageHash(page, parsed.images ?? []);
      expect(fingerprinted[0]?.perceptualHash).toMatch(/^[a-f0-9]{16}$/u);
    } finally {
      await browser.close();
    }
  });

  it("leaves an oversized displayed image for review instead of taking a huge screenshot", async () => {
    const picture = await sharp({
      create: { width: 90, height: 80, channels: 3, background: "gray" },
    })
      .png()
      .toBuffer();
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL,
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url() === "https://cdn.xhscdn.com/oversized.png"
          ? route.fulfill({ contentType: "image/png", body: picture })
          : route.abort("blockedbyclient"),
      );
      await page.setContent(`<div id="note-detail"><div class="swiper-wrapper">
        <img style="width:2000px;height:700px" src="https://cdn.xhscdn.com/oversized.png" />
        </div></div>`);
      const images = [{ url: "https://cdn.xhscdn.com/oversized.png" }];
      expect(await captureFirstImageHash(page, images)).toEqual(images);
    } finally {
      await browser.close();
    }
  });

  it("rejects oversized PNG bytes before decoding pixels", async () => {
    expect(await hashBoundedScreenshot(Buffer.alloc(2_000_001))).toBeNull();
  });

  it("does not hash a compactly encoded image with over four million original pixels", async () => {
    const picture = await sharp({
      create: { width: 2200, height: 2000, channels: 3, background: "navy" },
    })
      .png()
      .toBuffer();
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL,
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url() === "https://cdn.xhscdn.com/large-original.png"
          ? route.fulfill({ contentType: "image/png", body: picture })
          : route.abort("blockedbyclient"),
      );
      await page.setContent(`<div id="note-detail"><div class="swiper-wrapper">
        <img width="90" height="80" src="https://cdn.xhscdn.com/large-original.png" />
        </div></div>`);
      const images = [{ url: "https://cdn.xhscdn.com/large-original.png" }];
      expect(await captureFirstImageHash(page, images)).toEqual(images);
    } finally {
      await browser.close();
    }
  });
});
