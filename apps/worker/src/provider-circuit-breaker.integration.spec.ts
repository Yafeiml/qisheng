import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ProviderInvocationError, type RuntimeProviderPair } from "@xhs-agentic/ai-gateway";
import { PrismaClient } from "@xhs-agentic/database";
import { describe, expect, it } from "vitest";
import { ProviderCircuitBreaker } from "./provider-circuit-breaker";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

describe("provider circuit breaker", { concurrent: false }, () => {
  it("opens after consecutive failures and closes after one fenced half-open probe", async () => {
    assertDevelopmentDatabase();
    const prisma = new PrismaClient();
    await prisma.$connect();
    const provider = await prisma.modelProvider.create({
      data: {
        baseUrl: "https://circuit.invalid/v1",
        code: `CIRCUIT_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
        name: "Circuit integration provider",
        protocol: "OPENAI_COMPATIBLE",
      },
    });
    try {
      let now = new Date("2026-08-29T00:00:00.000Z");
      let failuresRemaining = 2;
      let providerCalls = 0;
      const pair: RuntimeProviderPair = {
        image: {
          generate: async () => {
            throw new Error("unused image provider");
          },
          providerId: provider.id,
        },
        text: {
          generate: async () => {
            providerCalls += 1;
            if (failuresRemaining > 0) {
              failuresRemaining -= 1;
              throw new ProviderInvocationError("temporary upstream failure", "HTTP_503", true);
            }
            return {
              finishReason: "stop",
              providerRequestId: `probe-${providerCalls}`,
              text: "recovered",
              usage: { estimatedCost: 0 },
            };
          },
          providerId: provider.id,
        },
      };
      const breaker = new ProviderCircuitBreaker(
        prisma,
        { cooldownMs: 1_000, failureThreshold: 2, probeLeaseMs: 5_000 },
        () => now,
      );
      const wrapped = breaker.wrap(pair);
      const request = {
        context: { generationRunId: "circuit-test", tenantId: "circuit-test" },
        prompt: "test",
      };

      await expect(wrapped.text.generate("model", request)).rejects.toMatchObject({
        code: "HTTP_503",
      });
      await expect(wrapped.text.generate("model", request)).rejects.toMatchObject({
        code: "HTTP_503",
      });
      await expect(
        prisma.modelProvider.findUniqueOrThrow({ where: { id: provider.id } }),
      ).resolves.toMatchObject({ circuitState: "OPEN", runtimeFailureCount: 2 });

      await expect(wrapped.text.generate("model", request)).rejects.toMatchObject({
        code: "PROVIDER_CIRCUIT_OPEN",
      });
      expect(providerCalls).toBe(2);

      now = new Date(now.getTime() + 1_001);
      await expect(wrapped.text.generate("model", request)).resolves.toMatchObject({
        text: "recovered",
      });
      await expect(
        prisma.modelProvider.findUniqueOrThrow({ where: { id: provider.id } }),
      ).resolves.toMatchObject({ circuitState: "CLOSED", runtimeFailureCount: 0 });
      expect(providerCalls).toBe(3);

      const actions = await prisma.auditLog.findMany({
        orderBy: { createdAt: "asc" },
        select: { action: true },
        where: { resourceId: provider.id, resourceType: "ModelProvider" },
      });
      expect(actions.map(({ action }) => action)).toEqual([
        "model-provider.circuit.opened",
        "model-provider.circuit.half-open",
        "model-provider.circuit.closed",
      ]);
    } finally {
      await prisma.auditLog.deleteMany({ where: { resourceId: provider.id } });
      await prisma.modelProvider.delete({ where: { id: provider.id } });
      await prisma.$disconnect();
    }
  });
});

function assertDevelopmentDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!/dev[_-]/u.test(databaseUrl)) {
    throw new Error("Provider circuit integration test requires a dev-* database");
  }
}
