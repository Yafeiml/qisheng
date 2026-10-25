import { ModelRoutingError, ProviderInvocationError } from "@xhs-agentic/ai-gateway";
import { ContentSafetyInvocationError } from "@xhs-agentic/content-safety";
import { Prisma } from "@xhs-agentic/database";

export type GenerationExecutionKind = "RUN" | "WORK_ITEM";

export interface GenerationExecutionLease {
  attemptCount: number;
  executionVersion: number;
  id: string;
  kind: GenerationExecutionKind;
  leaseOwner: string;
  leaseToken: string;
  maxAttempts: number;
  queueVersion: number;
  tenantId: string;
}

export interface GenerationErrorClassification {
  code: string;
  message: string;
  retryable: boolean;
  modelFailure?: boolean;
}

export class GenerationLeaseLostError extends Error {
  constructor(readonly lease: GenerationExecutionLease) {
    super(`Generation ${lease.kind.toLowerCase()} execution lease is no longer owned`);
    this.name = "GenerationLeaseLostError";
  }
}

export class PermanentGenerationError extends Error {
  constructor(
    message: string,
    readonly code = "GENERATION_INPUT_INVALID",
  ) {
    super(message);
    this.name = "PermanentGenerationError";
  }
}

export function classifyGenerationError(error: unknown): GenerationErrorClassification {
  if (error instanceof GenerationLeaseLostError) {
    return { code: "EXECUTION_LEASE_LOST", message: safeGenerationError(error), retryable: false };
  }
  if (error instanceof PermanentGenerationError) {
    return { code: error.code, message: safeGenerationError(error), retryable: false };
  }
  if (error instanceof ModelRoutingError) {
    const lastFailure = [...error.attempts].reverse().find(({ status }) => status === "FAILED");
    return {
      modelFailure: true,
      code: lastFailure?.errorCode ?? "MODEL_ROUTING_FAILED",
      message: safeGenerationError(error),
      retryable: lastFailure?.retryable === true,
    };
  }
  if (error instanceof ProviderInvocationError) {
    return {
      code: error.code,
      message: safeGenerationError(error),
      retryable: error.retryable,
    };
  }
  if (error instanceof ContentSafetyInvocationError) {
    return {
      code: error.code,
      message: safeGenerationError(error),
      retryable: error.retryable,
    };
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return {
      code: isPrismaSerializationConflict(error)
        ? "PRISMA_SERIALIZATION_CONFLICT"
        : `PRISMA_${error.code}`,
      message: safeGenerationError(error),
      retryable: TRANSIENT_PRISMA_CODES.has(error.code) || isPrismaSerializationConflict(error),
    };
  }
  const systemCode = systemErrorCode(error);
  if (systemCode && TRANSIENT_SYSTEM_CODES.has(systemCode)) {
    return { code: systemCode, message: safeGenerationError(error), retryable: true };
  }
  return {
    code: "GENERATION_UNEXPECTED",
    message: safeGenerationError(error),
    retryable: true,
  };
}

export function generationRetryDelayMs(attemptCount: number, baseDelayMs: number): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 8));
  return Math.min(baseDelayMs * 2 ** exponent, 5 * 60_000);
}

export function safeGenerationError(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown generation error").slice(0, 2_000);
}

export function isPrismaSerializationConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010") return false;
  const metadataCode =
    error.meta && typeof error.meta === "object" && "code" in error.meta
      ? String(error.meta.code)
      : undefined;
  return metadataCode === "40001" || /\b40001\b|could not serialize access/iu.test(error.message);
}

const TRANSIENT_PRISMA_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2034"]);
const TRANSIENT_SYSTEM_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
