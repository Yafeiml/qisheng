import type { Page } from "playwright-core";
import { NOTE_IMAGE_CHILD_SELECTOR, NOTE_ROOT_SELECTOR } from "./note-selectors";
import { safeEvidenceUrl } from "./security";
import type { Metric, NoteEvidence, Status } from "./types";

export function metricFromText(text: string | null): Metric {
  const raw = text?.replace(/\s+/gu, "").trim() ?? "";
  if (!raw || raw === "-" || raw === "--") {
    return { value: null, raw: null, precision: "UNAVAILABLE" };
  }
  if (/^\d{1,3}(?:,\d{3})*$|^\d+$/u.test(raw)) {
    const parsed = Number(raw.replaceAll(",", ""));
    return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647
      ? { value: parsed, raw, precision: "EXACT" }
      : { value: null, raw, precision: "UNAVAILABLE" };
  }
  const compact = /^(\d+(?:\.\d{1,2})?)\s*(万|亿)\+?$/u.exec(raw);
  if (compact) {
    const value = Number(compact[1]) * (compact[2] === "万" ? 10_000 : 100_000_000);
    return Number.isSafeInteger(value)
      ? { value: Math.round(value), raw, precision: "APPROXIMATE" }
      : { value: null, raw, precision: "UNAVAILABLE" };
  }
  return { value: null, raw: raw.slice(0, 30), precision: "UNAVAILABLE" };
}

export function classifyPage(text: string): Status | null {
  if (/验证码|安全验证|滑动验证|captcha|verify you are human/iu.test(text)) {
    return "CHALLENGE_REQUIRED";
  }
  if (/账号异常|访问异常|操作频繁|存在风险|risk control|访问频繁/iu.test(text)) {
    return "RISK_BLOCKED";
  }
  if (/请求过于频繁|稍后再试|too many requests/iu.test(text)) return "RATE_LIMITED";
  if (/扫码登录|手机号登录|登录后查看|请先登录/iu.test(text)) return "LOGIN_REQUIRED";
  if (/笔记不存在|内容不存在|页面已删除|笔记已失效/iu.test(text)) {
    return "LINK_UNAVAILABLE";
  }
  return null;
}

/** Fixed, scoped selectors. The MCP caller cannot provide JS, selectors, clicks or page scripts. */
export async function readVisibleNote(page: Page): Promise<NoteEvidence> {
  const extracted = await page.evaluate(
    ({ rootSelector, imageChildSelector }) => {
      const visible = (node: Element | null): boolean =>
        node !== null &&
        Boolean(node.getClientRects().length) &&
        window.getComputedStyle(node).visibility !== "hidden";
      const note = Array.from(document.querySelectorAll(rootSelector)).find(visible) ?? null;
      const takeText = (selectors: string[]): string | undefined => {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (visible(node)) {
            const text = node?.textContent?.trim();
            if (text) return text.slice(0, 12_000);
          }
        }
        return undefined;
      };
      const title = takeText([
        "#detail-title",
        "#note-detail .title",
        ".note-detail-container .title",
        "article h1",
      ])?.slice(0, 500);
      const body = takeText([
        "#detail-desc .desc",
        "#detail-desc",
        ".note-detail-container .note-content",
        "article .note-content",
      ]);
      const count = (selectors: string[]): string | null =>
        takeText(selectors)?.slice(0, 30) ?? null;
      const images = note
        ? Array.from(note.querySelectorAll(imageChildSelector))
            .filter(visible)
            .slice(0, 8)
            .map(
              (image) => (image as HTMLImageElement).currentSrc || (image as HTMLImageElement).src,
            )
        : [];
      // Evaluate limited visible text in-page and return ONLY a category; comment text is not exported.
      const visibleText = document.body?.innerText?.slice(0, 30_000) ?? "";
      const bodyRisk: Status | null =
        /验证码|安全验证|滑动验证|captcha|verify you are human/iu.test(visibleText)
          ? "CHALLENGE_REQUIRED"
          : /账号异常|访问异常|操作频繁|存在风险|risk control|访问频繁/iu.test(visibleText)
            ? "RISK_BLOCKED"
            : /请求过于频繁|稍后再试|too many requests/iu.test(visibleText)
              ? "RATE_LIMITED"
              : /扫码登录|手机号登录|登录后查看|请先登录/iu.test(visibleText)
                ? "LOGIN_REQUIRED"
                : null;
      const bodyUnavailable = /笔记不存在|内容不存在|页面已删除|笔记已失效/iu.test(visibleText);
      const bannerText = Array.from(
        document.querySelectorAll(
          "[role='dialog'], [role='alert'], [aria-live], .toast, [class*='toast'], [class*='captcha'], [class*='risk'], [class*='login-container']",
        ),
      )
        .filter(visible)
        .map((node) => node.textContent?.slice(0, 400) ?? "")
        .join("\n");
      const datetime = note?.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
      return {
        title,
        body,
        images,
        datetime,
        bannerText,
        bodyRisk,
        bodyUnavailable,
        likes: count([
          "#note-detail .like-wrapper .count",
          ".like-wrapper .count",
          "[data-testid='like-count']",
        ]),
        comments: count([
          "#note-detail .chat-wrapper .count",
          ".chat-wrapper .count",
          "[data-testid='comment-count']",
        ]),
        favorites: count([
          "#note-detail .collect-wrapper .count",
          ".collect-wrapper .count",
          "[data-testid='favorite-count']",
        ]),
      };
    },
    { rootSelector: NOTE_ROOT_SELECTOR, imageChildSelector: NOTE_IMAGE_CHILD_SELECTOR },
  );
  // Visible safety UI takes precedence even if a valid note remains visible behind a toast.
  const classified =
    classifyPage(extracted.bannerText) ||
    extracted.bodyRisk ||
    (extracted.bodyUnavailable ? "LINK_UNAVAILABLE" : null);
  const observedAt = new Date().toISOString();
  if (classified) return { status: classified, observedAt, visibilityContext: "COLLECTOR_ACCOUNT" };
  const metrics = {
    likes: metricFromText(extracted.likes),
    comments: metricFromText(extracted.comments),
    favorites: metricFromText(extracted.favorites),
  };
  const images = [...new Set(extracted.images.filter(safeEvidenceUrl))].map((url) => {
    // Display references are for review only. CDN query strings may carry access parameters.
    const parsed = new URL(url);
    return { url: `${parsed.origin}${parsed.pathname}` };
  });
  const hasContent = Boolean(extracted.title || extracted.body);
  const allMetricsMissing = Object.values(metrics).every(
    ({ precision }) => precision === "UNAVAILABLE",
  );
  const status: Status = hasContent
    ? !extracted.body || images.length === 0 || allMetricsMissing
      ? "PARTIAL"
      : "AVAILABLE"
    : "PARSER_CHANGED";
  return {
    status,
    observedAt,
    visibilityContext: "COLLECTOR_ACCOUNT",
    ...(extracted.title ? { title: extracted.title } : {}),
    ...(extracted.body ? { body: extracted.body } : {}),
    images,
    ...(extracted.datetime && Number.isFinite(Date.parse(extracted.datetime))
      ? { externalPublishedAt: new Date(extracted.datetime).toISOString() }
      : {}),
    metrics,
  };
}
