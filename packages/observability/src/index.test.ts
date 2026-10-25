import { describe, expect, it } from "vitest";
import {
  postgresConnectionStringWithUtcSession,
  runWithLogContext,
  sanitizeLogValue,
} from "./index";

describe("postgresConnectionStringWithUtcSession", () => {
  it("adds a UTC session option while preserving existing query parameters", () => {
    const result = new URL(
      postgresConnectionStringWithUtcSession(
        "postgresql://user:password@127.0.0.1:5432/app?schema=public",
      ),
    );

    expect(result.searchParams.get("schema")).toBe("public");
    expect(result.searchParams.get("options")).toBe("-c timezone=UTC");
  });

  it("preserves other postgres options and remains idempotent", () => {
    const first = postgresConnectionStringWithUtcSession(
      "postgresql://user:password@127.0.0.1:5432/app?options=-c%20statement_timeout%3D5000",
    );
    const second = postgresConnectionStringWithUtcSession(first);

    expect(new URL(first).searchParams.get("options")).toBe(
      "-c statement_timeout=5000 -c timezone=UTC",
    );
    expect(second).toBe(first);
  });
});

describe("structured log boundaries", () => {
  it("redacts credentials recursively while preserving operational identifiers", () => {
    expect(
      sanitizeLogValue({
        apiKey: "sk-private-value",
        authorization: "Bearer token-value",
        errorCode: "PROVIDER_TIMEOUT",
        nested: { password: "private", url: "redis://user:private@127.0.0.1:6379" },
        requestId: "request-001",
      }),
    ).toEqual({
      apiKey: "[REDACTED]",
      authorization: "[REDACTED]",
      errorCode: "PROVIDER_TIMEOUT",
      nested: { password: "[REDACTED]", url: "redis://user:[REDACTED]@127.0.0.1:6379" },
      requestId: "request-001",
    });
  });

  it("inherits and extends asynchronous log context", async () => {
    await runWithLogContext({ requestId: "request-001", tenantId: "tenant-001" }, async () => {
      await Promise.resolve();
      await runWithLogContext({ generationRunId: "run-001" }, async () => {
        const { currentLogContext } = await import("./index.js");
        expect(currentLogContext()).toEqual({
          generationRunId: "run-001",
          requestId: "request-001",
          tenantId: "tenant-001",
        });
      });
    });
  });

  it("bounds circular runtime values", () => {
    const value: { child?: unknown; name: string } = { name: "root" };
    value.child = value;
    expect(sanitizeLogValue(value)).toEqual({ child: "[Circular]", name: "root" });
  });

  it("masks Chinese mobile numbers in provider and directory messages", () => {
    expect(
      sanitizeLogValue({
        message: "人员 13812345678 同步失败，备用号码为 18687654321",
      }),
    ).toEqual({
      message: "人员 138****5678 同步失败，备用号码为 186****4321",
    });
  });
});
