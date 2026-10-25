export const ROUTE_RUNTIME_FAILURE_THRESHOLD = 3;
export const ROUTE_RUNTIME_MINIMUM_ATTEMPTS = 2;
export const ROUTE_RUNTIME_RESOURCE = "ModelRouteRuntime";
export const ROUTE_RUNTIME_SUCCESS = "model-route.runtime.succeeded";
export const ROUTE_RUNTIME_FAILURE = "model-route.runtime.exhausted";

export type ModelRuntimeCapability = "TEXT" | "IMAGE";
export type RouteRuntimeHealth = Readonly<{
  state: "UNOBSERVED" | "HEALTHY" | "WATCHING" | "REVALIDATION_REQUIRED";
  failureThreshold: number;
  textFailures: number;
  imageFailures: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
}>;

// Capacity limits, input refusals and the circuit's own refusal are not failed
// upstream calls. They must not feed back into a permanent qualification gate.
export const NON_MODEL_FAILURE_CODES = [
  "PROVIDER_DNS_FAILED",
  "PROVIDER_CIRCUIT_OPEN",
  "PROVIDER_CIRCUIT_STATE_UNAVAILABLE",
  "PROVIDER_DISABLED",
  "PROVIDER_NOT_REGISTERED",
  "PROVIDER_CONCURRENCY_LIMIT",
  "GLOBAL_CONCURRENCY_LIMIT",
  "PROVIDER_RATE_LIMITED",
  "RATE_LIMITED",
  "HTTP_429",
  "IMAGE_HTTP_429",
];

export function isModelRuntimeFailure(code: string | null, retryable: boolean | null): boolean {
  return Boolean(
    code &&
      retryable &&
      !NON_MODEL_FAILURE_CODES.includes(code) &&
      !/CONCURRENCY|CAPACITY|RATE_LIMIT|QUOTA|CONTENT_SAFETY|MODERATION|POLICY|INPUT_INVALID|PRISMA_|STORAGE_/iu.test(
        code,
      ),
  );
}

type Outcome = Readonly<{ action: string; createdAt: Date }>;

export function summarizeRouteRuntimeHealth(
  text: readonly Outcome[],
  image: readonly Outcome[],
): RouteRuntimeHealth {
  const failures = (rows: readonly Outcome[]) => {
    let count = 0;
    for (const row of rows) {
      if (row.action !== ROUTE_RUNTIME_FAILURE) break;
      count++;
    }
    return count;
  };
  const textFailures = failures(text);
  const imageFailures = failures(image);
  const count = Math.max(textFailures, imageFailures);
  const latest = (action: string) =>
    [...text, ...image]
      .filter((row) => row.action === action)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
      ?.createdAt.toISOString() ?? null;
  return {
    state:
      count >= ROUTE_RUNTIME_FAILURE_THRESHOLD
        ? "REVALIDATION_REQUIRED"
        : count > 0
          ? "WATCHING"
          : text.length || image.length
            ? "HEALTHY"
            : "UNOBSERVED",
    failureThreshold: ROUTE_RUNTIME_FAILURE_THRESHOLD,
    textFailures,
    imageFailures,
    lastFailureAt: latest(ROUTE_RUNTIME_FAILURE),
    lastSuccessAt: latest(ROUTE_RUNTIME_SUCCESS),
  };
}
