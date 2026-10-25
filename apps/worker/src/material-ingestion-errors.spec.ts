import { ProviderInvocationError } from "@xhs-agentic/ai-gateway";
import { describe, expect, it } from "vitest";
import {
  classifyArtifactReadError,
  classifyIngestionError,
  classifyModelIngestionError,
  MaterialIngestionError,
} from "./material-ingestion-errors";

describe("safe material ingestion failure classification", () => {
  it.each([
    [401, "invalid_api_key", "AUTH_FAILED", false],
    [403, "permission_denied", "AUTH_FAILED", false],
    [403, "GW_MODEL_NOT_ALLOWED", "MODEL_NOT_ALLOWED", true],
    [403, "GW_QUOTA_EXCEEDED", "QUOTA_EXCEEDED", true],
    [429, "GW_QUOTA_EXCEEDED", "QUOTA_EXCEEDED", true],
    [429, "GW_QUOTA_MEMBER_BUDGET", "QUOTA_EXCEEDED", true],
    [429, "GW_QUOTA_RATE_LIMIT", "RATE_LIMITED", true],
    [403, "unknown_provider_policy", "AUTH_FAILED", false],
    [400, "invalid_api_key", "AUTH_FAILED", true],
    [402, "payment_required", "QUOTA_EXCEEDED", false],
    [429, "insufficient_quota", "QUOTA_EXCEEDED", true],
    [429, "rate_limit_exceeded", "RATE_LIMITED", true],
    [404, "HTTP_404", "MODEL_NOT_FOUND", false],
    [400, "invalid_request_error", "INVALID_REQUEST", false],
    [504, "HTTP_504", "TIMEOUT", true],
    [503, "HTTP_503", "SERVICE_UNAVAILABLE", true],
  ])("maps HTTP %s / %s without storing provider payloads", (status, code, reason, retryable) => {
    const error = new ProviderInvocationError(
      "API key sk-private-test, recipient@example.com, uploaded private material",
      code,
      retryable,
      { httpStatus: status, requestId: "private-request-id" },
    );
    for (const stage of ["MATERIAL_ANALYSIS", "EMBEDDING"] as const) {
      const result = classifyModelIngestionError(error, stage);
      expect(result).toMatchObject({
        code: `${stage}_${reason}`,
        retryable:
          reason === "AUTH_FAILED" || reason === "QUOTA_EXCEEDED" || reason === "MODEL_NOT_ALLOWED"
            ? false
            : retryable,
      });
      expect(result.message).toMatch(/[\u4e00-\u9fff]/u);
      expect(result.message).not.toMatch(/sk-private|example\.com|uploaded|private-request/u);
    }
  });

  it.each([
    ["PROVIDER_TIMEOUT", "TIMEOUT", true],
    ["PROVIDER_NETWORK", "NETWORK", true],
    ["INVALID_EMBEDDING_PROFILE", "INVALID_RESPONSE", false],
    ["INVALID_EMBEDDING_OUTPUT", "INVALID_RESPONSE", false],
    ["INVALID_EMBEDDING_DIMENSIONS", "INVALID_RESPONSE", false],
    ["MALFORMED_PROVIDER_RESPONSE", "INVALID_RESPONSE", false],
  ])("preserves %s failure semantics in its actual stage", (code, reason, retryable) => {
    const error = new ProviderInvocationError("untrusted response", code, retryable);
    expect(classifyModelIngestionError(error, "EMBEDDING")).toMatchObject({
      code: `EMBEDDING_${reason}`,
      retryable,
    });
  });

  it("infers Embedding only from the owned /embeddings request path", () => {
    expect(
      classifyIngestionError(
        new ProviderInvocationError("private response", "HTTP_401", false, {
          httpStatus: 401,
          requestPath: "/embeddings",
        }),
      ),
    ).toMatchObject({ code: "EMBEDDING_AUTH_FAILED", retryable: false });
  });

  it("does not invent a reason from an unknown provider code or expose it", () => {
    const failure = classifyModelIngestionError(
      new ProviderInvocationError("sk-secret is exhausted", "SK_SECRET", false),
      "MATERIAL_ANALYSIS",
    );
    expect(failure).toMatchObject({ code: "MATERIAL_ANALYSIS_REQUEST_FAILED", retryable: false });
    expect(failure.message).not.toMatch(/SK_SECRET|sk-secret|额度/u);
  });

  it.each(["CUSTOMER_PRIVATE_DOCUMENT", "MATERIAL_ANALYSIS_constructor"])(
    "does not publish an arbitrary %s error message as a trusted code",
    (message) => {
      const result = classifyIngestionError(new Error(message));
      expect(result).toMatchObject({ code: "MATERIAL_INGESTION_UNEXPECTED", retryable: true });
      expect(result.message).not.toContain(message);
    },
  );

  it("keeps existing owned error codes and explicit retry decisions", () => {
    const deterministic = new MaterialIngestionError("FILE_MAGIC_MISMATCH", false);
    expect(classifyIngestionError(deterministic)).toBe(deterministic);
    expect(classifyIngestionError(new Error("MATERIAL_ANALYSIS_INVALID_ENTITY"))).toMatchObject({
      code: "MATERIAL_ANALYSIS_INVALID_ENTITY",
      retryable: true,
    });
  });

  it("distinguishes missing files, storage permissions and temporary storage failures", () => {
    expect(
      classifyArtifactReadError({ name: "NoSuchKey", message: "private file key" }),
    ).toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
      retryable: false,
    });
    expect(
      classifyArtifactReadError({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } }),
    ).toMatchObject({ code: "STORAGE_ACCESS_DENIED", retryable: false });
    expect(classifyArtifactReadError(new Error("password and storage endpoint"))).toMatchObject({
      code: "STORAGE_READ_FAILED",
      retryable: true,
    });
  });
});
