import { randomUUID } from "node:crypto";
import { PublicHttpPolicyError, withPublicHttpResponse } from "@xhs-agentic/network-security";
import {
  type ContentSafetyCategory,
  type ContentSafetyDecision,
  ContentSafetyInvocationError,
  type ContentSafetyScanInput,
  type ContentSafetyScanner,
  type ContentSafetyScanResult,
} from "./types";
import { applyXhsMedicalPromotionPolicy } from "./xhs-medical-promotion";

const MAX_IMAGES = 9;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

export type HttpContentSafetyOptions = Readonly<{
  allowHttp?: boolean;
  allowPrivateEndpoint?: boolean;
  apiKey: string;
  endpoint: string;
  fetch?: typeof fetch;
  provider: string;
  requireProductionCredential?: boolean;
  timeoutMs?: number;
}>;

/**
 * Vendor-neutral content-safety contract.
 *
 * Request: { requestId, text, images: [{ sequence, mimeType, checksum, base64 }] }
 * Response: { decision, requestId?, model?, categories?: [{ code, decision, score?, message? }] }
 */
export class HttpContentSafetyScanner implements ContentSafetyScanner {
  private readonly allowHttp: boolean;
  private readonly allowPrivateEndpoint: boolean;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch | undefined;
  private readonly provider: string;
  private readonly timeoutMs: number;

  constructor(options: HttpContentSafetyOptions) {
    this.allowHttp = options.allowHttp === true;
    this.allowPrivateEndpoint = options.allowPrivateEndpoint === true;
    this.endpoint = normalizedEndpoint(options.endpoint, this.allowHttp, this.allowPrivateEndpoint);
    this.apiKey = required(options.apiKey, "Content-safety API key");
    if (options.requireProductionCredential === true && !productionCredential(this.apiKey, 4)) {
      throw new Error("Content-safety API key is a development placeholder");
    }
    this.provider = required(options.provider, "Content-safety provider code");
    this.fetcher = options.fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, "Content-safety timeout");
  }

  async scan(input: ContentSafetyScanInput): Promise<ContentSafetyScanResult> {
    validateInput(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    let httpStatus: number | undefined;
    let providerRequestId: string | undefined;
    try {
      const request: RequestInit = {
        body: JSON.stringify({
          images: input.images.map((image) => ({
            base64: Buffer.from(image.bytes).toString("base64"),
            checksum: image.checksum,
            mimeType: image.mimeType,
            sequence: image.sequence,
          })),
          requestId: input.requestId,
          text: input.text,
          ...(input.publishingContext ? { publishingContext: input.publishingContext } : {}),
          ...(input.sourceFacts ? { sourceFacts: input.sourceFacts.slice(0, 12000) } : {}),
        }),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": input.requestId,
        },
        method: "POST",
        signal: controller.signal,
      };
      const consume = async (response: Response): Promise<ContentSafetyScanResult> => {
        httpStatus = response.status;
        providerRequestId = (
          response.headers.get("x-request-id") ?? response.headers.get("request-id")
        )?.slice(0, 200);
        const raw = await boundedText(response, MAX_RESPONSE_BYTES);
        if (!response.ok) {
          let payload: Record<string, unknown> = {};
          try {
            payload = parseRecord(raw);
          } catch {
            // Upstream proxies may return HTML for a transient HTTP failure.
          }
          throw new ContentSafetyInvocationError(
            `Content-safety provider returned HTTP ${response.status}`,
            nestedCode(payload) ?? `CONTENT_SAFETY_HTTP_${response.status}`,
            response.status === 408 ||
              response.status === 409 ||
              response.status === 429 ||
              response.status >= 500,
          );
        }
        const payload = parseRecord(raw);
        providerRequestId = (
          optionalString(payload.requestId) ??
          providerRequestId ??
          randomUUID()
        ).slice(0, 200);
        const decision = decisionValue(payload.decision);
        return applyXhsMedicalPromotionPolicy(input.text, {
          categories: categoryValues(payload.categories),
          checkedAt: new Date().toISOString(),
          decision,
          latencyMs: Date.now() - startedAt,
          model: optionalString(payload.model),
          provider: this.provider,
          providerRequestId,
        });
      };
      if (this.fetcher) {
        const response = await this.fetcher(this.endpoint, { ...request, redirect: "error" });
        return await consume(response);
      }
      return await withPublicHttpResponse(
        this.endpoint,
        request,
        { allowHttp: this.allowHttp, allowPrivate: this.allowPrivateEndpoint },
        consume,
      );
    } catch (error) {
      const context = { httpStatus, provider: this.provider, providerRequestId };
      if (error instanceof ContentSafetyInvocationError)
        throw new ContentSafetyInvocationError(error.message, error.code, error.retryable, context);
      if (
        error instanceof PublicHttpPolicyError &&
        (error.code === "PUBLIC_HTTP_DNS_FAILED" || error.code === "PUBLIC_HTTP_DNS_EMPTY")
      )
        throw new ContentSafetyInvocationError(
          "Content-safety provider DNS resolution failed",
          "CONTENT_SAFETY_DNS_FAILED",
          true,
          context,
        );
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new ContentSafetyInvocationError(
          "Content-safety provider timed out",
          "CONTENT_SAFETY_TIMEOUT",
          true,
          context,
        );
      }
      throw new ContentSafetyInvocationError(
        "Content-safety provider request failed",
        "CONTENT_SAFETY_NETWORK",
        true,
        context,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function validateInput(input: ContentSafetyScanInput): void {
  required(input.requestId, "Content-safety request ID");
  if (input.requestId.length > 200) {
    throw invalidInput("Content-safety request ID is too long");
  }
  if (input.images.length < 1 || input.images.length > MAX_IMAGES) {
    throw invalidInput(`Content-safety requires between 1 and ${MAX_IMAGES} images`);
  }
  let totalBytes = 0;
  for (const image of input.images) {
    if (image.bytes.byteLength < 1 || image.bytes.byteLength > MAX_IMAGE_BYTES) {
      throw invalidInput("Content-safety image size is invalid");
    }
    if (!/^[0-9a-f]{64}$/u.test(image.checksum)) {
      throw invalidInput("Content-safety image checksum is invalid");
    }
    totalBytes += image.bytes.byteLength;
  }
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw invalidInput("Content-safety images exceed the aggregate size limit");
  }
  for (const value of [input.text.title, input.text.body, ...input.text.hashtags]) {
    if (typeof value !== "string") throw invalidInput("Content-safety text input is invalid");
  }
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new ContentSafetyInvocationError(
      "Content-safety response exceeds the size limit",
      "CONTENT_SAFETY_RESPONSE_TOO_LARGE",
      false,
    );
  }
  const value = await response.text();
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new ContentSafetyInvocationError(
      "Content-safety response exceeds the size limit",
      "CONTENT_SAFETY_RESPONSE_TOO_LARGE",
      false,
    );
  }
  return value;
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Normalized below without leaking provider response content.
  }
  throw new ContentSafetyInvocationError(
    "Content-safety provider returned invalid JSON",
    "CONTENT_SAFETY_INVALID_RESPONSE",
    false,
  );
}

function decisionValue(value: unknown): ContentSafetyDecision {
  if (value === "PASS" || value === "REVIEW" || value === "BLOCK") return value;
  throw new ContentSafetyInvocationError(
    "Content-safety provider returned an invalid decision",
    "CONTENT_SAFETY_INVALID_RESPONSE",
    false,
  );
}

function categoryValues(value: unknown): readonly ContentSafetyCategory[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new ContentSafetyInvocationError(
      "Content-safety provider returned invalid categories",
      "CONTENT_SAFETY_INVALID_RESPONSE",
      false,
    );
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ContentSafetyInvocationError(
        "Content-safety provider returned an invalid category",
        "CONTENT_SAFETY_INVALID_RESPONSE",
        false,
      );
    }
    const record = item as Record<string, unknown>;
    const score = record.score;
    if (score !== undefined && (typeof score !== "number" || !Number.isFinite(score))) {
      throw new ContentSafetyInvocationError(
        "Content-safety provider returned an invalid category score",
        "CONTENT_SAFETY_INVALID_RESPONSE",
        false,
      );
    }
    return {
      code: required(record.code, "Content-safety category code"),
      decision: decisionValue(record.decision),
      message: optionalString(record.message),
      score,
    };
  });
}

function nestedCode(payload: Record<string, unknown>): string | undefined {
  const error = payload.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  return optionalString((error as Record<string, unknown>).code);
}

function normalizedEndpoint(value: string, allowHttp: boolean, allowPrivate: boolean): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Content-safety endpoint must be an absolute URL");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Content-safety endpoint cannot contain credentials, query or fragment");
  }
  if (endpoint.protocol !== "https:" && !(allowHttp && endpoint.protocol === "http:")) {
    throw new Error("Content-safety endpoint must use HTTPS");
  }
  if (!allowPrivate && isPrivateHostname(endpoint.hostname)) {
    throw new Error("Content-safety endpoint must not target a private network");
  }
  return endpoint.toString();
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

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 120_000) {
    throw new Error(`${label} must be between 1000 and 120000 milliseconds`);
  }
  return value;
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function invalidInput(message: string): ContentSafetyInvocationError {
  return new ContentSafetyInvocationError(message, "CONTENT_SAFETY_INPUT_INVALID", false);
}
