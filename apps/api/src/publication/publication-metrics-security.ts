import { createHmac, timingSafeEqual } from "node:crypto";
import type { IngestPublicationMetricsDto } from "./publication.dto";

const DEVELOPMENT_SECRET_PATTERN =
  /(?:dev-only|replace-before-production|change[-_ ]?me|example|fixture|synthetic)/iu;

export function isPublicationMetricsSecretAllowed(
  value: unknown,
  productionStrengthRequired: boolean,
): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) return false;
  return !productionStrengthRequired || !DEVELOPMENT_SECRET_PATTERN.test(value);
}

export function publicationMetricsProductionMode(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    environment.NODE_ENV === "production" || environment.GENERATION_DELIVERY_MODE === "PRODUCTION"
  );
}

export function publicationMetricsSignatureStatus(
  input: Readonly<{
    body: IngestPublicationMetricsDto;
    key: unknown;
    now?: Date;
    productionStrengthRequired: boolean;
    signature: string | undefined;
    timestamp: string | undefined;
  }>,
): "EXPIRED" | "INVALID" | "VALID" {
  if (
    !isPublicationMetricsSecretAllowed(input.key, input.productionStrengthRequired) ||
    !input.timestamp ||
    !input.signature
  ) {
    return "INVALID";
  }
  const epochSeconds = Number(input.timestamp);
  if (!Number.isInteger(epochSeconds)) return "INVALID";
  const skewSeconds = Math.abs(
    Math.floor((input.now ?? new Date()).getTime() / 1000) - epochSeconds,
  );
  if (skewSeconds > 300) return "EXPIRED";
  if (!/^[0-9a-f]{64}$/iu.test(input.signature)) return "INVALID";
  const expected = createHmac("sha256", input.key)
    .update(`${input.timestamp}\n${canonicalMetricPayload(input.body)}`)
    .digest();
  const actual = Buffer.from(input.signature, "hex");
  return actual.length === expected.length && timingSafeEqual(expected, actual)
    ? "VALID"
    : "INVALID";
}

export function canonicalMetricPayload(input: IngestPublicationMetricsDto): string {
  return stableStringify({
    canonicalKey: input.canonicalKey,
    comments: metricValueForIngress(input, "comments"),
    favorites: metricValueForIngress(input, "favorites"),
    likes: metricValueForIngress(input, "likes"),
    observedAt: input.observedAt,
    rawData: input.rawData ?? null,
    shares: metricValueForIngress(input, "shares"),
    source: input.source.trim().toLocaleUpperCase(),
    views: metricValueForIngress(input, "views"),
    windowHours: input.windowHours ?? null,
  });
}

export function metricValueForIngress(
  input: IngestPublicationMetricsDto,
  name: "views" | "likes" | "comments" | "favorites" | "shares",
): number | null {
  if (input[name] !== undefined) return input[name] ?? null;
  // The v1 Hermes contract defaulted omitted engagement counts to zero.
  // Keep signatures and old senders compatible; newer sources use null for unknown.
  if (name !== "views" && input.source.trim().toUpperCase() === "HERMES") return 0;
  return null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
