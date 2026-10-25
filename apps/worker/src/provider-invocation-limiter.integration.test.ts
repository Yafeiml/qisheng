import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderInvocationError } from "@xhs-agentic/ai-gateway";
import { PrismaClient } from "@xhs-agentic/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderInvocationLimiter } from "./provider-invocation-limiter";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

describe("ProviderInvocationLimiter", { concurrent: false }, () => {
  const marker = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  const prisma = new PrismaClient();
  let firstProviderId: string;
  let secondProviderId: string;
  let originalPolicy: {
    maxActiveGenerationJobs: number;
    maxProviderConcurrentInvocations: number;
    updatedBy: string;
  };

  beforeAll(async () => {
    assertDevelopmentDatabase();
    await prisma.$connect();
    const policy = await prisma.runtimePolicy.findUniqueOrThrow({ where: { id: "platform" } });
    originalPolicy = {
      maxActiveGenerationJobs: policy.maxActiveGenerationJobs,
      maxProviderConcurrentInvocations: policy.maxProviderConcurrentInvocations,
      updatedBy: policy.updatedBy,
    };
    const [first, second] = await Promise.all([
      prisma.modelProvider.create({
        data: {
          baseUrl: "synthetic://limiter-a",
          code: `LIMITER_A_${marker}`,
          name: "Limiter Provider A",
          protocol: "SYNTHETIC",
          synthetic: true,
        },
      }),
      prisma.modelProvider.create({
        data: {
          baseUrl: "synthetic://limiter-b",
          code: `LIMITER_B_${marker}`,
          name: "Limiter Provider B",
          protocol: "SYNTHETIC",
          synthetic: true,
        },
      }),
    ]);
    firstProviderId = first.id;
    secondProviderId = second.id;
  });

  afterAll(async () => {
    await prisma.modelProviderInvocationLease.deleteMany({
      where: { providerId: { in: [firstProviderId, secondProviderId] } },
    });
    await prisma.modelProvider.deleteMany({
      where: { id: { in: [firstProviderId, secondProviderId] } },
    });
    await prisma.runtimePolicy.update({
      data: originalPolicy,
      where: { id: "platform" },
    });
    await prisma.$disconnect();
  });

  it("enforces provider and platform concurrency while releasing completed leases", async () => {
    const limiter = new ProviderInvocationLimiter(prisma);
    await prisma.runtimePolicy.update({
      data: {
        maxActiveGenerationJobs: 10,
        maxProviderConcurrentInvocations: 1,
        updatedBy: "provider-limiter-test",
      },
      where: { id: "platform" },
    });
    await expectLimit({
      blockedProviderId: firstProviderId,
      expectedCode: "PROVIDER_CONCURRENCY_LIMIT",
      heldProviderId: firstProviderId,
      limiter,
    });

    await prisma.runtimePolicy.update({
      data: {
        maxActiveGenerationJobs: 1,
        maxProviderConcurrentInvocations: 10,
        updatedBy: "platform-limiter-test",
      },
      where: { id: "platform" },
    });
    await expectLimit({
      blockedProviderId: secondProviderId,
      expectedCode: "PLATFORM_CONCURRENCY_LIMIT",
      heldProviderId: firstProviderId,
      limiter,
    });
    await expect(
      prisma.modelProviderInvocationLease.count({
        where: { providerId: { in: [firstProviderId, secondProviderId] } },
      }),
    ).resolves.toBe(0);
  });

  it("removes expired leases before capacity accounting", async () => {
    const limiter = new ProviderInvocationLimiter(prisma);
    await prisma.runtimePolicy.update({
      data: {
        maxActiveGenerationJobs: 1,
        maxProviderConcurrentInvocations: 1,
        updatedBy: "expired-limiter-test",
      },
      where: { id: "platform" },
    });
    const expiredLeaseId = randomUUID();
    await prisma.modelProviderInvocationLease.create({
      data: {
        createdAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 60_000),
        id: expiredLeaseId,
        kind: "TEXT",
        leaseOwner: "expired-test-owner",
        providerId: firstProviderId,
      },
    });

    await expect(
      limiter.withLease(firstProviderId, "TEXT", 1_000, async () => "completed"),
    ).resolves.toBe("completed");
    await expect(
      prisma.modelProviderInvocationLease.findUnique({ where: { id: expiredLeaseId } }),
    ).resolves.toBeNull();
    await expect(
      prisma.modelProviderInvocationLease.count({ where: { providerId: firstProviderId } }),
    ).resolves.toBe(0);
  });
});

async function expectLimit(input: {
  blockedProviderId: string;
  expectedCode: "PLATFORM_CONCURRENCY_LIMIT" | "PROVIDER_CONCURRENCY_LIMIT";
  heldProviderId: string;
  limiter: ProviderInvocationLimiter;
}): Promise<void> {
  const started = deferred<void>();
  const release = deferred<void>();
  const held = input.limiter.withLease(input.heldProviderId, "TEXT", 5_000, async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  try {
    await expect(
      input.limiter.withLease(input.blockedProviderId, "IMAGE", 5_000, async () => undefined),
    ).rejects.toMatchObject({
      code: input.expectedCode,
      retryable: true,
    } satisfies Partial<ProviderInvocationError>);
  } finally {
    release.resolve();
    await held;
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function assertDevelopmentDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || new URL(databaseUrl).pathname.replace(/^\//u, "") !== "dev_xhs_agentic") {
    throw new Error("Provider limiter integration test requires dev_xhs_agentic");
  }
}
