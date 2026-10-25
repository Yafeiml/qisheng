import { describe, expect, it } from "vitest";
import { extractPublicationAccessUrl, normalizePublicationUrl } from "./publication-url";

describe("normalizePublicationUrl", () => {
  it("extracts a URL from share text and removes Xiaohongshu tracking data", () => {
    const result = normalizePublicationUrl(
      "分享笔记 https://www.xiaohongshu.com/explore/ABC123def?xsec_token=secret&utm_source=share ，欢迎查看",
    );
    expect(result).toEqual({
      canonicalKey: "xhs:note:abc123def",
      classification: "XHS_NOTE",
      normalizedUrl: "https://www.xiaohongshu.com/explore/ABC123def",
    });
  });

  it("maps alternate Xiaohongshu paths to the same global canonical key", () => {
    const first = normalizePublicationUrl("https://xiaohongshu.com/explore/65abcDEF");
    const second = normalizePublicationUrl(
      "http://www.xiaohongshu.com/discovery/item/65abcDEF?xsec_source=pc_feed",
    );
    expect(first.canonicalKey).toBe(second.canonicalKey);
    expect(first.normalizedUrl).toBe(second.normalizedUrl);
  });

  it("keeps short links distinct until they resolve to a canonical note", () => {
    const result = normalizePublicationUrl("https://xhslink.com/aBcDe?utm_source=copy");
    expect(result.classification).toBe("XHS_SHORT");
    expect(result.canonicalKey).toMatch(/^xhs:short:[a-f0-9]{64}$/u);
  });

  it("cleans the complete mobile share text including the current .cn short link", () => {
    const share =
      "虚构示例笔记 🔍 这是用于分享链接解析的测试文案... https://xhslink.cn/o/Fixture001A 复制这段话，进入【小红书】就能找到笔记。";
    expect(normalizePublicationUrl(share)).toMatchObject({
      classification: "XHS_SHORT",
      normalizedUrl: "https://xhslink.cn/o/Fixture001A",
    });
    expect(extractPublicationAccessUrl(share)).toBe("https://xhslink.cn/o/Fixture001A");
  });

  it.each([
    "https://xhslink.com/a/AbC123",
    "https://xhslink.com/o/AbC123",
    "https://xhslink.com/m/AbC123",
    "https://www.xhslink.com/AbC123",
    "https://xhslink.cn/a/AbC123",
    "https://xhslink.cn/m/AbC123/",
  ])("recognizes the official short-link format %s", (url) => {
    expect(normalizePublicationUrl(url).classification).toBe("XHS_SHORT");
    expect(extractPublicationAccessUrl(url)).toBe(url);
  });

  it("cleans quotes, attached Chinese copy and invisible clipboard separators", () => {
    for (const share of [
      "分享【https://xhslink.cn/o/AbC123】复制这段话",
      "分享 https://xhslink.cn/o/AbC123复制这段话",
      "分享 https://xhslink.cn/o/AbC\u200b123。",
      "笔记（https://www.xiaohongshu.com/explore/ABC123def?xsec_token=secret），欢迎查看",
    ]) {
      const cleaned = extractPublicationAccessUrl(share);
      expect(cleaned).not.toMatch(/[\u200b\u4e00-\u9fff]/u);
      expect(normalizePublicationUrl(cleaned).classification).not.toBe("OTHER");
    }
  });

  it("rejects share text containing more than one different publication link", () => {
    expect(() =>
      normalizePublicationUrl(
        "候选一 https://www.xiaohongshu.com/explore/first001 候选二 https://www.xiaohongshu.com/explore/second02",
      ),
    ).toThrow(/一次只能回填一个笔记链接/u);
  });

  it("does not classify paths the browser collector cannot visit as note or short links", () => {
    for (const link of [
      "https://www.xiaohongshu.com/explore/ABC123def/extra",
      "https://www.xiaohongshu.com/profile/explore/ABC123def",
      "https://www.xiaohongshu.com/explore//ABC123def",
      "https://www.xiaohongshu.com/discovery/item/ABC123def//",
      "https://xhslink.com/abc/extra",
      "https://xhslink.com/abc//",
      "https://xhslink.com/",
      "https://xhslink.cn/o/abc/extra",
      "https://xhslink.cn/o//abc",
      "https://xhslink.cn/o/abc//",
      "https://xhslink.cn/user/profile/ABC123def",
      "https://xhslink.cn/profile/ABC123def",
    ]) {
      expect(normalizePublicationUrl(link).classification).toBe("OTHER");
      expect(() => extractPublicationAccessUrl(link)).toThrow();
    }
  });

  it("does not accept lookalike Xiaohongshu domains", () => {
    const result = normalizePublicationUrl("https://evilxiaohongshu.com/explore/abcdef123");
    expect(result.classification).toBe("OTHER");
  });
});

describe("extractPublicationAccessUrl", () => {
  it("preserves a note's access token while keeping its de-duplication key token-free", () => {
    const submitted =
      "分享 https://www.xiaohongshu.com/explore/ABC123def?xsec_token=access-token&xsec_source=pc_search#section";
    const accessUrl = extractPublicationAccessUrl(submitted);
    expect(accessUrl).toBe(
      "https://www.xiaohongshu.com/explore/ABC123def?xsec_token=access-token&xsec_source=pc_search",
    );
    expect(normalizePublicationUrl(submitted)).toEqual({
      canonicalKey: "xhs:note:abc123def",
      classification: "XHS_NOTE",
      normalizedUrl: "https://www.xiaohongshu.com/explore/ABC123def",
    });
  });

  it("retains a short link for a browser to resolve, without fetching it from the API", () => {
    expect(extractPublicationAccessUrl("http://xhslink.com/aBcDe?source=share#fragment")).toBe(
      "https://xhslink.com/aBcDe?source=share",
    );
  });

  it("accepts the collector's exact note paths and optional single trailing slash", () => {
    expect(extractPublicationAccessUrl("https://xiaohongshu.com/discovery/item/ABC123def/")).toBe(
      "https://xiaohongshu.com/discovery/item/ABC123def/",
    );
    expect(extractPublicationAccessUrl("https://xhslink.com/abc/")).toBe(
      "https://xhslink.com/abc/",
    );
  });

  it("rejects lookalikes, non-default ports, credentials, and unsupported paths", () => {
    for (const link of [
      "https://evilxiaohongshu.com/explore/ABC123def",
      "https://www.xiaohongshu.com:8443/explore/ABC123def",
      "https://user:password@www.xiaohongshu.com/explore/ABC123def",
      "https://www.xiaohongshu.com/user/profile/ABC123def",
      "https://www.xiaohongshu.com./explore/ABC123def",
      "https://evilxhslink.cn/o/AbC123",
      "https://xhslink.cn.evil.example/o/AbC123",
      "https://xhslink.cn:8443/o/AbC123",
      "https://user:password@xhslink.cn/o/AbC123",
      "https://www.xhslink.cn/o/AbC123",
      "https://xhslink.cn./o/AbC123",
      "https://xhslink.cn/o/AbC123\\extra",
    ]) {
      expect(() => extractPublicationAccessUrl(link)).toThrow();
    }
  });

  it("applies the same address boundary to every verification mode", () => {
    for (const url of [
      "https://www.xiaohongshu.com:8443/explore/ABC123def",
      "https://www.xiaohongshu.com./explore/ABC123def",
      "https://xhslink.cn/o/AbC123\u0000",
      `https://xhslink.cn/o/AbC123?xsec_token=${"x".repeat(2_048)}`,
    ]) {
      expect(() => normalizePublicationUrl(url)).toThrow();
    }
  });
});
