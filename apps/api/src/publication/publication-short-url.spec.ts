import { withPublicHttpResponse } from "@xhs-agentic/network-security";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePublicationShortUrl } from "./publication-short-url";

vi.mock("@xhs-agentic/network-security", () => ({ withPublicHttpResponse: vi.fn() }));

const shortUrl = "https://xhslink.cn/o/Short123";
const noteId = "000000000000000000000001";
const canonicalUrl = `https://www.xiaohongshu.com/explore/${noteId}`;

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

function respondAt(target: string, status = 302) {
  vi.mocked(withPublicHttpResponse).mockImplementation(async (input, init, policy, consume) => {
    expect(init.method).toBe("GET");
    expect(init.headers).toBeUndefined();
    expect(policy).toMatchObject({ maxRedirects: 4 });
    policy.validateUrl?.(new URL(input));
    policy.validateUrl?.(new URL(target));
    return await consume(new Response("", { status }), new URL(target), 1);
  });
}

describe("publication short-link expansion", () => {
  it.each([
    shortUrl,
    "https://xhslink.com/Short123",
    "https://xhslink.com/a/Short123",
    "https://xhslink.com/o/Short123",
    "https://xhslink.com/m/Short123",
    "https://xhslink.cn/a/Short123",
    "https://xhslink.cn/m/Short123",
  ])(
    "accepts an official short redirect and returns only the canonical note identity: %s",
    async (input) => {
      respondAt(`https://www.xiaohongshu.com/discovery/item/${noteId}?xsec_token=access-secret`);
      const resolved = await resolvePublicationShortUrl(input);
      expect(resolved).toEqual({
        canonicalKey: `xhs:note:${noteId}`,
        classification: "XHS_NOTE",
        normalizedUrl: canonicalUrl,
      });
      expect(JSON.stringify(resolved)).not.toContain("access-secret");
    },
  );

  it.each([
    "https://xhslink.cn.evil.example/o/Short123",
    "https://user:secret@xhslink.cn/o/Short123",
    "https://xhslink.cn:8443/o/Short123",
    "https://127.0.0.1/o/Short123",
  ])("rejects an unsafe initial target before making any HTTP request: %s", async (input) => {
    await expect(resolvePublicationShortUrl(input)).rejects.toMatchObject({
      code: "SHORT_URL_UNAVAILABLE",
    });
    expect(withPublicHttpResponse).not.toHaveBeenCalled();
  });

  it.each([
    "https://outside.example/explore/000000000000000000000001?xsec_token=access-secret",
    "https://www.xiaohongshu.com/",
    "https://www.xiaohongshu.com/login",
    "https://www.xiaohongshu.com/user/profile/000000000000000000000001",
    "https://xhslink.cn:8443/o/Other123",
  ])("rejects a redirect outside the allowed note/share routes: %s", async (target) => {
    respondAt(target);
    await expect(resolvePublicationShortUrl(shortUrl)).rejects.toMatchObject({
      code: "SHORT_URL_TARGET_INVALID",
      message: "SHORT_URL_TARGET_INVALID",
    });
  });

  it("does not treat a terminal short link or missing note as a verified note target", async () => {
    respondAt(shortUrl, 200);
    await expect(resolvePublicationShortUrl(shortUrl)).rejects.toMatchObject({
      code: "SHORT_URL_NOTE_REQUIRED",
    });
    respondAt(canonicalUrl, 404);
    await expect(resolvePublicationShortUrl(shortUrl)).rejects.toMatchObject({
      code: "SHORT_URL_UNAVAILABLE",
    });
  });

  it("times out the complete expansion after five seconds and aborts the request", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    vi.mocked(withPublicHttpResponse).mockImplementation((_, init) => {
      signal = init.signal;
      return new Promise(() => {});
    });
    const outcome = expect(resolvePublicationShortUrl(shortUrl)).rejects.toMatchObject({
      code: "SHORT_URL_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(signal?.aborted).toBe(true);
  });
});
