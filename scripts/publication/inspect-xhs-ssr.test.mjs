import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedUrl,
  fakeDnsIp,
  inspectHtml,
  probe,
  publicIp,
  selectDnsAddress,
} from "./inspect-xhs-ssr.mjs";

test("records an exact note in JSON hydration without treating unrelated cards as evidence", () => {
  const html = `<title>样本</title><meta content="封面" property="og:title">
    <meta property="og:description" content="这只是短摘要">
    <meta property="og:image" content="https://example.invalid/cover.jpg">
    <script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc123xyz":{"note":{"title":"完整标题","desc":"完整正文 12345","imageList":[{"url":"secret"}]}}}}};</script>`;
  const result = inspectHtml(html, "abc123xyz");
  assert.equal(result.classification, "NOTE_FIELDS_CANDIDATE");
  assert.equal(result.fields.noteBodyChars, "完整正文 12345".length);
  assert.equal(result.fields.noteImages, 1);
  assert.equal(inspectHtml(html, "different-id").classification, "METADATA_OR_PARTIAL_ONLY");
  assert.equal(JSON.stringify(result.fields).includes("secret"), false);
});

test("marks SEO metadata alone as partial, even with cover metadata", () => {
  const html = `<meta content="短标题" property="og:title"><meta name="description" content="只是一段摘要">
    <meta content="https://example.invalid/cover" property="og:image">`;
  const result = inspectHtml(html, "abc123xyz");
  assert.equal(result.classification, "METADATA_OR_PARTIAL_ONLY");
  assert.equal(result.fields.metadataCoverPresent, true);
  assert.equal(result.fields.matchedNoteId, false);
});

test("short link follows a single allowlisted redirect and stops on risk responses", async () => {
  const seen = [];
  const result = await probe("https://xhslink.com/AbC?xsec_token=secret", {
    request: async (url) => {
      seen.push(url.hostname);
      return seen.length === 1
        ? {
            status: 302,
            location: "https://www.xiaohongshu.com/explore/abc123xyz?xsec_token=secret",
          }
        : { status: 412 };
    },
  });
  assert.deepEqual(seen, ["xhslink.com", "www.xiaohongshu.com"]);
  assert.deepEqual(result, {
    classification: "POSSIBLE_RISK_OR_RATE_LIMIT",
    httpStatus: 412,
    redirects: 1,
  });
});

test("classifies untrusted redirects without following or returning the target", async () => {
  const cases = [
    [null, "MISSING_LOCATION"],
    ["http://www.xiaohongshu.com/explore/abc123xyz?token=secret", "NON_HTTPS"],
    ["https://127.0.0.1/explore/abc123xyz?token=secret", "OTHER_HOST"],
    ["https://example.org/explore/abc123xyz?token=secret", "OTHER_HOST"],
    ["https://www.xiaohongshu.com/login?token=secret", "LOGIN_OR_AUTH"],
    ["https://www.xiaohongshu.com/passport/authorize?token=secret", "LOGIN_OR_AUTH"],
    ["https://www.xiaohongshu.com/?token=secret", "SITE_HOME"],
    ["https://www.xiaohongshu.com/404?token=secret", "OTHER_XHS_PATH"],
    ["https://www.xiaohongshu.com/explore/short?token=secret", "UNSUPPORTED_NOTE_PATH"],
    ["https://www.xiaohongshu.com:443/explore/abc123xyz?token=secret", null],
    ["https://someone:secret@www.xiaohongshu.com/explore/abc123xyz", "UNSAFE_TARGET"],
    ["http://[", "INVALID_LOCATION"],
  ];
  for (const [location, expected] of cases) {
    let calls = 0;
    const result = await probe("https://www.xiaohongshu.com/explore/abc123xyz", {
      request: async () => {
        calls += 1;
        return { status: 302, location };
      },
    });
    if (expected === null) {
      assert.equal(result.redirectReason, "TOO_MANY_REDIRECTS");
      assert.equal(calls, 3);
    } else {
      assert.equal(calls, 1);
      assert.equal(result.classification, "REDIRECT_UNRESOLVED");
      assert.equal(result.redirectReason, expected);
    }
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
  assert.throws(() => allowedUrl("https://www.xiaohongshu.com.evil.test/explore/abc123xyz"));
  assert.equal(publicIp("127.0.0.1"), false);
  assert.equal(publicIp("192.168.1.2"), false);
  assert.equal(publicIp("100.64.0.1"), false);
  assert.equal(publicIp("8.8.8.8"), true);
});

test("caps allowed note redirects at two without requesting a fourth page", async () => {
  let calls = 0;
  const result = await probe("https://xhslink.com/AbC", {
    request: async () => {
      calls += 1;
      return { status: 302, location: "/explore/abc123xyz?token=secret" };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.redirectReason, "UNSUPPORTED_NOTE_PATH");
  let noteCalls = 0;
  const capped = await probe("https://www.xiaohongshu.com/explore/abc123xyz", {
    request: async () => {
      noteCalls += 1;
      return { status: 302, location: "/explore/abc123xyz?token=secret" };
    },
  });
  assert.equal(noteCalls, 3);
  assert.equal(capped.redirectReason, "TOO_MANY_REDIRECTS");
  assert.equal(JSON.stringify(capped).includes("secret"), false);
});

test("allows only the explicitly opted-in fake DNS ranges and keeps private addresses blocked", () => {
  const fake = [
    { address: "198.18.0.236", family: 4 },
    { address: "2001:2::d1", family: 6 },
  ];
  assert.equal(fakeDnsIp(fake[0].address), true);
  assert.equal(fakeDnsIp(fake[1].address), true);
  assert.equal(fakeDnsIp("2001:2:1::d1"), false);
  assert.equal(publicIp(fake[1].address), false);
  assert.throws(() => selectDnsAddress(fake), { code: "DNS_FAKE_IP" });
  assert.deepEqual(selectDnsAddress(fake, true), fake[0]);
  assert.throws(() => selectDnsAddress([...fake, { address: "192.168.1.10", family: 4 }], true), {
    code: "DNS_NOT_PUBLIC",
  });
  assert.throws(() => selectDnsAddress([{ address: "127.0.0.1", family: 4 }], true), {
    code: "DNS_NOT_PUBLIC",
  });
});
