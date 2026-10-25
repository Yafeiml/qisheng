import { PublicHttpPolicyError } from "@xhs-agentic/network-security";
import { describe, expect, it, vi } from "vitest";
import type { ProviderInvocationError } from "./errors";
import {
  OpenAICompatibleImageProvider,
  OpenAICompatibleTextProvider,
} from "./openai-compatible-provider";

const context = { generationRunId: "run-1", tenantId: "tenant-1" };

describe("OpenAI-compatible providers", () => {
  it("reports DNS failure separately without hiding the request stage or exposing credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new PublicHttpPolicyError("Internal resolver details", "PUBLIC_HTTP_DNS_FAILED"),
      );
    const provider = new OpenAICompatibleImageProvider({
      apiKey: "secret",
      baseUrl: "https://provider.example/v1",
      providerId: "image",
      fetch: fetcher,
    });
    await expect(
      provider.generate("image-model", {
        context,
        prompt: "科普配图",
        width: 1080,
        height: 1440,
        seed: "seed",
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_DNS_FAILED",
      retryable: true,
      details: { requestPath: "/images/generations" },
      message: "Provider hostname lookup failed before sending the request",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("sends selected reference bytes through multipart edits without replacing the configured model", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from([137, 80, 78, 71]).toString("base64") }],
        }),
      ),
    );
    const provider = new OpenAICompatibleImageProvider({
      apiKey: "secret",
      baseUrl: "https://provider.example/v1",
      providerId: "image",
      fetch: fetcher,
    });
    const original = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    await provider.generate("gpt-image-2.5", {
      context,
      prompt: "保留人物，制作少字海报",
      width: 1080,
      height: 1440,
      seed: "seed",
      referenceImages: [
        { bytes: original, mimeType: "image/png", description: "周示例白衣形象照" },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://provider.example/v1/images/edits");
    const request = fetcher.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("Content-Type")).toContain(
      "multipart/form-data; boundary=",
    );
    const body = await new Response(request?.body, { headers: request?.headers }).formData();
    expect(body.get("model")).toBe("gpt-image-2.5");
    expect(body.getAll("image[]")).toHaveLength(1);
    expect(new Uint8Array(await (body.get("image[]") as Blob).arrayBuffer())).toEqual(original);
  });

  it("does not fall back to text-only generation when the edit endpoint rejects a reference", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unsupported", { status: 400 }));
    const provider = new OpenAICompatibleImageProvider({
      apiKey: "secret",
      baseUrl: "https://provider.example/v1",
      providerId: "image",
      fetch: fetcher,
    });
    await expect(
      provider.generate("gpt-image-2.5", {
        context,
        prompt: "海报",
        width: 1080,
        height: 1440,
        seed: "seed",
        referenceImages: [
          { bytes: new Uint8Array([1]), mimeType: "image/png", description: "人物" },
        ],
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the GPT Image body without legacy format or unrelated user fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from([137, 80, 78, 71]).toString("base64") }],
        }),
      ),
    );
    const provider = new OpenAICompatibleImageProvider({
      apiKey: "secret",
      baseUrl: "https://provider.example/v1",
      providerId: "image",
      fetch: fetcher,
    });
    await provider.generate("gpt-image-2", {
      context,
      prompt: "Test",
      width: 1024,
      height: 1536,
      seed: "seed",
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      model: "gpt-image-2",
      prompt: "Test",
      n: 1,
      size: "1024x1536",
      output_format: "png",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://provider.example/v1/images/generations");
  });

  it("preserves safe gateway diagnostics and never replays an unsupported image request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "GW_REQUEST_NOT_SUPPORTED",
            stage: "cpa_absorption_pending",
            message: "secret-that-must-not-leak",
          },
          request_id: "request-1",
        }),
        { status: 404 },
      ),
    );
    const provider = new OpenAICompatibleImageProvider({
      apiKey: "secret-that-must-not-leak",
      baseUrl: "https://provider.example/v1",
      providerId: "image",
      fetch: fetcher,
    });
    const error = await provider
      .generate("gpt-image-2", { context, prompt: "Test", width: 1024, height: 1536, seed: "seed" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "GW_REQUEST_NOT_SUPPORTED",
      retryable: false,
      details: {
        httpStatus: 404,
        requestPath: "/images/generations",
        requestId: "request-1",
        upstreamStage: "cpa_absorption_pending",
      },
    });
    expect(JSON.stringify(error)).not.toContain("secret-that-must-not-leak");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps HTTP status for HTML errors and drops secret-bearing diagnostic identifiers", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("<html>secret</html>", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "secret", stage: "secret" }, request_id: "secret" }),
          { status: 401 },
        ),
      );
    const provider = new OpenAICompatibleTextProvider({
      apiKey: "secret",
      baseUrl: "https://provider.example/v1",
      providerId: "text",
      fetch: fetcher,
    });
    await expect(provider.generate("text", { context, prompt: "Test" })).rejects.toMatchObject({
      code: "HTTP_502",
      details: { httpStatus: 502 },
    });
    const error = await provider
      .generate("text", { context, prompt: "Test" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "HTTP_401", details: { httpStatus: 401 } });
    expect(JSON.stringify(error)).not.toContain("secret");
  });
  it("sends original image bytes with the understanding prompt", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "图片描述" } }],
        }),
      ),
    );
    const provider = new OpenAICompatibleTextProvider({
      apiKey: "secret",
      baseUrl: "https://provider.example/v1",
      providerId: "vision",
      fetch: fetcher,
    });
    const bytes = new Uint8Array([137, 80, 78, 71]);
    await provider.generate("vision-model", {
      context,
      prompt: "识别图片主体",
      images: [{ bytes, mimeType: "image/png" }],
    });
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(request.messages[0].content).toEqual([
      { type: "text", text: "识别图片主体" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` },
      },
    ]);
  });
  it("maps chat completions without exposing credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "  可发布文案  " } }],
          id: "text-request-1",
          usage: { completion_tokens: 20, prompt_tokens: 100 },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    );
    const provider = new OpenAICompatibleTextProvider({
      apiKey: "secret-that-must-not-leak",
      baseUrl: "https://provider.example/v1/",
      fetch: fetcher,
      inputCostPerMillionUnits: 1,
      outputCostPerMillionUnits: 2,
      providerId: "provider-a",
    });

    const output = await provider.generate("text-model", { context, prompt: "生成文案" });

    expect(output).toMatchObject({
      finishReason: "stop",
      providerRequestId: "text-request-1",
      text: "可发布文案",
      usage: { estimatedCost: 0.00014, inputUnits: 100, outputUnits: 20 },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://provider.example/v1/chat/completions",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });

  it("decodes base64 image output and records configured unit cost", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const provider = new OpenAICompatibleImageProvider({
      apiKey: "secret",
      baseUrl: "https://provider.example/v1",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ b64_json: png.toString("base64") }], id: "img-1" }),
          {
            status: 200,
          },
        ),
      ),
      imageCost: 0.12,
      providerId: "provider-a",
    });

    const output = await provider.generate("image-model", {
      context,
      height: 1440,
      prompt: "竖版海报",
      seed: "member-1",
      width: 1080,
    });

    expect(Buffer.from(output.bytes)).toEqual(png);
    expect(output).toMatchObject({
      height: 1440,
      mimeType: "image/png",
      providerRequestId: "img-1",
      usage: { estimatedCost: 0.12 },
      width: 1080,
    });
  });

  it("normalizes throttling into a retryable provider error", async () => {
    const provider = new OpenAICompatibleTextProvider({
      apiKey: "secret",
      baseUrl: "https://provider.example/v1",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { code: "rate_limit" } }), { status: 429 }),
        ),
      providerId: "provider-a",
    });

    const promise = provider.generate("text-model", { context, prompt: "生成文案" });
    await expect(promise).rejects.toMatchObject({
      code: "rate_limit",
      retryable: true,
    } satisfies Partial<ProviderInvocationError>);
  });

  it("rejects private provider endpoints in production delivery mode", () => {
    const beforeMode = process.env.GENERATION_DELIVERY_MODE;
    const beforeNodeEnvironment = process.env.NODE_ENV;
    process.env.GENERATION_DELIVERY_MODE = "PRODUCTION";
    process.env.NODE_ENV = "production";
    try {
      expect(
        () =>
          new OpenAICompatibleTextProvider({
            apiKey: "provider-production-secret",
            baseUrl: "https://127.0.0.1/v1",
            providerId: "provider-a",
          }),
      ).toThrow(/public HTTPS/u);
    } finally {
      if (beforeMode === undefined) delete process.env.GENERATION_DELIVERY_MODE;
      else process.env.GENERATION_DELIVERY_MODE = beforeMode;
      if (beforeNodeEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = beforeNodeEnvironment;
    }
  });
});
