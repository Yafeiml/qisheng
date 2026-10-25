import "reflect-metadata";

import { createHmac } from "node:crypto";
import { plainToInstance } from "class-transformer";
import { describe, expect, it } from "vitest";
import { IngestPublicationMetricsDto } from "./publication.dto";
import {
  canonicalMetricPayload,
  isPublicationMetricsSecretAllowed,
  publicationMetricsProductionMode,
  publicationMetricsSignatureStatus,
} from "./publication-metrics-security";

describe("publication metrics security", () => {
  it("accepts a sufficiently long development key outside production", () => {
    expect(
      isPublicationMetricsSecretAllowed("dev-hermes-ingest-key-replace-before-production", false),
    ).toBe(true);
  });

  it("rejects development placeholders when production strength is required", () => {
    expect(
      isPublicationMetricsSecretAllowed("dev-hermes-ingest-key-replace-before-production", true),
    ).toBe(false);
    expect(isPublicationMetricsSecretAllowed("example-example-example-example-1234", true)).toBe(
      false,
    );
  });

  it("requires at least 32 UTF-8 bytes", () => {
    expect(isPublicationMetricsSecretAllowed("short-secret", false)).toBe(false);
    expect(isPublicationMetricsSecretAllowed("安全密钥".repeat(4), true)).toBe(true);
  });

  it("treats either application or delivery production mode as production", () => {
    expect(publicationMetricsProductionMode({ NODE_ENV: "production" })).toBe(true);
    expect(publicationMetricsProductionMode({ GENERATION_DELIVERY_MODE: "PRODUCTION" })).toBe(true);
    expect(
      publicationMetricsProductionMode({
        GENERATION_DELIVERY_MODE: "DEVELOPMENT",
        NODE_ENV: "development",
      }),
    ).toBe(false);
  });

  it("validates canonical HMAC payloads and rejects expired requests", () => {
    const key = "metrics-ingest-production-secret-2026-strong";
    const body = {
      canonicalKey: "xhs:note:123",
      comments: 4,
      favorites: 5,
      likes: 6,
      observedAt: "2026-08-31T15:00:00.000Z",
      shares: 2,
      source: "hermes",
      views: 100,
      windowHours: 24,
    };
    const timestamp = "1788188400";
    const signature = createHmac("sha256", key)
      .update(`${timestamp}\n${canonicalMetricPayload(body)}`)
      .digest("hex");

    expect(
      publicationMetricsSignatureStatus({
        body,
        key,
        now: new Date("2026-08-31T15:00:30.000Z"),
        productionStrengthRequired: true,
        signature,
        timestamp,
      }),
    ).toBe("VALID");
    expect(
      publicationMetricsSignatureStatus({
        body,
        key,
        now: new Date("2026-08-31T15:06:00.000Z"),
        productionStrengthRequired: true,
        signature,
        timestamp,
      }),
    ).toBe("EXPIRED");
  });

  it("fails closed on a correctly signed production request that uses a placeholder key", () => {
    const key = "dev-hermes-ingest-key-replace-before-production";
    const body = {
      canonicalKey: "xhs:note:456",
      comments: 0,
      favorites: 0,
      likes: 0,
      observedAt: "2026-08-31T15:00:00.000Z",
      shares: 0,
      source: "HERMES",
      views: 10,
    };
    const timestamp = "1788188400";
    const signature = createHmac("sha256", key)
      .update(`${timestamp}\n${canonicalMetricPayload(body)}`)
      .digest("hex");

    expect(
      publicationMetricsSignatureStatus({
        body,
        key,
        now: new Date("2026-08-31T15:00:30.000Z"),
        productionStrengthRequired: true,
        signature,
        timestamp,
      }),
    ).toBe("INVALID");
  });

  it("signs omitted observations as null so missing and zero cannot be confused", () => {
    const omitted = {
      canonicalKey: "xhs:note:sample123",
      observedAt: "2026-09-23T00:00:00.000Z",
      source: "BROWSER",
    } as Parameters<typeof canonicalMetricPayload>[0];
    expect(canonicalMetricPayload(omitted)).toContain('"likes":null');
    expect(canonicalMetricPayload({ ...omitted, likes: 0 })).toContain('"likes":0');
    expect(canonicalMetricPayload(omitted)).not.toBe(
      canonicalMetricPayload({ ...omitted, likes: 0 }),
    );
  });

  it("accepts browser metric signatures across nested DTO transformation", () => {
    const body = {
      canonicalKey: "xhs:note:sample123",
      comments: 0,
      favorites: null,
      likes: null,
      observedAt: "2026-09-23T00:00:00.000Z",
      rawData: {
        metricDisplay: { likes: "1.2万" },
        metricPrecision: { comments: "EXACT", favorites: "UNAVAILABLE", likes: "APPROXIMATE" },
      },
      shares: null,
      source: "WORKBUDDY_BROWSER",
      views: null,
      windowHours: 0,
    } satisfies IngestPublicationMetricsDto;
    const transformed = plainToInstance(IngestPublicationMetricsDto, body);
    const payload = canonicalMetricPayload(body);
    expect(canonicalMetricPayload(transformed)).toBe(payload);
    expect(JSON.parse(payload)).toMatchObject({
      comments: 0,
      likes: null,
      rawData: { metricDisplay: { likes: "1.2万" } },
    });
    const key = "browser-ingest-production-secret-2026-strong";
    const timestamp = "1790121600";
    const signature = createHmac("sha256", key).update(`${timestamp}\n${payload}`).digest("hex");
    expect(
      publicationMetricsSignatureStatus({
        body: transformed,
        key,
        now: new Date("2026-09-23T00:00:30.000Z"),
        productionStrengthRequired: true,
        signature,
        timestamp,
      }),
    ).toBe("VALID");
  });

  it("preserves legacy Hermes signature defaults while explicit unknown stays null", () => {
    const old = {
      canonicalKey: "xhs:note:sample123",
      observedAt: "2026-09-23T00:00:00.000Z",
      source: "HERMES",
      views: 100,
    } as Parameters<typeof canonicalMetricPayload>[0];
    expect(canonicalMetricPayload(old)).toContain('"likes":0');
    expect(canonicalMetricPayload({ ...old, likes: null })).toContain('"likes":null');
  });
});
