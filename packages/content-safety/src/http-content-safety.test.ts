import { createHash } from "node:crypto";
import { PublicHttpPolicyError } from "@xhs-agentic/network-security";
import { describe, expect, it, vi } from "vitest";
import { HttpContentSafetyScanner } from "./http-content-safety";

const image = Buffer.from("safe-image");
const input = {
  images: [
    {
      bytes: image,
      checksum: createHash("sha256").update(image).digest("hex"),
      mimeType: "image/png" as const,
      sequence: 1,
    },
  ],
  requestId: "review-request",
  text: { body: "正文", hashtags: [], title: "标题" },
};

describe("HttpContentSafetyScanner", () => {
  it.each(["ORDINARY", "UNKNOWN", "MEDICAL_KOS", "INSTITUTION"] as const)(
    "forwards server publishing scope and keeps the hard medical floor for %s",
    async (category) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ decision: "PASS", categories: [], requestId: "receipt" })),
        );
      const verified = category === "MEDICAL_KOS" || category === "INSTITUTION";
      const publishingContext = {
        schemaVersion: "medical-publishing-v1" as const,
        category,
        verified,
        role: "真实岗位",
        allowBrandAttribution: verified,
        allowPlatformConsultation: verified,
        conversionPath: "NONE" as const,
      };
      const scanner = new HttpContentSafetyScanner({
        apiKey: "test-key",
        endpoint: "https://safety.example.test/v1/scan",
        provider: "TEST",
        fetch: fetcher,
      });
      const result = await scanner.scan({
        ...input,
        publishingContext,
        text: { title: "眼科事实", body: "示例测试眼科配备了德国蔡司全飞秒设备。", hashtags: [] },
      });
      expect(result.decision).toBe("BLOCK");
      const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
      expect(payload.publishingContext).toEqual(publishingContext);
      expect(payload.text.body).toContain("蔡司");
      expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain("test-key");
    },
  );

  it("sends one bounded multimodal request and normalizes the decision", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          categories: [{ code: "MEDICAL", decision: "REVIEW", score: 0.82 }],
          decision: "REVIEW",
          model: "safety-v1",
          requestId: "provider-request",
        }),
        { status: 200 },
      ),
    );
    const scanner = new HttpContentSafetyScanner({
      allowHttp: true,
      allowPrivateEndpoint: true,
      apiKey: "safety-secret",
      endpoint: "http://127.0.0.1:19090/v1/scan",
      fetch: fetcher,
      provider: "TEST_SAFETY",
    });
    const result = await scanner.scan({
      images: [
        {
          bytes: image,
          checksum: createHash("sha256").update(image).digest("hex"),
          mimeType: "image/png",
          sequence: 1,
        },
      ],
      requestId: "campaign:content:1",
      text: { body: "科普正文", hashtags: ["全飞秒"], title: "理性了解术式" },
    });
    expect(result).toMatchObject({
      decision: "REVIEW",
      model: "safety-v1",
      provider: "TEST_SAFETY",
      providerRequestId: "provider-request",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const request = fetcher.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer safety-secret");
    expect(request?.redirect).toBe("error");
    expect(String(request?.body)).not.toContain("safety-secret");
  });

  it("marks transient provider failures retryable without returning response bodies", async () => {
    const scanner = new HttpContentSafetyScanner({
      apiKey: "safety-secret",
      endpoint: "https://safety.example.test/v1/scan",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "BUSY", message: "internal secret" } }), {
          status: 503,
        }),
      ),
      provider: "TEST_SAFETY",
    });
    await expect(
      scanner.scan({
        images: [
          {
            bytes: image,
            checksum: createHash("sha256").update(image).digest("hex"),
            mimeType: "image/png",
            sequence: 1,
          },
        ],
        requestId: "request-2",
        text: { body: "正文", hashtags: [], title: "标题" },
      }),
    ).rejects.toMatchObject({ code: "BUSY", retryable: true });
  });

  it("rejects private production endpoints and placeholder credentials", () => {
    expect(
      () =>
        new HttpContentSafetyScanner({
          apiKey: "dev-only-content-safety-key",
          endpoint: "https://127.0.0.1/v1/scan",
          provider: "SAFETY_VENDOR",
          requireProductionCredential: true,
        }),
    ).toThrow(/private network|development placeholder/u);
  });
  it("classifies an HTML proxy failure by its HTTP status and preserves the receipt", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<html>private proxy details</html>", {
        status: 503,
        headers: { "x-request-id": "proxy-request" },
      }),
    );
    const scanner = new HttpContentSafetyScanner({
      apiKey: "safety-secret",
      endpoint: "https://safety.example.test/v1/scan",
      fetch: fetcher,
      provider: "TEST_SAFETY",
    });
    await expect(scanner.scan(input)).rejects.toMatchObject({
      code: "CONTENT_SAFETY_HTTP_503",
      message: "Content-safety provider returned HTTP 503",
      retryable: true,
      context: { httpStatus: 503, provider: "TEST_SAFETY", providerRequestId: "proxy-request" },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("reports DNS failure separately from a model response failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new PublicHttpPolicyError("private resolver details", "PUBLIC_HTTP_DNS_FAILED"),
      );
    const scanner = new HttpContentSafetyScanner({
      apiKey: "safety-secret",
      endpoint: "https://safety.example.test/v1/scan",
      fetch: fetcher,
      provider: "TEST_SAFETY",
    });
    await expect(scanner.scan(input)).rejects.toMatchObject({
      code: "CONTENT_SAFETY_DNS_FAILED",
      retryable: true,
      context: { provider: "TEST_SAFETY" },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("recognizes an aborted timeout even when the transport error has a different name", async () => {
    const fetcher: typeof fetch = async (_url, request) =>
      new Promise<Response>((_resolve, reject) => {
        request?.signal?.addEventListener("abort", () => reject(new Error("transport closed")));
      });
    const scanner = new HttpContentSafetyScanner({
      apiKey: "safety-secret",
      endpoint: "https://safety.example.test/v1/scan",
      fetch: fetcher,
      provider: "TEST_SAFETY",
      timeoutMs: 1000,
    });
    await expect(scanner.scan(input)).rejects.toMatchObject({
      code: "CONTENT_SAFETY_TIMEOUT",
      retryable: true,
    });
  });
});
