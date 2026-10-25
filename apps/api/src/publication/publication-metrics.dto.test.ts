import { plainToInstance } from "class-transformer";
import { type ValidationError, validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { IngestPublicationMetricsDto } from "./publication.dto";

const BASE_REQUEST = {
  canonicalKey: "xhs:note:1234567890",
  observedAt: "2026-09-23T08:00:00.000Z",
  source: "WORKBUDDY_BROWSER",
};

async function validationMessages(body: Record<string, unknown>): Promise<string[]> {
  const input = plainToInstance(IngestPublicationMetricsDto, body);
  const errors = await validate(input, { forbidNonWhitelisted: true, whitelist: true });
  return flattenErrors(errors);
}

function flattenErrors(errors: readonly ValidationError[]): string[] {
  return errors.flatMap((error) => [error.property, ...flattenErrors(error.children ?? [])]);
}

describe("browser-collected publication metrics DTO", () => {
  it("accepts true zero separately from an unknown metric and the first observation window", async () => {
    expect(
      await validationMessages({
        ...BASE_REQUEST,
        comments: 0,
        favorites: null,
        likes: 23,
        windowHours: 0,
      }),
    ).toEqual([]);
  });

  it("accepts a page abbreviation only as display metadata, never as an exact count", async () => {
    expect(
      await validationMessages({
        ...BASE_REQUEST,
        comments: null,
        likes: null,
        rawData: {
          metricDisplay: { likes: "1.2万+" },
          metricPrecision: { comments: "UNAVAILABLE", likes: "APPROXIMATE" },
        },
      }),
    ).toEqual([]);
    expect(await validationMessages({ ...BASE_REQUEST, likes: "1.2万" })).toContain("likes");
  });

  it("rejects cookies, arbitrary page content, and token-like display strings", async () => {
    expect(
      await validationMessages({ ...BASE_REQUEST, likes: 2, rawData: { cookie: "SECRET" } }),
    ).toContain("cookie");
    expect(
      await validationMessages({
        ...BASE_REQUEST,
        likes: null,
        rawData: { metricDisplay: { likes: "session_token=abc123" } },
      }),
    ).toContain("likes");
    expect(
      await validationMessages({
        ...BASE_REQUEST,
        likes: null,
        rawData: { metricDisplay: { likes: "1".repeat(33) } },
      }),
    ).toContain("likes");
  });

  it("rejects values outside PostgreSQL's non-negative int32 range", async () => {
    expect(await validationMessages({ ...BASE_REQUEST, likes: 2_147_483_647 })).toEqual([]);
    expect(await validationMessages({ ...BASE_REQUEST, likes: 2_147_483_648 })).toContain("likes");
  });
});
