import { chromium } from "playwright-core";
import sharp from "sharp";
import { browserChannel } from "./browser-channel";
import { captureFirstImageHash } from "./image-hash";
import { readVisibleNote } from "./parser";

/** Local-only device check. No backend, platform URL, Cookie or real account is involved. */
async function main(): Promise<void> {
  const picture = await sharp({
    create: { width: 90, height: 80, channels: 3, background: "teal" },
  })
    .png()
    .toBuffer();
  const browser = await chromium.launch({
    ...(process.platform === "win32" ? { channel: browserChannel() } : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url() === "https://cdn.xhscdn.com/local-mock.png?token=local"
        ? route.fulfill({ status: 200, contentType: "image/png", body: picture })
        : route.abort("blockedbyclient"),
    );
    await page.setContent(`
      <main id="note-detail"><h1 id="detail-title">Local mock note</h1>
        <div id="detail-desc"><span class="desc">Local mock content</span></div>
        <div class="swiper-wrapper"><img width="90" height="80"
          src="https://cdn.xhscdn.com/local-mock.png?token=local"/></div>
        <div class="like-wrapper"><span class="count">1.2万</span></div>
        <div class="collect-wrapper"><span class="count">0</span></div>
        <div class="chat-wrapper"><span class="count">评论</span></div>
      </main>
    `);
    const result = await readVisibleNote(page);
    const images = await captureFirstImageHash(page, result.images ?? []);
    const valid =
      result.status === "AVAILABLE" &&
      result.metrics?.likes.precision === "APPROXIMATE" &&
      result.metrics.comments.precision === "UNAVAILABLE" &&
      result.metrics.favorites.value === 0 &&
      typeof images[0]?.perceptualHash === "string" &&
      images[0]?.url === "https://cdn.xhscdn.com/local-mock.png";
    if (!valid) throw new Error("LOCAL_MOCK_CHECK_FAILED");
    process.stdout.write("LOCAL_MOCK_CHECK_OK\n");
  } finally {
    await browser.close();
  }
}

void main().catch(() => {
  process.stderr.write(
    "Local mock check failed; verify the selected browser, Node and Windows runtime.\n",
  );
  process.exitCode = 1;
});
