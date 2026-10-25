import "reflect-metadata";

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { configureApplication } from "../configure-application";
import { mountOpenApi } from "../openapi/openapi-document";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

describe("HTTP contract foundation", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, {
      abortOnError: false,
      bodyParser: false,
      logger: ["error"],
    });
    configureApplication(app);
    mountOpenApi(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it("publishes the generated OpenAPI document with request schemas and scope security", async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    const document = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    const paths = recordField(document, "paths");
    expect(Object.keys(paths).length).toBeGreaterThanOrEqual(90);
    const login = recordField(recordField(paths, "/auth/admin/login"), "post");
    expect(JSON.stringify(login)).toContain("#/components/schemas/LoginAdminDto");
    const campaigns = recordField(
      recordField(paths, "/console/tenants/{tenantId}/enterprises/{enterpriseId}/campaigns"),
      "post",
    );
    expect(campaigns.security).toEqual([{ "access-token": [] }]);
    expect(JSON.stringify(campaigns)).toContain("X-Request-Id");
    expect(JSON.stringify(campaigns)).toContain("Idempotency-Key");
    expect(JSON.stringify(campaigns)).toContain("#/components/schemas/ApiError");
    const provisionCustomer = recordField(
      recordField(paths, "/platform/operations/customers"),
      "post",
    );
    expect(JSON.stringify(provisionCustomer)).toContain("Idempotency-Key");

    const schemas = recordField(recordField(document, "components"), "schemas");
    const customerCampaignSchemas = [
      "CampaignGenerationRunSummaryDto",
      "CampaignGenerationRunDetailDto",
      "GenerationWorkItemDetailDto",
      "CampaignBlueprintResponseDto",
      "CampaignGeneratedImageDto",
    ].map((name) => recordField(schemas, name));
    expect(JSON.stringify(customerCampaignSchemas)).not.toMatch(
      /provider|model|routingPolicy|generationInput|invocation|generationPolicy|synthetic|storageKey|storageEtag|estimatedCost|idempotencyKey/iu,
    );
  });

  it("returns one stable error shape and preserves a valid caller request ID", async () => {
    const requestId = "contract-test-request-001";
    const response = await fetch(`${baseUrl}/auth/admin/login`, {
      body: JSON.stringify({ code: "1", phone: "invalid" }),
      headers: { "content-type": "application/json", "x-request-id": requestId },
      method: "POST",
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(body).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Request validation failed",
      path: "/auth/admin/login",
      requestId,
      statusCode: 400,
    });
    expect(body.details).toEqual(expect.any(Array));
    expect(body.timestamp).toEqual(expect.any(String));
  });

  it("generates a request ID and uses the same error contract for unknown routes", async () => {
    const response = await fetch(`${baseUrl}/route-that-does-not-exist`);
    const body = (await response.json()) as Record<string, unknown>;
    const requestId = response.headers.get("x-request-id");

    expect(response.status).toBe(404);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(body).toMatchObject({
      code: "NOT_FOUND",
      requestId,
      statusCode: 404,
    });
  });

  it("reports every runtime dependency in API readiness", async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(recordField(body, "checks")).toMatchObject({
      database: { status: "ok" },
      generationQueue: { status: "ok" },
      objectStorage: { status: "ok" },
      redis: { status: "ok" },
    });
  });

  it("sets API security headers and removes framework disclosure", async () => {
    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-powered-by")).toBeNull();
  });

  it("rejects oversized JSON with the stable error envelope", async () => {
    const requestId = "oversized-request-body-001";
    const response = await fetch(`${baseUrl}/auth/admin/login`, {
      body: JSON.stringify({ code: "123456", padding: "x".repeat(110_000), phone: "13800000000" }),
      headers: { "content-type": "application/json", "x-request-id": requestId },
      method: "POST",
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(413);
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(body).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      requestId,
      statusCode: 413,
    });
  });

  it("enforces a distributed authentication subject limit", async () => {
    const phone = `139${String(Date.now()).slice(-8)}`;
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await fetch(`${baseUrl}/auth/admin/login`, {
        body: JSON.stringify({ code: "invalid", phone }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      statuses.push(response.status);
      if (index === 10) {
        expect(response.headers.get("retry-after")).toMatch(/^\d+$/u);
        expect(response.headers.get("ratelimit-remaining")).toBe("0");
      }
    }

    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`Expected object field: ${key}`);
  }
  return field as Record<string, unknown>;
}
