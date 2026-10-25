import { randomUUID } from "node:crypto";
import { ProviderInvocationError } from "@xhs-agentic/ai-gateway";
import { Prisma, type PrismaClient } from "@xhs-agentic/database";

export class ProviderInvocationLimiter {
  constructor(private readonly prisma: PrismaClient) {}

  async withLease<T>(
    providerId: string,
    kind: "IMAGE" | "TEXT",
    timeoutMs: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const leaseId = randomUUID();
    await this.acquire(leaseId, providerId, kind, timeoutMs);
    try {
      return await operation();
    } finally {
      await this.prisma.modelProviderInvocationLease
        .deleteMany({ where: { id: leaseId } })
        .catch(() => undefined);
    }
  }

  private async acquire(
    leaseId: string,
    providerId: string,
    kind: "IMAGE" | "TEXT",
    timeoutMs: number,
  ): Promise<void> {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await this.prisma.$transaction(
          async (transaction) => {
            const now = new Date();
            await transaction.modelProviderInvocationLease.deleteMany({
              where: { expiresAt: { lte: now } },
            });
            const policy = await transaction.runtimePolicy.findUnique({
              where: { id: "platform" },
            });
            if (!policy) {
              throw new ProviderInvocationError(
                "Platform runtime policy is not initialized",
                "RUNTIME_POLICY_MISSING",
                false,
              );
            }
            const [activeTotal, activeForProvider] = await Promise.all([
              transaction.modelProviderInvocationLease.count({
                where: { expiresAt: { gt: now } },
              }),
              transaction.modelProviderInvocationLease.count({
                where: { expiresAt: { gt: now }, providerId },
              }),
            ]);
            if (activeTotal >= policy.maxActiveGenerationJobs) {
              throw new ProviderInvocationError(
                "Platform generation concurrency limit is currently reached",
                "PLATFORM_CONCURRENCY_LIMIT",
                true,
              );
            }
            if (activeForProvider >= policy.maxProviderConcurrentInvocations) {
              throw new ProviderInvocationError(
                "Model provider concurrency limit is currently reached",
                "PROVIDER_CONCURRENCY_LIMIT",
                true,
              );
            }
            await transaction.modelProviderInvocationLease.create({
              data: {
                expiresAt: new Date(now.getTime() + Math.max(timeoutMs + 60_000, 120_000)),
                id: leaseId,
                kind,
                leaseOwner: `${process.pid}:${leaseId}`,
                providerId,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        return;
      } catch (error) {
        if (
          attempt < 5 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034"
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
          continue;
        }
        throw error;
      }
    }
  }
}
