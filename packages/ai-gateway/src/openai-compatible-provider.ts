import { randomUUID } from "node:crypto";
import { PublicHttpPolicyError, withPublicHttpResponse } from "@xhs-agentic/network-security";
import {
  normalizeEmbeddingVector,
  prepareEmbeddingInputs,
  resolveEmbeddingProfile,
} from "./embedding-profile";
import { ProviderInvocationError } from "./errors";
import { generationDeliveryMode } from "./generation-delivery-mode";
import type {
  ImageGenerationOutput,
  ImageGenerationProvider,
  ImageGenerationRequest,
  TextEmbeddingOptions,
  TextEmbeddingOutput,
  TextEmbeddingProvider,
  TextGenerationOutput,
  TextGenerationProvider,
  TextGenerationRequest,
} from "./types";

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type FetchLike = typeof fetch;

export interface OpenAICompatibleProviderOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: FetchLike;
  headers?: Readonly<Record<string, string>>;
  imageCost?: number;
  inputCostPerMillionUnits?: number;
  maxImageBytes?: number;
  modelPricing?: Readonly<Record<string, ModelPricing>>;
  outputCostPerMillionUnits?: number;
  providerId: string;
  timeoutMs?: number;
}

export interface ModelPricing {
  imageCost?: number;
  inputCostPerMillionUnits?: number;
  outputCostPerMillionUnits?: number;
}

abstract class OpenAICompatibleProviderBase {
  readonly providerId: string;
  protected readonly fetcher: FetchLike | undefined;
  protected readonly imageCost: number;
  protected readonly inputCostPerMillionUnits: number;
  protected readonly maxImageBytes: number;
  protected readonly outputCostPerMillionUnits: number;
  private readonly modelPricing: Readonly<Record<string, ModelPricing>>;
  private readonly apiKey: string;
  private readonly allowHttpEndpoint: boolean;
  private readonly allowPrivateEndpoint: boolean;
  private readonly baseUrl: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("OpenAI-compatible API key cannot be empty");
    if (generationDeliveryMode() === "PRODUCTION" && !productionCredential(options.apiKey, 4)) {
      throw new Error("OpenAI-compatible API key is a development placeholder");
    }
    if (!Number.isFinite(options.timeoutMs ?? 60_000) || (options.timeoutMs ?? 60_000) < 1_000) {
      throw new Error("OpenAI-compatible timeout must be at least 1000ms");
    }
    this.providerId = options.providerId;
    this.apiKey = options.apiKey;
    const allowUnsafeTestEndpoint =
      generationDeliveryMode() !== "PRODUCTION" ||
      (process.env.NODE_ENV === "test" &&
        process.env.MODEL_PROVIDER_ALLOW_PRIVATE_TEST_URLS === "true");
    this.allowHttpEndpoint = allowUnsafeTestEndpoint;
    this.allowPrivateEndpoint = allowUnsafeTestEndpoint;
    this.baseUrl = providerBaseUrl(options.baseUrl);
    this.fetcher = options.fetch;
    this.headers = Object.freeze({ ...options.headers });
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.imageCost = nonNegative(options.imageCost ?? 0, "imageCost");
    this.inputCostPerMillionUnits = nonNegative(
      options.inputCostPerMillionUnits ?? 0,
      "inputCostPerMillionUnits",
    );
    this.outputCostPerMillionUnits = nonNegative(
      options.outputCostPerMillionUnits ?? 0,
      "outputCostPerMillionUnits",
    );
    this.maxImageBytes = positiveInteger(options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES);
    this.modelPricing = Object.freeze({ ...options.modelPricing });
  }

  protected async requestJson(path: string, body: unknown): Promise<HttpJsonResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      // The DNS-pinned transport uses its own undici version. Encode with the
      // native Request first so FormData is not coerced into "[object FormData]"
      // when crossing fetch implementations.
      const multipart =
        body instanceof FormData
          ? new Request("https://multipart.invalid", { method: "POST", body })
          : null;
      const request: RequestInit = {
        body: multipart ? new Uint8Array(await multipart.arrayBuffer()) : JSON.stringify(body),
        headers: {
          ...this.headers,
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": multipart?.headers.get("content-type") ?? "application/json",
        },
        method: "POST",
        signal: controller.signal,
      };
      const consume = async (response: Response): Promise<HttpJsonResult> => {
        const requestId =
          response.headers.get("x-request-id") ?? response.headers.get("request-id");
        const raw = await response.text();
        // Error pages may be HTML/plain text; preserve the HTTP failure instead
        // of hiding it behind MALFORMED_PROVIDER_RESPONSE. Never expose raw bodies.
        let payload: unknown;
        if (response.ok) payload = parseJson(raw);
        else {
          try {
            payload = JSON.parse(raw);
          } catch {
            payload = undefined;
          }
        }
        if (!response.ok) {
          const safeIdentifier = (value: string | undefined | null) =>
            value && !value.includes(this.apiKey) && /^[a-zA-Z0-9_.:-]{1,120}$/u.test(value)
              ? value
              : undefined;
          const providerCode = safeIdentifier(nestedString(payload, "error", "code"));
          throw new ProviderInvocationError(
            `Provider request POST ${path} failed with HTTP ${response.status}`,
            providerCode ?? `HTTP_${response.status}`,
            isRetryableStatus(response.status),
            {
              httpStatus: response.status,
              requestPath: path,
              requestId: safeIdentifier(requestId ?? stringValue(recordValue(payload).request_id)),
              upstreamStage: safeIdentifier(nestedString(payload, "error", "stage")),
            },
          );
        }
        if (!isRecord(payload)) {
          throw new ProviderInvocationError(
            "Provider returned an invalid JSON object",
            "INVALID_PROVIDER_RESPONSE",
            false,
          );
        }
        return {
          latencyMs: Date.now() - startedAt,
          payload,
          requestId: requestId ?? stringValue(payload.id) ?? randomUUID(),
        };
      };
      const endpoint = `${this.baseUrl}${path}`;
      if (this.fetcher) {
        const response = await this.fetcher(endpoint, { ...request, redirect: "error" });
        return await consume(response);
      }
      return await withPublicHttpResponse(
        endpoint,
        request,
        { allowHttp: this.allowHttpEndpoint, allowPrivate: this.allowPrivateEndpoint },
        consume,
      );
    } catch (error) {
      if (error instanceof ProviderInvocationError) throw error;
      if (error instanceof PublicHttpPolicyError && error.code === "PUBLIC_HTTP_DNS_FAILED") {
        throw new ProviderInvocationError(
          "Provider hostname lookup failed before sending the request",
          "PROVIDER_DNS_FAILED",
          true,
          { requestPath: path },
        );
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderInvocationError("Provider request timed out", "PROVIDER_TIMEOUT", true);
      }
      throw new ProviderInvocationError(
        "Provider network request failed",
        "PROVIDER_NETWORK",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  protected async downloadImage(url: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const parsed = new URL(url);
    const allowPrivateTestEndpoint =
      process.env.NODE_ENV === "test" &&
      process.env.MODEL_PROVIDER_ALLOW_PRIVATE_TEST_URLS === "true";
    if (
      parsed.protocol !== "https:" ||
      (generationDeliveryMode() === "PRODUCTION" &&
        !allowPrivateTestEndpoint &&
        isPrivateHostname(parsed.hostname))
    ) {
      throw new ProviderInvocationError(
        "Provider image URL must use public HTTPS",
        "UNSAFE_IMAGE_URL",
        false,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const request: RequestInit = { method: "GET", signal: controller.signal };
      const consume = async (response: Response) => {
        if (!response.ok) {
          throw new ProviderInvocationError(
            `Provider image download failed with HTTP ${response.status}`,
            `IMAGE_HTTP_${response.status}`,
            isRetryableStatus(response.status),
          );
        }
        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (contentLength > this.maxImageBytes) {
          throw new ProviderInvocationError(
            "Provider image exceeds size limit",
            "IMAGE_TOO_LARGE",
            false,
          );
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > this.maxImageBytes) {
          throw new ProviderInvocationError(
            "Provider image is empty or exceeds size limit",
            "INVALID_IMAGE_SIZE",
            false,
          );
        }
        return {
          bytes,
          mimeType: normalizeImageMime(response.headers.get("content-type")),
        };
      };
      if (this.fetcher) {
        const response = await this.fetcher(parsed, { ...request, redirect: "error" });
        return await consume(response);
      }
      return await withPublicHttpResponse(
        parsed,
        request,
        { allowPrivate: this.allowPrivateEndpoint, maxRedirects: 3 },
        consume,
      );
    } catch (error) {
      if (error instanceof ProviderInvocationError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderInvocationError(
          "Provider image download timed out",
          "IMAGE_TIMEOUT",
          true,
        );
      }
      throw new ProviderInvocationError("Provider image download failed", "IMAGE_NETWORK", true);
    } finally {
      clearTimeout(timer);
    }
  }

  protected estimatedTextCost(modelId: string, inputUnits: number, outputUnits: number): number {
    const pricing = this.modelPricing[modelId];
    return (
      (inputUnits * (pricing?.inputCostPerMillionUnits ?? this.inputCostPerMillionUnits) +
        outputUnits * (pricing?.outputCostPerMillionUnits ?? this.outputCostPerMillionUnits)) /
      1_000_000
    );
  }

  protected estimatedImageCost(modelId: string): number {
    return this.modelPricing[modelId]?.imageCost ?? this.imageCost;
  }
}

function providerBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("OpenAI-compatible Base URL must be absolute");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("OpenAI-compatible Base URL cannot contain credentials, query or fragment");
  }
  const production = generationDeliveryMode() === "PRODUCTION";
  const allowPrivateTestEndpoint =
    process.env.NODE_ENV === "test" &&
    process.env.MODEL_PROVIDER_ALLOW_PRIVATE_TEST_URLS === "true";
  if (
    !new Set(["http:", "https:"]).has(parsed.protocol) ||
    (production &&
      !allowPrivateTestEndpoint &&
      (parsed.protocol !== "https:" || isPrivateHostname(parsed.hostname)))
  ) {
    throw new Error(
      production
        ? "OpenAI-compatible Base URL must use public HTTPS in production"
        : "OpenAI-compatible Base URL must use HTTP or HTTPS",
    );
  }
  return parsed.toString().replace(/\/+$/u, "");
}

function isPrivateHostname(hostname: string): boolean {
  const value = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (value.startsWith("::ffff:")) return isPrivateHostname(value.slice(7));
  if (value.includes(":")) {
    return (
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      /^fe[89ab]/u.test(value) ||
      value.startsWith("ff")
    );
  }
  const parts = value.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part))) {
    const [a = 0, b = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  return (
    value === "localhost" ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    value === "metadata.google.internal"
  );
}

function productionCredential(value: string, minimumBytes: number): boolean {
  return (
    Buffer.byteLength(value, "utf8") >= minimumBytes &&
    !/(?:dev(?:elopment)?[-_ ]?only|replace[-_ ]?before[-_ ]?production|changeme|example|fixture|mock|synthetic|placeholder)/iu.test(
      value,
    )
  );
}

export class OpenAICompatibleTextProvider
  extends OpenAICompatibleProviderBase
  implements TextGenerationProvider
{
  async generate(modelId: string, request: TextGenerationRequest): Promise<TextGenerationOutput> {
    const result = await this.requestJson("/chat/completions", {
      max_tokens: request.maxOutputCharacters
        ? Math.max(64, Math.ceil(request.maxOutputCharacters / 2))
        : undefined,
      messages: [
        {
          content: request.images?.length
            ? [
                { type: "text", text: request.prompt },
                ...request.images.map((image) => ({
                  type: "image_url",
                  image_url: {
                    url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`,
                  },
                })),
              ]
            : request.prompt,
          role: "user",
        },
      ],
      model: modelId,
      temperature: request.temperature,
    });
    const choice = arrayValue(result.payload.choices)[0];
    const text = messageText(choice);
    if (!text) {
      throw new ProviderInvocationError(
        "Provider response did not contain generated text",
        "EMPTY_TEXT_OUTPUT",
        false,
      );
    }
    const usage = recordValue(result.payload.usage);
    const inputUnits = integerValue(usage.prompt_tokens) ?? integerValue(usage.input_tokens);
    const outputUnits = integerValue(usage.completion_tokens) ?? integerValue(usage.output_tokens);
    return {
      finishReason: stringValue(recordValue(choice).finish_reason) ?? "unknown",
      providerRequestId: result.requestId,
      text,
      usage: {
        estimatedCost: this.estimatedTextCost(modelId, inputUnits ?? 0, outputUnits ?? 0),
        inputUnits,
        outputUnits,
      },
    };
  }
}

export class OpenAICompatibleImageProvider
  extends OpenAICompatibleProviderBase
  implements ImageGenerationProvider
{
  async generate(modelId: string, request: ImageGenerationRequest): Promise<ImageGenerationOutput> {
    const gptImage = /(?:^|\/)gpt-image-/iu.test(modelId);
    const parameters = {
      model: modelId,
      n: 1,
      prompt: request.prompt,
      // GPT Image returns base64 by default; legacy response_format is not
      // supported by all compatible gateways. Keep it for legacy image models.
      ...(gptImage ? { output_format: "png" } : { response_format: "b64_json" }),
      size: /gpt-image-2/iu.test(modelId)
        ? `${Math.round(request.width / 16) * 16}x${Math.round(request.height / 16) * 16}`
        : `${request.width}x${request.height}`,
    };
    const references = request.referenceImages ?? [];
    if (references.length > 3)
      throw new ProviderInvocationError(
        "At most three reference images can be used",
        "REFERENCE_IMAGE_LIMIT",
        false,
      );
    let body: unknown = parameters;
    if (references.length) {
      const form = new FormData();
      for (const [key, value] of Object.entries(parameters)) form.append(key, String(value));
      references.forEach((reference, index) => {
        if (
          !reference.bytes.byteLength ||
          reference.bytes.byteLength > this.maxImageBytes ||
          !["image/png", "image/jpeg", "image/webp"].includes(reference.mimeType)
        ) {
          throw new ProviderInvocationError(
            "Invalid reference image",
            "INVALID_REFERENCE_IMAGE",
            false,
          );
        }
        form.append(
          "image[]",
          new Blob([new Uint8Array(reference.bytes)], { type: reference.mimeType }),
          `reference-${index + 1}.${reference.mimeType === "image/jpeg" ? "jpg" : reference.mimeType.split("/")[1]}`,
        );
      });
      body = form;
    }
    // Do not silently drop references or switch to text-only generation on an edit failure.
    const result = await this.requestJson(
      references.length ? "/images/edits" : "/images/generations",
      body,
    );
    const image = recordValue(arrayValue(result.payload.data)[0]);
    const base64 = stringValue(image.b64_json);
    const remoteUrl = stringValue(image.url);
    let bytes: Uint8Array;
    let mimeType: string;
    if (base64) {
      bytes = new Uint8Array(Buffer.from(base64, "base64"));
      if (bytes.byteLength === 0 || bytes.byteLength > this.maxImageBytes) {
        throw new ProviderInvocationError(
          "Provider image is empty or exceeds size limit",
          "INVALID_IMAGE_SIZE",
          false,
        );
      }
      mimeType = detectImageMime(bytes);
    } else if (remoteUrl) {
      ({ bytes, mimeType } = await this.downloadImage(remoteUrl));
    } else {
      throw new ProviderInvocationError(
        "Provider response did not contain image bytes or URL",
        "EMPTY_IMAGE_OUTPUT",
        false,
      );
    }
    return {
      bytes,
      height: request.height,
      mimeType,
      providerRequestId: result.requestId,
      usage: { estimatedCost: this.estimatedImageCost(modelId) },
      width: request.width,
    };
  }
}

export class OpenAICompatibleEmbeddingProvider
  extends OpenAICompatibleProviderBase
  implements TextEmbeddingProvider
{
  async embed(
    modelId: string,
    texts: readonly string[],
    options?: TextEmbeddingOptions,
  ): Promise<TextEmbeddingOutput> {
    if (texts.length === 0 || texts.length > 128) {
      throw new Error("Embedding requests must contain between 1 and 128 texts");
    }
    const profile = options?.profile ?? resolveEmbeddingProfile({ externalModelId: modelId });
    const result = await this.requestJson("/embeddings", {
      input: prepareEmbeddingInputs(texts, options?.inputKind ?? "DOCUMENT", profile),
      model: modelId,
      ...(profile.kind === "QWEN3_0_6B" ? { encoding_format: "float" } : {}),
    });
    const rows = arrayValue(result.payload.data)
      .map(recordValue)
      .sort((left, right) => (integerValue(left.index) ?? 0) - (integerValue(right.index) ?? 0));
    if (profile.kind === "QWEN3_0_6B" && rows.some((row, index) => row.index !== index)) {
      throw new ProviderInvocationError(
        "Embedding response indexes are invalid",
        "INVALID_EMBEDDING_INDEXES",
        false,
      );
    }
    let vectors: number[][];
    try {
      vectors = rows.map((row) => normalizeEmbeddingVector(numericVector(row.embedding), profile));
    } catch {
      throw new ProviderInvocationError(
        "Embedding output does not match the configured vector profile",
        "INVALID_EMBEDDING_PROFILE",
        false,
      );
    }
    if (vectors.length !== texts.length || vectors.some((vector) => vector.length === 0)) {
      throw new ProviderInvocationError(
        "Provider response did not contain all embedding vectors",
        "INVALID_EMBEDDING_OUTPUT",
        false,
      );
    }
    const firstVector = vectors[0];
    if (!firstVector) {
      throw new ProviderInvocationError(
        "Provider response did not contain an embedding vector",
        "INVALID_EMBEDDING_OUTPUT",
        false,
      );
    }
    const dimensions = firstVector.length;
    if (vectors.some((vector) => vector.length !== dimensions)) {
      throw new ProviderInvocationError(
        "Provider returned inconsistent embedding dimensions",
        "INVALID_EMBEDDING_DIMENSIONS",
        false,
      );
    }
    const usage = recordValue(result.payload.usage);
    const inputUnits = integerValue(usage.prompt_tokens) ?? integerValue(usage.total_tokens);
    return {
      dimensions,
      providerRequestId: result.requestId,
      usage: {
        estimatedCost: this.estimatedTextCost(modelId, inputUnits ?? 0, 0),
        inputUnits,
      },
      vectors,
    };
  }
}

type HttpJsonResult = Readonly<{
  latencyMs: number;
  payload: Record<string, unknown>;
  requestId: string;
}>;

function messageText(value: unknown): string | undefined {
  const choice = recordValue(value);
  const message = recordValue(choice.message);
  const content = message.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => stringValue(recordValue(part).text))
    .filter((part): part is string => Boolean(part))
    .join("")
    .trim();
  return text || undefined;
}

function parseJson(value: string): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ProviderInvocationError(
      "Provider returned malformed JSON",
      "MALFORMED_PROVIDER_RESPONSE",
      false,
    );
  }
}

function nestedString(value: unknown, parent: string, child: string): string | undefined {
  return stringValue(recordValue(recordValue(value)[parent])[child]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numericVector(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const vector: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return [];
    vector.push(item);
  }
  return vector;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function normalizeImageMime(value: string | null): string {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "image/png" || mime === "image/jpeg" || mime === "image/webp") return mime;
  return "application/octet-stream";
}

function detectImageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("maxImageBytes must be positive");
  return value;
}
