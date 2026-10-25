import { isIP } from "node:net";
import type { Status } from "./types";

const NOTE_PATH = /^\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]{6,128})\/?$/u;
const SHORT_PATH = /^\/(?:[aom]\/)?[A-Za-z0-9_-]{1,128}\/?$/u;
const NOTE_HOSTS = new Set(["xiaohongshu.com", "www.xiaohongshu.com"]);
const SHORT_HOSTS = new Set(["xhslink.com", "www.xhslink.com", "xhslink.cn"]);

export class CollectorBoundaryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CollectorBoundaryError("URL_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    isIP(url.hostname) ||
    url.hostname.endsWith(".") ||
    [...raw].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new CollectorBoundaryError("URL_FORBIDDEN");
  }
  return url;
}

export function noteId(raw: string): string | null {
  const url = parseUrl(raw);
  return NOTE_HOSTS.has(url.hostname) ? (NOTE_PATH.exec(url.pathname)?.[1] ?? null) : null;
}

export function validateJobUrl(raw: string): void {
  const url = parseUrl(raw);
  if (noteId(raw)) return;
  if (SHORT_HOSTS.has(url.hostname) && SHORT_PATH.test(url.pathname)) return;
  throw new CollectorBoundaryError("JOB_TARGET_FORBIDDEN");
}

/** No private, file, websocket, data or arbitrary third-party requests can be issued by the browser. */
export function allowBrowserRequest(
  raw: string,
  resourceType: string,
  initialJobUrl: string,
): boolean {
  let url: URL;
  try {
    url = parseUrl(raw);
  } catch {
    return false;
  }
  if (resourceType === "document") {
    // Short-link hops must resolve directly to a recognized note. No external sites or profiles.
    const expected = noteId(initialJobUrl);
    if (expected) return sameNote(initialJobUrl, raw);
    return (
      Boolean(noteId(raw)) ||
      (raw === initialJobUrl && SHORT_HOSTS.has(url.hostname) && SHORT_PATH.test(url.pathname))
    );
  }
  if (resourceType === "media" || resourceType === "websocket" || resourceType === "eventsource") {
    return false;
  }
  const host = url.hostname;
  return NOTE_HOSTS.has(host) || host === "xhscdn.com" || host.endsWith(".xhscdn.com");
}

export function sameNote(expectedUrl: string, actualUrl: string): boolean {
  const expected = noteId(expectedUrl);
  const actual = noteId(actualUrl);
  // Short links are resolved to an actual note; the server verifies the returned canonical identity.
  return expected === null ? actual !== null : actual?.toLowerCase() === expected.toLowerCase();
}

export function safeEvidenceUrl(raw: string): boolean {
  let url: URL;
  try {
    url = parseUrl(raw);
  } catch {
    return false;
  }
  return url.hostname === "xhscdn.com" || url.hostname.endsWith(".xhscdn.com");
}

/** Access parameters can carry bearer-like values; only share the canonical URL with the API. */
export function canonicalNoteUrl(raw: string): string | undefined {
  const id = noteId(raw);
  return id ? `https://www.xiaohongshu.com/explore/${id}` : undefined;
}

export function blockedDocumentStatus(raw: string, isMainDocument: boolean): Status {
  if (/captcha|challenge|verify|risk/iu.test(raw)) return "CHALLENGE_REQUIRED";
  if (/login|sign-in/iu.test(raw)) return "LOGIN_REQUIRED";
  return isMainDocument ? "WRONG_TARGET" : "PARTIAL";
}
