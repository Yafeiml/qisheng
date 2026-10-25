import { chromium, type Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { browserChannel } from "./browser-channel";
import { readVisibleNote } from "./parser";
import {
  allowBrowserRequest,
  blockedDocumentStatus,
  canonicalNoteUrl,
  sameNote,
  validateJobUrl,
} from "./security";

describe("collector navigation boundary", () => {
  const note = "https://www.xiaohongshu.com/explore/abc12345?xsec_token=private";

  it("allows a note and a shortlink without exposing bearer-like query parameters", () => {
    expect(() => validateJobUrl(note)).not.toThrow();
    expect(() => validateJobUrl("https://xhslink.com/aBc7")).not.toThrow();
    expect(canonicalNoteUrl(note)).toBe("https://www.xiaohongshu.com/explore/abc12345");
    expect(sameNote(note, "https://www.xiaohongshu.com/discovery/item/abc12345")).toBe(true);
    expect(sameNote(note, "https://www.xiaohongshu.com/explore/xyz12345")).toBe(false);
  });

  it.each([
    "https://xhslink.com/aBc7",
    "https://www.xhslink.com/a/aBc7",
    "https://xhslink.com/m/aBc7/",
    "https://xhslink.com/o/aBc7",
    "https://xhslink.cn/o/Fixture123",
  ])("accepts a recognized short link only until it resolves to a public note: %s", (short) => {
    expect(() => validateJobUrl(short)).not.toThrow();
    expect(allowBrowserRequest(short, "document", short)).toBe(true);
    expect(allowBrowserRequest(note, "document", short)).toBe(true);
    expect(sameNote(short, note)).toBe(true);
    expect(sameNote(short, short)).toBe(false);
    expect(sameNote(short, "https://www.xiaohongshu.com/user/profile/abc12345")).toBe(false);
    expect(canonicalNoteUrl(short)).toBeUndefined();
  });

  it.each([
    "http://www.xiaohongshu.com/explore/abc12345",
    "https://attackerxiaohongshu.com/explore/abc12345",
    "https://www.xiaohongshu.com.attacker.com/explore/abc12345",
    "https://127.0.0.1/explore/abc12345",
    "https://u:p@www.xiaohongshu.com/explore/abc12345",
    "https://www.xiaohongshu.com:8443/explore/abc12345",
    "https://www.xiaohongshu.com/user/profile/abc12345",
    "file:///etc/passwd",
    "https://www.xiaohongshu.com/explore/abc12345#payload",
    "https://www.xhslink.cn/o/abc12345",
    "https://xhslink.cn.attacker.com/o/abc12345",
    "https://attackerxhslink.cn/o/abc12345",
    "https://xhslink.cn./o/abc12345",
    "https://xhslink.cn/",
    "https://xhslink.cn/user/profile/abc12345",
    "https://xhslink.cn/o//abc12345",
    "https://xhslink.cn/o/abc12345/extra",
    "https://xhslink.com/b/abc12345",
  ])("blocks arbitrary navigation %s", (url) => {
    expect(() => validateJobUrl(url)).toThrow();
    expect(allowBrowserRequest(url, "document", note)).toBe(false);
    expect(allowBrowserRequest(url, "document", "https://xhslink.cn/o/Fixture002A")).toBe(false);
  });

  it("checks top-level redirects and media separately", () => {
    expect(allowBrowserRequest("https://xhslink.com/aBc7", "document", note)).toBe(false);
    expect(
      allowBrowserRequest("https://xhslink.com/aBc7", "document", "https://xhslink.com/aBc7"),
    ).toBe(true);
    expect(
      allowBrowserRequest("https://www.xiaohongshu.com/explore/abc12345", "document", note),
    ).toBe(true);
    expect(
      allowBrowserRequest("https://www.xiaohongshu.com/explore/xyz12345", "document", note),
    ).toBe(false);
    expect(
      allowBrowserRequest("https://www.xiaohongshu.com/user/profile/abc12345", "document", note),
    ).toBe(false);
    expect(allowBrowserRequest("https://sns-img.xhscdn.com/pic.jpg", "image", note)).toBe(true);
    expect(allowBrowserRequest("https://foo.xhscdn.com.evil.test/pic.jpg", "image", note)).toBe(
      false,
    );
    expect(allowBrowserRequest("https://169.254.169.254/metadata", "image", note)).toBe(false);
    expect(allowBrowserRequest("https://www.xiaohongshu.com/v1/movies", "websocket", note)).toBe(
      false,
    );
  });

  it("identifies the main-frame request before a browser navigation (offline mock)", async () => {
    const browser = await chromium.launch({ headless: true, channel: browserChannel() });
    try {
      const context = await browser.newContext();
      let page: Page | null = null;
      let mainFrameSeen = false;
      await context.route("**/*", async (route) => {
        const request = route.request();
        mainFrameSeen = page !== null && request.frame() === page.mainFrame();
        await route.fulfill({ status: 200, contentType: "text/html", body: "<main>mock</main>" });
      });
      page = await context.newPage();
      await page.goto("https://www.xiaohongshu.com/explore/offline123", {
        waitUntil: "domcontentloaded",
      });
      expect(mainFrameSeen).toBe(true);
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it("rejects an iframe challenge even when the note itself still parses as available", async () => {
    const browser = await chromium.launch({ headless: true, channel: browserChannel() });
    try {
      const context = await browser.newContext();
      let blocked: string | null = null;
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame().parentFrame()) {
          blocked = blockedDocumentStatus(request.url(), false);
          await route.abort("blockedbyclient");
          return;
        }
        await route.fulfill({
          contentType: "text/html",
          body: `<div id="note-detail"><h1 id="detail-title">Mock title</h1>
            <div id="detail-desc">Mock body</div>
            <div class="swiper-wrapper"><img width="90" height="80" src="https://cdn.xhscdn.com/fake.jpg"/></div>
            <div class="like-wrapper"><span class="count">2</span></div>
            <iframe src="https://www.xiaohongshu.com/captcha/check"></iframe></div>`,
        });
      });
      const page = await context.newPage();
      await page.goto("https://www.xiaohongshu.com/explore/offline123", {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(100);
      expect((await readVisibleNote(page)).status).toBe("AVAILABLE");
      expect(blocked).toBe("CHALLENGE_REQUIRED");
      expect(blockedDocumentStatus("https://www.xiaohongshu.com/login", false)).toBe(
        "LOGIN_REQUIRED",
      );
      expect(blockedDocumentStatus("https://unknown.example/notice", false)).toBe("PARTIAL");
      await context.close();
    } finally {
      await browser.close();
    }
  });
});
