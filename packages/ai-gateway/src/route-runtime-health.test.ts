import { describe, expect, it } from "vitest";
import {
  isModelRuntimeFailure,
  ROUTE_RUNTIME_FAILURE,
  ROUTE_RUNTIME_SUCCESS,
  summarizeRouteRuntimeHealth,
} from "./route-runtime-health";

describe("dynamic model qualification gate", () => {
  const fail = { action: ROUTE_RUNTIME_FAILURE, createdAt: new Date("2026-09-26T03:00:00Z") };
  const pass = { action: ROUTE_RUNTIME_SUCCESS, createdAt: new Date("2026-09-26T04:00:00Z") };
  it("observes isolated failures; only three consecutive terminal outcomes require revalidation", () => {
    expect(summarizeRouteRuntimeHealth([], []).state).toBe("UNOBSERVED");
    expect(summarizeRouteRuntimeHealth([fail, fail], []).state).toBe("WATCHING");
    expect(summarizeRouteRuntimeHealth([fail, fail, fail], []).state).toBe("REVALIDATION_REQUIRED");
  });
  it("a success breaks the streak; text success cannot clear image failure", () => {
    expect(summarizeRouteRuntimeHealth([pass, fail, fail], []).textFailures).toBe(0);
    expect(summarizeRouteRuntimeHealth([fail, pass, fail], []).textFailures).toBe(1);
    expect(summarizeRouteRuntimeHealth([pass], [fail, fail, fail])).toMatchObject({
      state: "REVALIDATION_REQUIRED",
      textFailures: 0,
      imageFailures: 3,
    });
  });
  it("excludes throttling, local infrastructure, input/safety refusals and breaker refusals", () => {
    for (const code of [
      "HTTP_429",
      "rate_limit_exceeded",
      "STORAGE_TIMEOUT",
      "PRISMA_P1001",
      "CONTENT_SAFETY_TIMEOUT",
      "PROVIDER_CIRCUIT_OPEN",
      "PROVIDER_DNS_FAILED",
      "GLOBAL_CONCURRENCY_LIMIT",
    ])
      expect(isModelRuntimeFailure(code, true)).toBe(false);
    expect(isModelRuntimeFailure("HTTP_400", false)).toBe(false);
    expect(isModelRuntimeFailure("HTTP_503", true)).toBe(true);
    expect(isModelRuntimeFailure("PROVIDER_TIMEOUT", true)).toBe(true);
  });
});
