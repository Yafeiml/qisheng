import { describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import {
  HttpPublicationVerificationAdapter,
  PlatformPublicationVerificationService,
  type PublicationVerificationInvocationError,
} from "./platform-publication-verification.service";
import type { PlatformSettingsReader } from "./platform-settings.reader";
import type { PublicationReadbackConfigurationService } from "./publication-readback.configuration";

describe("publication browser production gate", () => {
  it("keeps explicit manual mode independent from broken optional readback credentials", async () => {
    const runtime = vi.fn().mockRejectedValue(new Error("optional credential cannot decrypt"));
    const verifier = verifierWith(false, runtime);
    await expect(verifier.current()).resolves.toMatchObject({ mode: "MANUAL", adapter: null });
    expect(runtime).not.toHaveBeenCalled();
  });

  it("falls back to manual review when automatic configuration is enabled but not verified", async () => {
    const runtime = vi.fn().mockResolvedValue({ verified: false, externalMode: false });
    await expect(verifierWith(true, runtime).current()).resolves.toMatchObject({
      mode: "MANUAL",
      adapter: null,
    });
  });

  it("preserves verified managed and legacy external readback without requiring an HTTP adapter", async () => {
    for (const configuration of [
      { verified: true, externalMode: false },
      { verified: false, externalMode: true },
    ]) {
      await expect(
        verifierWith(true, vi.fn().mockResolvedValue(configuration)).current(),
      ).resolves.toMatchObject({ mode: "READBACK", adapter: null });
    }
  });
  it("rejects an already persisted browser mode before it can accept submissions", async () => {
    const previousEnv = process.env.NODE_ENV;
    const previousReadback = process.env.PUBLICATION_READBACK_ENABLED;
    process.env.NODE_ENV = "production";
    process.env.PUBLICATION_READBACK_ENABLED = "false";
    try {
      const verifier = new PlatformPublicationVerificationService(
        {} as PrismaService,
        {} as RequestAccessContext,
        {
          resolveMany: async () =>
            new Map<string, { value: string | number | boolean }>([
              ["publication.mode", { value: "BROWSER" }],
              ["publication.image_similarity_threshold", { value: 0.9 }],
              ["publication.text_similarity_threshold", { value: 0.9 }],
              ["publication.manual_review_margin", { value: 0.05 }],
              ["publication.policy_version", { value: "test-policy" }],
              ["publication.require_image_match", { value: true }],
            ]),
        } as unknown as PlatformSettingsReader,
        {} as PublicationReadbackConfigurationService,
      );
      await expect(verifier.current()).rejects.toMatchObject({
        response: { code: "PUBLICATION_BROWSER_PRODUCTION_NOT_READY" },
        status: 409,
      });
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
      if (previousReadback === undefined) delete process.env.PUBLICATION_READBACK_ENABLED;
      else process.env.PUBLICATION_READBACK_ENABLED = previousReadback;
    }
  });
});

function verifierWith(enabled: boolean, runtime: () => Promise<unknown>) {
  const values = new Map<string, { value: string | number | boolean }>([
    ["publication.mode", { value: "MANUAL" }],
    ["publication.readback_enabled", { value: enabled }],
    ["publication.image_similarity_threshold", { value: 0.9 }],
    ["publication.text_similarity_threshold", { value: 0.9 }],
    ["publication.manual_review_margin", { value: 0.05 }],
    ["publication.policy_version", { value: "manual-policy" }],
    ["publication.require_image_match", { value: true }],
  ]);
  return new PlatformPublicationVerificationService(
    {} as PrismaService,
    {} as RequestAccessContext,
    {
      resolveMany: async (keys: string[]) => {
        if (keys.includes("publication.api_key")) throw new Error("legacy HTTP secret corrupted");
        return values;
      },
      resolve: async () => {
        throw new Error("legacy HTTP secret corrupted");
      },
    } as unknown as PlatformSettingsReader,
    { runtime } as unknown as PublicationReadbackConfigurationService,
  );
}

describe("HttpPublicationVerificationAdapter", () => {
  it("sends bearer and idempotency headers and normalizes the provider canonical URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        body: "公开正文",
        canonicalUrl: "https://www.xiaohongshu.com/discovery/item/ABCdef123?xsec_token=removed",
        hashtags: ["验真"],
        images: [
          {
            checksum: "A".repeat(64),
            perceptualHash: "0123456789ABCDEF",
            url: "https://assets.example.test/public.jpg",
          },
        ],
        requestId: "provider-request-1",
        status: "AVAILABLE",
        title: "公开标题",
      }),
    );
    const adapter = adapterWith(fetcher);
    const result = await adapter.resolve(
      "https://xhslink.com/share-token",
      "submission-idempotency-1",
    );

    expect(result).toMatchObject({
      available: true,
      evidence: {
        canonicalKey: "xhs:note:abcdef123",
        canonicalUrl: "https://www.xiaohongshu.com/explore/ABCdef123",
        images: [
          {
            checksum: "a".repeat(64),
            perceptualHash: "0123456789ABCDEF",
          },
        ],
      },
    });
    const init = fetcher.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer adapter-secret-key");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("submission-idempotency-1");
    expect(init?.redirect).toBe("error");
  });

  it("preserves an explicit UNAVAILABLE response without treating it as a mismatch", async () => {
    const adapter = adapterWith(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse({ reason: "note is temporarily hidden", status: "UNAVAILABLE" }),
        ),
    );

    await expect(
      adapter.resolve("https://www.xiaohongshu.com/explore/abcdef123", "request-2"),
    ).resolves.toEqual({ available: false, reason: "note is temporarily hidden" });
  });

  it("classifies timeout as a retryable provider invocation failure", async () => {
    const fetcher = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof fetch;
    const adapter = new HttpPublicationVerificationAdapter({
      allowHttp: true,
      apiKey: "adapter-secret-key",
      endpoint: "http://127.0.0.1:19090/v1/resolve",
      fetch: fetcher,
      provider: "UNIT_TEST",
      timeoutMs: 1,
    });

    await expect(
      adapter.resolve("https://www.xiaohongshu.com/explore/abcdef123", "request-3"),
    ).rejects.toMatchObject({
      code: "PUBLICATION_VERIFICATION_TIMEOUT",
      retryable: true,
    } satisfies Partial<PublicationVerificationInvocationError>);
  });

  it("rejects oversized or structurally invalid provider responses", async () => {
    const oversized = adapterWith(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response("{}", {
          headers: { "content-length": String(1024 * 1024 + 1) },
          status: 200,
        }),
      ),
    );
    await expect(
      oversized.resolve("https://www.xiaohongshu.com/explore/abcdef123", "request-4"),
    ).rejects.toMatchObject({ code: "PUBLICATION_VERIFICATION_RESPONSE_TOO_LARGE" });

    const invalid = adapterWith(
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          body: "正文",
          canonicalUrl: "https://evil.example.test/explore/abcdef123",
          images: [],
          status: "AVAILABLE",
          title: "标题",
        }),
      ),
    );
    await expect(
      invalid.resolve("https://www.xiaohongshu.com/explore/abcdef123", "request-5"),
    ).rejects.toMatchObject({ code: "PUBLICATION_VERIFICATION_INVALID_RESPONSE" });
  });
});

function adapterWith(fetcher: typeof fetch): HttpPublicationVerificationAdapter {
  return new HttpPublicationVerificationAdapter({
    allowHttp: true,
    apiKey: "adapter-secret-key",
    endpoint: "http://127.0.0.1:19090/v1/resolve",
    fetch: fetcher,
    provider: "UNIT_TEST",
    timeoutMs: 1_000,
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
