import { ModelRoutingError } from "@xhs-agentic/ai-gateway";
import { Prisma } from "@xhs-agentic/database";
import { describe, expect, it } from "vitest";
import {
  classifyGenerationError,
  generationRetryDelayMs,
  PermanentGenerationError,
} from "./generation-execution";

describe("generation error policy", () => {
  it("uses the final routed provider attempt to distinguish retryable failures", () => {
    const retryable = new ModelRoutingError("temporary", [
      {
        attempt: 1,
        errorCode: "PROVIDER_TIMEOUT",
        latencyMs: 1_000,
        modelId: "text-a",
        providerId: "provider-a",
        retryable: true,
        status: "FAILED",
      },
    ]);
    const permanent = new ModelRoutingError("invalid output", [
      {
        attempt: 1,
        errorCode: "INVALID_PROVIDER_RESPONSE",
        latencyMs: 10,
        modelId: "text-a",
        providerId: "provider-a",
        retryable: false,
        status: "FAILED",
      },
    ]);

    expect(classifyGenerationError(retryable)).toMatchObject({
      code: "PROVIDER_TIMEOUT",
      retryable: true,
    });
    expect(classifyGenerationError(permanent)).toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
      retryable: false,
    });
  });

  it("never retries explicitly permanent generation state and bounds exponential delay", () => {
    expect(
      classifyGenerationError(new PermanentGenerationError("invalid route", "ROUTE_INVALID")),
    ).toMatchObject({ code: "ROUTE_INVALID", retryable: false });
    expect(generationRetryDelayMs(1, 2_000)).toBe(2_000);
    expect(generationRetryDelayMs(4, 2_000)).toBe(16_000);
    expect(generationRetryDelayMs(99, 2_000)).toBeLessThanOrEqual(300_000);
  });

  it("retries PostgreSQL serialization conflicts surfaced through Prisma raw queries", () => {
    const conflict = new Prisma.PrismaClientKnownRequestError(
      "Raw query failed. Code: `40001`. Message: `could not serialize access due to concurrent update`",
      {
        clientVersion: "6.19.3",
        code: "P2010",
        meta: { code: "40001" },
      },
    );

    expect(classifyGenerationError(conflict)).toMatchObject({
      code: "PRISMA_SERIALIZATION_CONFLICT",
      retryable: true,
    });
  });
});
