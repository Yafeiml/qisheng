import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { metricFromText, readVisibleNote } from "./parser";

describe("fixed DOM extraction against a local mock page", () => {
  it("does not turn missing counters into zero or abbreviations into exact counts", () => {
    expect(metricFromText("0")).toEqual({ value: 0, raw: "0", precision: "EXACT" });
    expect(metricFromText("1.2万")).toEqual({
      value: 12000,
      raw: "1.2万",
      precision: "APPROXIMATE",
    });
    expect(metricFromText("评论")).toEqual({ value: null, raw: "评论", precision: "UNAVAILABLE" });
    expect(metricFromText(null)).toEqual({ value: null, raw: null, precision: "UNAVAILABLE" });
  });

  it("extracts only fixed note selectors; comments are total, not comment bodies", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL,
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) => route.abort("blockedbyclient"));
      await page.setContent(`
        <div id="note-detail"><h1 id="detail-title">Mock note title</h1>
          <div id="detail-desc"><span class="desc">Mock note body</span></div>
          <div class="swiper-wrapper"><img width="180" height="160" src="https://cdn.xhscdn.com/mock.jpg"/></div>
          <div class="like-wrapper"><span class="count">1.2万</span></div>
          <div class="collect-wrapper"><span class="count">0</span></div>
          <div class="chat-wrapper"><span class="count">评论</span></div>
          <div class="comment-item">unrelated private text</div>
        </div>
      `);
      const evidence = await readVisibleNote(page);
      expect(evidence.status).toBe("AVAILABLE");
      expect(evidence.title).toBe("Mock note title");
      expect(evidence.body).toBe("Mock note body");
      expect(evidence.body).not.toContain("unrelated private text");
      expect(evidence.metrics?.likes.precision).toBe("APPROXIMATE");
      expect(evidence.metrics?.favorites).toEqual({ value: 0, raw: "0", precision: "EXACT" });
      expect(evidence.metrics?.comments.precision).toBe("UNAVAILABLE");
      expect(evidence.images).toEqual([{ url: "https://cdn.xhscdn.com/mock.jpg" }]);
    } finally {
      await browser.close();
    }
  });

  it("halts on challenge before processing page content", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL,
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<main><div role="dialog">请先完成安全验证 验证码</div><article><h1>Mock note</h1></article></main>`,
      );
      expect((await readVisibleNote(page)).status).toBe("CHALLENGE_REQUIRED");
    } finally {
      await browser.close();
    }
  });

  it("detects a visible risk toast even with normal title and body", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL,
    });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <div id="note-detail"><h1 id="detail-title">Real title</h1>
          <div id="detail-desc">Real content</div></div>
        <div class="toast" role="alert">访问异常，请稍后再试</div>
      `);
      const result = await readVisibleNote(page);
      expect(result.status).toBe("RISK_BLOCKED");
      expect(result.body).toBeUndefined();
    } finally {
      await browser.close();
    }
  });

  it("does not accept fallback content when an expiry notice remains visible", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL,
    });
    try {
      const page = await browser.newPage();
      await page.setContent(`<h1 id="detail-title">Fallback recommendation</h1>
        <div id="detail-desc">Trending text</div><p>笔记不存在</p>`);
      expect((await readVisibleNote(page)).status).toBe("LINK_UNAVAILABLE");
    } finally {
      await browser.close();
    }
  });
});
