import { ConflictException } from "@nestjs/common";
import { withPublicHttpResponse } from "@xhs-agentic/network-security";
import { normalizePublicationUrl } from "../publication/publication-url";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_IMAGES = 20;

export type PublicContentImageEvidence = Readonly<{
  checksum: string | null;
  perceptualHash: string | null;
  url: string | null;
}>;

export type PublicContentEvidence = Readonly<{
  authorId?: string | null;
  adapterModel: string | null;
  adapterReference: string | null;
  adapterRequestId: string;
  body: string;
  canonicalKey: string;
  canonicalUrl: string;
  externalPublishedAt: string | null;
  hashtags: readonly string[];
  images: readonly PublicContentImageEvidence[];
  provider: string;
  title: string;
}>;

export type PublicContentResolution =
  | Readonly<{ available: false; reason: string }>
  | Readonly<{ available: true; evidence: PublicContentEvidence }>;

export class PublicationVerificationInvocationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class HttpPublicationVerificationAdapter {
  readonly providerCode: string;
  private readonly allowHttp: boolean;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch | undefined;
  private readonly timeoutMs: number;

  constructor(options: {
    allowHttp: boolean;
    apiKey: string;
    endpoint: string;
    fetch?: typeof fetch;
    provider: string;
    timeoutMs: number;
  }) {
    this.allowHttp = options.allowHttp;
    this.apiKey = required(options.apiKey, "Publication-verification API key");
    this.endpoint = endpointValue(options.endpoint, options.allowHttp);
    this.fetcher = options.fetch;
    this.providerCode = required(options.provider, "Publication-verification provider");
    this.timeoutMs = positiveInteger(options.timeoutMs, "Publication-verification timeout");
  }

  async resolve(url: string, requestId: string): Promise<PublicContentResolution> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const request: RequestInit = {
        body: JSON.stringify({ requestId, url }),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": requestId,
        },
        method: "POST",
        signal: controller.signal,
      };
      const consume = async (response: Response): Promise<PublicContentResolution> => {
        const raw = await boundedText(response);
        const payload = recordValue(raw);
        if (!response.ok) {
          throw new PublicationVerificationInvocationError(
            `Publication-verification provider returned HTTP ${response.status}`,
            nestedErrorCode(payload) ?? `PUBLICATION_VERIFICATION_HTTP_${response.status}`,
            response.status === 408 ||
              response.status === 409 ||
              response.status === 429 ||
              response.status >= 500,
          );
        }
        if (payload.status === "UNAVAILABLE") {
          return {
            available: false,
            reason: optionalString(payload.reason) ?? "Public content is temporarily unavailable",
          };
        }
        if (payload.status !== "AVAILABLE") {
          throw invalidResponse("Publication-verification status is invalid");
        }
        const normalized = normalizePublicationUrl(required(payload.canonicalUrl, "canonical URL"));
        if (normalized.classification !== "XHS_NOTE") {
          throw invalidResponse("Publication-verification canonical URL is not a Xiaohongshu note");
        }
        const images = imageValues(payload.images);
        const authorId = optionalString(payload.authorId);
        if (authorId && !/^[A-Za-z0-9_-]{6,100}$/u.test(authorId))
          throw invalidResponse("Publication-verification author ID is invalid");
        return {
          available: true,
          evidence: {
            authorId,
            adapterModel: optionalString(payload.model),
            adapterReference: optionalString(payload.reference),
            adapterRequestId:
              optionalString(payload.requestId) ??
              response.headers.get("x-request-id") ??
              response.headers.get("request-id") ??
              requestId,
            body: required(payload.body, "public body"),
            canonicalKey: normalized.canonicalKey,
            canonicalUrl: normalized.normalizedUrl,
            externalPublishedAt: optionalDateString(payload.externalPublishedAt),
            hashtags: stringArray(payload.hashtags, 100),
            images,
            provider: this.providerCode,
            title: required(payload.title, "public title"),
          },
        };
      };
      if (this.fetcher) {
        const response = await this.fetcher(this.endpoint, { ...request, redirect: "error" });
        return await consume(response);
      }
      return await withPublicHttpResponse(
        this.endpoint,
        request,
        { allowHttp: this.allowHttp, allowPrivate: this.allowHttp },
        consume,
      );
    } catch (error) {
      if (error instanceof PublicationVerificationInvocationError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new PublicationVerificationInvocationError(
          "Publication-verification provider timed out",
          "PUBLICATION_VERIFICATION_TIMEOUT",
          true,
        );
      }
      throw new PublicationVerificationInvocationError(
        "Publication-verification provider request failed",
        "PUBLICATION_VERIFICATION_NETWORK",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function endpointValue(value: string, allowHttp: boolean): string {
  const endpoint = new URL(required(value, "Publication-verification endpoint"));
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ConflictException(
      "Publication-verification endpoint cannot contain credentials, query or fragment",
    );
  }
  if (endpoint.protocol !== "https:" && !(allowHttp && endpoint.protocol === "http:")) {
    throw new ConflictException("Publication-verification endpoint must use HTTPS");
  }
  return endpoint.toString();
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) {
    throw new PublicationVerificationInvocationError(
      "Publication-verification response exceeds the size limit",
      "PUBLICATION_VERIFICATION_RESPONSE_TOO_LARGE",
      false,
    );
  }
  const value = await response.text();
  if (Buffer.byteLength(value, "utf8") > MAX_RESPONSE_BYTES) {
    throw new PublicationVerificationInvocationError(
      "Publication-verification response exceeds the size limit",
      "PUBLICATION_VERIFICATION_RESPONSE_TOO_LARGE",
      false,
    );
  }
  return value;
}

function recordValue(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Normalized below without exposing provider content.
  }
  throw invalidResponse("Publication-verification provider returned invalid JSON");
}

function imageValues(value: unknown): PublicContentImageEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_IMAGES) {
    throw invalidResponse("Publication-verification images are invalid");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw invalidResponse("Publication-verification image entry is invalid");
    }
    const image = item as Record<string, unknown>;
    const checksum = optionalString(image.checksum);
    const perceptualHash = optionalString(image.perceptualHash);
    const url = optionalString(image.url);
    if (checksum && !/^[0-9a-f]{64}$/iu.test(checksum)) {
      throw invalidResponse("Publication-verification image checksum is invalid");
    }
    if (perceptualHash && !/^[0-9a-f]{16,256}$/iu.test(perceptualHash)) {
      throw invalidResponse("Publication-verification image perceptual hash is invalid");
    }
    if (!checksum && !perceptualHash && !url) {
      throw invalidResponse("Publication-verification image evidence is empty");
    }
    return { checksum: checksum?.toLowerCase() ?? null, perceptualHash, url };
  });
}

function stringArray(value: unknown, max: number): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((item) => typeof item !== "string")
  ) {
    throw invalidResponse("Publication-verification string array is invalid");
  }
  return value as string[];
}

function optionalDateString(value: unknown): string | null {
  const text = optionalString(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw invalidResponse("Publication-verification publication time is invalid");
  }
  return date.toISOString();
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConflictException(`${label} is not configured`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new ConflictException(`${label} is invalid`);
  return value;
}

function nestedErrorCode(payload: Record<string, unknown>): string | null {
  const error = payload.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  return optionalString((error as Record<string, unknown>).code);
}

function invalidResponse(message: string): PublicationVerificationInvocationError {
  return new PublicationVerificationInvocationError(
    message,
    "PUBLICATION_VERIFICATION_INVALID_RESPONSE",
    false,
  );
}
