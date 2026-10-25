import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";

export type NormalizedPublicationUrl = Readonly<{
  canonicalKey: string;
  classification: "XHS_NOTE" | "XHS_SHORT" | "DEV_FIXTURE" | "OTHER";
  normalizedUrl: string;
}>;

const TRACKING_PARAMETERS = new Set([
  "appuid",
  "apptime",
  "app_platform",
  "ignoreengage",
  "sharefrom",
  "share_from_user_hidden",
  "share_id",
  "share_red_id",
  "source",
  "timestamp",
  "type",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
  "xhsshare",
  "xsec_source",
  "xsec_token",
]);
const XHS_NOTE_PATH = /^\/(?:explore|discovery\/item)\/([a-zA-Z0-9_-]{6,128})\/?$/u;
const XHS_SHORT_PATH = /^\/(?:[aom]\/)?[a-zA-Z0-9_-]{1,128}\/?$/u;
const XHS_SHORT_HOSTS = new Set(["xhslink.com", "www.xhslink.com", "xhslink.cn"]);

export function normalizePublicationUrl(rawValue: string): NormalizedPublicationUrl {
  const candidate = extractHttpUrl(rawValue);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ConflictException("发布链接格式不正确，请重新复制小红书笔记链接或分享文案");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname.endsWith(".") ||
    candidate.length > 2_048 ||
    candidate.includes("\\") ||
    [...candidate].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new ConflictException("发布链接包含不安全的地址或参数，请重新复制小红书笔记分享链接");
  }
  // Classify the submitted path before canonicalization: collapsing repeated
  // separators or removing extra trailing separators would turn a URL the
  // browser collector rejects into a seemingly valid publication link.
  const submittedPathname = url.pathname;
  url.protocol = "https:";
  url.hostname = url.hostname.toLocaleLowerCase();
  url.hash = "";
  url.pathname = normalizePathname(url.pathname);
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.has(key.toLocaleLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();

  if (["xiaohongshu.com", "www.xiaohongshu.com"].includes(url.hostname)) {
    const noteId = xhsNoteId(submittedPathname);
    if (noteId) {
      return {
        canonicalKey: `xhs:note:${noteId.toLocaleLowerCase()}`,
        classification: "XHS_NOTE",
        normalizedUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
      };
    }
  }
  if (XHS_SHORT_HOSTS.has(url.hostname) && XHS_SHORT_PATH.test(submittedPathname)) {
    const normalizedUrl = url.toString();
    return {
      canonicalKey: `xhs:short:${sha256(normalizedUrl)}`,
      classification: "XHS_SHORT",
      normalizedUrl,
    };
  }
  if (url.hostname === "fixture.xhs.local") {
    const fixtureId = xhsNoteId(submittedPathname);
    if (fixtureId) {
      return {
        canonicalKey: `xhs:fixture:${fixtureId.toLocaleLowerCase()}`,
        classification: "DEV_FIXTURE",
        normalizedUrl: `https://fixture.xhs.local/explore/${fixtureId}`,
      };
    }
  }
  const normalizedUrl = url.toString();
  return {
    canonicalKey: `url:${sha256(normalizedUrl)}`,
    classification: "OTHER",
    normalizedUrl,
  };
}

/**
 * Keep the employee's access parameters for the isolated browser collector.
 * The normalized URL above remains the stable, token-free de-duplication key.
 * Never put this value in an Agent response, customer view, or application log.
 */
export function extractPublicationAccessUrl(rawValue: string): string {
  const candidate = extractHttpUrl(rawValue);
  const normalized = normalizePublicationUrl(candidate);
  if (normalized.classification !== "XHS_NOTE" && normalized.classification !== "XHS_SHORT") {
    throw new ConflictException("请使用小红书笔记链接或包含笔记链接的分享文案");
  }
  const url = new URL(candidate);
  if (
    url.port ||
    url.username ||
    url.password ||
    url.hostname.endsWith(".") ||
    url.toString().length > 2_048 ||
    (normalized.classification === "XHS_NOTE" && !xhsNoteId(url.pathname)) ||
    (normalized.classification === "XHS_SHORT" && !XHS_SHORT_PATH.test(url.pathname))
  ) {
    throw new ConflictException("发布链接包含不支持的地址或参数，请重新复制笔记分享链接");
  }
  url.protocol = "https:";
  url.hash = "";
  return url.toString();
}

function extractHttpUrl(value: string): string {
  const matches = [
    ...value
      .trim()
      .replace(/[\u200b-\u200d\ufeff]/gu, "")
      .matchAll(/https?:\/\/[^\s<>"'，。；！？、（）【】《》\u4e00-\u9fff]+/giu),
  ].map(({ 0: match }) => match.replace(/[),.;!?\]}>，。；！？）】》]+$/u, ""));
  const unique = [...new Set(matches)];
  if (unique.length === 0) {
    throw new ConflictException("未找到发布链接，请粘贴小红书笔记链接或包含链接的完整分享文案");
  }
  if (unique.length > 1) {
    throw new ConflictException("一次只能回填一个笔记链接，请保留本次发布笔记的分享文案");
  }
  const candidate = unique[0];
  if (!candidate) throw new ConflictException("请粘贴小红书笔记链接或分享文案");
  return candidate;
}

function normalizePathname(value: string): string {
  const collapsed = value.replace(/\/{2,}/g, "/");
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/, "") || "/";
}

function xhsNoteId(pathname: string): string | null {
  const match = pathname.match(XHS_NOTE_PATH);
  return match?.[1] ?? null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
