import type { PrismaClient } from "@xhs-agentic/database";
import { MemoryObjectStorage } from "@xhs-agentic/object-storage";
import { describe, expect, it, vi } from "vitest";
import type { GenerationExecutionLease } from "./generation-execution";
import { GenerationRuntime } from "./generation-runtime";

function fixture() {
  const run = {
    id: "run",
    tenantId: "tenant",
    campaignId: "campaign",
    campaign: { id: "campaign", enterpriseId: "enterprise", blueprint: null },
    status: "QUEUED",
    executionVersion: 3,
    attemptCount: 6,
    maxAttempts: 6,
    leaseExpiresAt: null as Date | null,
  };
  const transaction = {
    generationRun: {
      findFirst: vi.fn(async () => run),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    generationWorkItem: {
      findMany: vi.fn().mockResolvedValue([{ id: "queued" }, { id: "running" }]),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    campaign: { update: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    ...transaction,
    $transaction: vi.fn(async (operation: (client: typeof transaction) => unknown) =>
      operation(transaction),
    ),
  };
  return {
    run,
    transaction,
    runtime: new GenerationRuntime(prisma as unknown as PrismaClient, new MemoryObjectStorage()),
  };
}

describe("generation terminal state convergence", () => {
  it("fails every unfinished work item after a run exhausts its durable attempts", async () => {
    const f = fixture();
    await expect(f.runtime.failExhaustedRun("run", "tenant")).resolves.toBe(true);
    expect(f.transaction.generationWorkItem.findMany).toHaveBeenCalledWith({
      select: { id: true },
      where: { generationRunId: "run", status: { in: ["QUEUED", "RUNNING"] }, tenantId: "tenant" },
    });
    expect(f.transaction.generationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", failedCount: 2 }),
      }),
    );
    expect(f.transaction.generationWorkItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["queued", "running"] }, tenantId: "tenant" },
        data: expect.objectContaining({ status: "FAILED", errorCode: "MAX_ATTEMPTS_EXHAUSTED" }),
      }),
    );
  });

  it("does not terminate work owned by an active run lease", async () => {
    const f = fixture();
    f.run.status = "RUNNING";
    f.run.leaseExpiresAt = new Date(Date.now() + 60_000);
    await expect(f.runtime.failExhaustedRun("run", "tenant")).resolves.toBe(false);
    expect(f.transaction.generationWorkItem.findMany).not.toHaveBeenCalled();
    expect(f.transaction.generationRun.updateMany).not.toHaveBeenCalled();
  });

  it("preserves lease-scoped terminal failure and campaign state when blueprint generation fails", async () => {
    const f = fixture();
    const lease: GenerationExecutionLease = {
      id: "run",
      tenantId: "tenant",
      kind: "RUN",
      attemptCount: 1,
      executionVersion: 3,
      maxAttempts: 6,
      queueVersion: 1,
      leaseToken: "lease-token",
      leaseOwner: "worker",
    };
    await f.runtime.failRun(lease, {
      code: "GENERATION_INPUT_INVALID",
      message: "Invalid frozen input",
      retryable: false,
    });
    expect(f.transaction.generationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          executionVersion: 3,
          leaseToken: "lease-token",
          status: "RUNNING",
        }),
        data: expect.objectContaining({ status: "FAILED", failedCount: 2 }),
      }),
    );
    expect(f.transaction.campaign.update).toHaveBeenCalledWith({
      where: { id: "campaign" },
      data: { status: "GENERATION_FAILED" },
    });
  });
});
