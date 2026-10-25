#!/usr/bin/env node
// One-shot, credential-free SSR availability probe. This is not a publication verifier.
import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 2;
const MAX_PREVIEW = 2000;
const HOSTS = new Set([
  "xiaohongshu.com",
  "www.xiaohongshu.com",
  "m.xiaohongshu.com",
  "xhslink.com",
  "www.xhslink.com",
]);

export function allowedUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new ProbeError("INVALID_URL");
  }
  if (
    url.protocol !== "https:" ||
    !HOSTS.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    (url.hostname.endsWith("xhslink.com")
      ? !/^\/[\w-]{1,128}\/?$/u.test(url.pathname)
      : !/^\/(?:explore|discovery\/item)\/[\w-]{6,128}\/?$/u.test(url.pathname))
  ) {
    throw new ProbeError("UNSUPPORTED_LINK");
  }
  url.hash = "";
  return url;
}

export function publicIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(ip) !== 6) return false;
  const normalized = ip.toLowerCase();
  if (normalized.startsWith("::ffff:")) return publicIp(normalized.slice(7));
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    /^(?:fc|fd|fe[89ab]|ff)/u.test(normalized) ||
    fakeDnsIp(normalized) ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("2001:0db8:")
  );
}

export function fakeDnsIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 198 && (b === 18 || b === 19);
  }
  return isIP(ip) === 6 && /^2001:0*2:(?:0{1,4}:|:)/iu.test(ip);
}

export function selectDnsAddress(answers, allowFakeDns = false) {
  if (!Array.isArray(answers) || answers.length === 0) throw new ProbeError("DNS_FAILED");
  const rejected = answers.filter(
    ({ address }) => !publicIp(address) && !(allowFakeDns && fakeDnsIp(address)),
  );
  if (rejected.length > 0) {
    throw new ProbeError(
      rejected.every(({ address }) => fakeDnsIp(address)) ? "DNS_FAKE_IP" : "DNS_NOT_PUBLIC",
    );
  }
  return [...answers].sort(
    (left, right) =>
      Number(publicIp(right.address)) - Number(publicIp(left.address)) ||
      Number(right.family === 4) - Number(left.family === 4),
  )[0];
}

export async function probe(input, { request, allowFakeDns = false } = {}) {
  const fetch = request ?? ((url) => fetchPage(url, allowFakeDns));
  let url = allowedUrl(input);
  let redirects = 0;
  while (true) {
    const response = await fetch(url);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const redirectResult = (redirectReason) => ({
        classification: "REDIRECT_UNRESOLVED",
        redirectReason,
        httpStatus: response.status,
        redirects,
      });
      if (!response.location) return redirectResult("MISSING_LOCATION");
      if (redirects >= MAX_REDIRECTS) return redirectResult("TOO_MANY_REDIRECTS");
      let next;
      try {
        next = new URL(response.location, url);
      } catch {
        return redirectResult("INVALID_LOCATION");
      }
      // Only emit fixed labels: neither the target URL nor its path/query is logged.
      if (next.protocol !== "https:") return redirectResult("NON_HTTPS");
      if (!HOSTS.has(next.hostname)) return redirectResult("OTHER_HOST");
      if (next.port || next.username || next.password) return redirectResult("UNSAFE_TARGET");
      if (/^\/(?:login|signin|signup|passport|auth|user\/login)(?:\/|$)/iu.test(next.pathname))
        return redirectResult("LOGIN_OR_AUTH");
      if (next.pathname === "/") return redirectResult("SITE_HOME");
      if (
        (next.hostname.endsWith("xhslink.com") && !/^\/[\w-]{1,128}\/?$/u.test(next.pathname)) ||
        (next.hostname.endsWith("xiaohongshu.com") &&
          /^\/(?:explore|discovery\/item)(?:\/|$)/u.test(next.pathname) &&
          !/^\/(?:explore|discovery\/item)\/[\w-]{6,128}\/?$/u.test(next.pathname))
      )
        return redirectResult("UNSUPPORTED_NOTE_PATH");
      try {
        url = allowedUrl(next.href);
      } catch {
        return redirectResult("OTHER_XHS_PATH");
      }
      redirects += 1;
      continue;
    }
    if ([403, 412, 429].includes(response.status)) {
      return {
        classification: "POSSIBLE_RISK_OR_RATE_LIMIT",
        httpStatus: response.status,
        redirects,
      };
    }
    if (response.status !== 200) {
      return { classification: "HTTP_UNAVAILABLE", httpStatus: response.status, redirects };
    }
    if (!/^text\/html(?:;|$)/iu.test(response.contentType)) {
      return { classification: "NOT_HTML", httpStatus: response.status, redirects };
    }
    return {
      ...inspectHtml(response.html, noteId(url)),
      httpStatus: response.status,
      redirects,
      truncated: response.truncated === true,
    };
  }
}

export function inspectHtml(html, expectedNoteId) {
  const metadata = metaFields(html);
  const htmlTitle = decodeEntities(/<title\b[^>]*>([^<]{0,2048})<\/title>/iu.exec(html)?.[1] ?? "");
  const scripts = [...html.matchAll(/<script\b([^>]{0,1024})>([\s\S]*?)<\/script>/giu)];
  let jsonLd = { title: "", body: "", imageCount: 0 };
  for (const [, attributes, contents] of scripts) {
    if (!/type\s*=\s*["']application\/ld\+json["']/iu.test(attributes)) continue;
    try {
      const payload = JSON.parse(contents);
      const entry = Array.isArray(payload)
        ? payload.find((row) => row && typeof row === "object")
        : payload;
      jsonLd = {
        title: textField(entry?.headline || entry?.name),
        body: textField(entry?.articleBody || entry?.description),
        imageCount: imageCount(entry?.image),
      };
      break;
    } catch {
      // A non-JSON script cannot serve as SSR evidence.
    }
  }
  const hydration = hydrationFields(html, expectedNoteId);
  const possibleChallenge = /(?:安全验证|访问频繁|异常访问|请完成验证|captcha)/iu.test(htmlTitle);
  const classification = possibleChallenge
    ? "POSSIBLE_CHALLENGE"
    : hydration.matchedNoteId &&
        hydration.title.length > 0 &&
        hydration.body.length > 0 &&
        hydration.imageCount > 0
      ? "NOTE_FIELDS_CANDIDATE"
      : metadata.title || metadata.body || jsonLd.title || jsonLd.body
        ? "METADATA_OR_PARTIAL_ONLY"
        : "HTML_SHELL_OR_UNKNOWN";
  return {
    classification,
    fields: {
      htmlTitleChars: htmlTitle.length,
      metadataTitleChars: metadata.title.length,
      metadataDescriptionChars: metadata.body.length,
      metadataCoverPresent: metadata.cover.length > 0,
      jsonLdTitleChars: jsonLd.title.length,
      jsonLdBodyChars: jsonLd.body.length,
      jsonLdImages: jsonLd.imageCount,
      initialStatePresent: hydration.present,
      initialStateJsonParsed: hydration.parsed,
      matchedNoteId: hydration.matchedNoteId,
      noteTitleChars: hydration.title.length,
      noteBodyChars: hydration.body.length,
      noteImages: hydration.imageCount,
    },
    // For optional on-device display only; never part of the shareable report.
    privatePreview: {
      title: hydration.title || jsonLd.title || metadata.title,
      body: hydration.body || jsonLd.body || metadata.body,
    },
  };
}

function metaFields(html) {
  const result = { title: "", body: "", cover: "" };
  for (const tag of html.match(/<meta\b[^>]{0,8192}>/giu) ?? []) {
    const attributes = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
      attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? "");
    }
    const name = (attributes.property ?? attributes.name ?? "").toLowerCase();
    const content = attributes.content ?? "";
    if (["og:title", "twitter:title"].includes(name)) result.title ||= content;
    if (["og:description", "description", "twitter:description"].includes(name))
      result.body ||= content;
    if (["og:image", "twitter:image"].includes(name)) result.cover ||= content;
  }
  return result;
}

function hydrationFields(html, expectedNoteId) {
  const marker = /(?:window\.)?__INITIAL_STATE__\s*=\s*/gu.exec(html);
  if (!marker)
    return {
      present: false,
      parsed: false,
      matchedNoteId: false,
      title: "",
      body: "",
      imageCount: 0,
    };
  const raw = extractJsonObject(html, marker.index + marker[0].length);
  if (!raw)
    return {
      present: true,
      parsed: false,
      matchedNoteId: false,
      title: "",
      body: "",
      imageCount: 0,
    };
  try {
    const state = JSON.parse(raw);
    const map = state?.note?.noteDetailMap?.value ?? state?.note?.noteDetailMap;
    const entry =
      expectedNoteId && map && typeof map === "object"
        ? Object.entries(map).find(
            ([key]) => key.toLowerCase() === expectedNoteId.toLowerCase(),
          )?.[1]
        : null;
    const note = entry?.note?.value ?? entry?.note ?? null;
    const matchedNoteId = Boolean(note && typeof note === "object");
    return {
      present: true,
      parsed: true,
      matchedNoteId,
      title: textField(note?.title),
      body: textField(note?.desc),
      imageCount: imageCount(note?.imageList),
    };
  } catch {
    return {
      present: true,
      parsed: false,
      matchedNoteId: false,
      title: "",
      body: "",
      imageCount: 0,
    };
  }
}

function extractJsonObject(html, offset) {
  const start = html.indexOf("{", offset);
  if (start < 0 || start - offset > 50) return null;
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return html.slice(start, i + 1);
    if (depth > 256) return null;
  }
  return null;
}

function noteId(url) {
  return /^\/(?:explore|discovery\/item)\/([\w-]{6,128})\/?$/u.exec(url.pathname)?.[1] ?? null;
}

function imageCount(value) {
  if (Array.isArray(value)) return value.length;
  return value && (typeof value === "string" || typeof value === "object") ? 1 : 0;
}

function textField(value) {
  return typeof value === "string" ? value.trim() : "";
}

function decodeEntities(value) {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#39|#x([0-9a-f]+)|#([0-9]+));/giu,
    (match, hex, dec) => {
      if (hex || dec) {
        const code = Number.parseInt(hex || dec, hex ? 16 : 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return (
        { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" }[
          match.toLowerCase()
        ] ?? match
      );
    },
  );
}

async function fetchPage(url, allowFakeDns) {
  let answers;
  try {
    answers = await lookup(url.hostname, { all: true });
  } catch {
    throw new ProbeError("DNS_FAILED");
  }
  const address = selectDnsAddress(answers, allowFakeDns);
  return new Promise((done, fail) => {
    let timer;
    const finish = (value) => {
      clearTimeout(timer);
      done(value);
    };
    const stop = (error) => {
      clearTimeout(timer);
      fail(error);
    };
    const request = https.get(
      url,
      {
        headers: { Accept: "text/html", "Accept-Encoding": "gzip, deflate, br" },
        lookup: (_hostname, options, callback) =>
          options.all ? callback(null, [address]) : callback(null, address.address, address.family),
      },
      async (response) => {
        try {
          const status = response.statusCode ?? 0;
          const location = response.headers.location ?? null;
          const contentType = response.headers["content-type"] ?? "";
          if (status !== 200 || !/^text\/html(?:;|$)/iu.test(contentType)) {
            response.resume();
            finish({ status, location, contentType });
            return;
          }
          const encoding = response.headers["content-encoding"]?.toLowerCase() ?? "identity";
          const decompressor =
            encoding === "gzip"
              ? createGunzip()
              : encoding === "br"
                ? createBrotliDecompress()
                : encoding === "deflate"
                  ? createInflate()
                  : null;
          if (!decompressor && encoding !== "identity")
            throw new ProbeError("UNSUPPORTED_ENCODING");
          const stream = decompressor ? response.pipe(decompressor) : response;
          const chunks = [];
          let size = 0;
          for await (const chunk of stream) {
            size += chunk.length;
            if (size > MAX_HTML_BYTES) throw new ProbeError("HTML_TOO_LARGE");
            chunks.push(chunk);
          }
          finish({ status, location, contentType, html: Buffer.concat(chunks).toString("utf8") });
        } catch (error) {
          response.destroy();
          stop(error);
        }
      },
    );
    timer = setTimeout(() => request.destroy(new ProbeError("TIMEOUT")), 10_000);
    request.on("error", stop);
  });
}

class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function hiddenLink() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode)
    throw new ProbeError("INTERACTIVE_TTY_REQUIRED");
  process.stdout.write("粘贴小红书笔记链接（输入隐藏，不保存）：");
  return new Promise((done, fail) => {
    let input = "";
    const previousRaw = process.stdin.isRaw;
    const cleanup = () => {
      process.stdin.off("data", handler);
      process.stdin.setRawMode(Boolean(previousRaw));
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const handler = (data) => {
      for (const char of data.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          cleanup();
          done(input.trim());
          return;
        }
        if (char === "\u0003") {
          cleanup();
          fail(new ProbeError("CANCELLED"));
          return;
        }
        if (char === "\b" || char === "\u007f") input = input.slice(0, -1);
        else if (char >= " " && input.length < 2048) input += char;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", handler);
  });
}

async function main() {
  const options = process.argv.slice(2);
  if (options.includes("--help")) {
    console.log(
      "用法：node inspect-xhs-ssr.mjs [--show-text] [--allow-fake-dns]\n诊断：node inspect-xhs-ssr.mjs --diagnose-dns\n离线自检：node inspect-xhs-ssr.mjs --self-test\n直接运行后在隐藏提示中粘贴链接；不要把链接作为命令行参数。",
    );
    return;
  }
  if (options.length === 1 && options[0] === "--diagnose-dns") {
    const diagnosis = [];
    for (const host of ["www.xiaohongshu.com", "xhslink.com"]) {
      try {
        const answers = await lookup(host, { all: true });
        const classification =
          answers.length === 0
            ? "DNS_FAILED"
            : answers.every(({ address }) => publicIp(address))
              ? "PUBLIC"
              : answers.every(({ address }) => publicIp(address) || fakeDnsIp(address)) &&
                  answers.some(({ address }) => fakeDnsIp(address))
                ? "FAKE_IP"
                : "PRIVATE_OR_RESERVED";
        diagnosis.push({ host, classification });
      } catch {
        diagnosis.push({ host, classification: "DNS_FAILED" });
      }
    }
    console.log(JSON.stringify({ status: "DNS_DIAGNOSIS", hosts: diagnosis }));
    return;
  }
  if (options.includes("--self-test")) {
    const sample =
      '<meta property="og:title" content="样本标题"><script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc123xyz":{"note":{"title":"样本标题","desc":"完整样本正文","imageList":[{"url":"private"}]}}}}};</script>';
    const result = inspectHtml(sample, "abc123xyz");
    if (result.classification !== "NOTE_FIELDS_CANDIDATE") throw new ProbeError("SELF_TEST_FAILED");
    console.log("SELF_TEST_OK（无网络请求）");
    return;
  }
  if (options.some((value) => !["--show-text", "--allow-fake-dns"].includes(value)))
    throw new ProbeError("UNKNOWN_OPTION");
  const input = await hiddenLink();
  const result = await probe(input, { allowFakeDns: options.includes("--allow-fake-dns") });
  const { privatePreview, ...shareable } = result;
  console.log(JSON.stringify({ probeVersion: 2, ...shareable }, null, 2));
  if (options.includes("--show-text") && privatePreview) {
    console.log("本机预览，仅供你核对，不要转发：");
    console.log(`标题：${privatePreview.title.slice(0, MAX_PREVIEW)}`);
    console.log(`正文前 ${MAX_PREVIEW} 字：${privatePreview.body.slice(0, MAX_PREVIEW)}`);
  }
  console.log("只证明这次匿名 HTTP 响应包含了哪些字段；不证明账号归属、图片匹配或持续可访问。");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        status: "STOP",
        reason: error instanceof ProbeError ? error.code : "NETWORK_OR_PARSE_ERROR",
      }),
    );
    process.exitCode = 1;
  });
}
