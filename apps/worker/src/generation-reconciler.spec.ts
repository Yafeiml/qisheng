import type { PrismaClient } from "@xhs-agentic/database";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import {
  type EmployeeJob,
  GenerationReconciler,
  type OrchestrateJob,
} from "./generation-reconciler";
import type { GenerationRuntime } from "./generation-runtime";

const now = new Date("2026-10-10T04:01:00Z");

function fixture(kind: "run" | "work", jobState: string, medical = false) {
  const medicalPlan = {
    schemaVersion: "medical-selection-v1",
    executionVersion: "medical-plan-v1",
    objective: "GEO_AND_TRANSACTION",
    priority: "BALANCED",
    topicIds: ["q"],
    readerSituation: "FIRST_UNDERSTANDING",
    noteForm: "QUESTION_LIST",
    imageMode: "QUESTION_CARD",
    conversionPath: "NONE",
    topics: [
      {
        id: "q",
        seriesId: "s",
        version: 1,
        question: "准备什么？",
        intent: "",
        entityId: "",
        entityName: "",
      },
    ],
    publishers: [
      {
        membershipId: "m",
        publisherContext: {
          schemaVersion: "medical-publisher-v1",
          category: "ORDINARY",
          allowBrandAttribution: false,
          allowPlatformConsultation: false,
        },
      },
    ],
    frozenAt: "2026-10-13T08:00:00Z",
  };
  const row = {
    id: kind,
    tenantId: "tenant",
    enterpriseId: "enterprise",
    campaign: { enterpriseId: "enterprise" },
    generationRunId: "run",
    queueVersion: 4,
    reservationVersion: 3,
    attemptCount: 4,
    maxAttempts: 6,
    status: "QUEUED",
    nextRetryAt: new Date(now.getTime() - 1000),
    generationInput: medical ? { medicalPlan } : {},
    generationRun: { generationInput: medical ? { medicalPlan } : {} },
  };
  const jobs = new Map([[`${kind === "run" ? "run-run" : "work-work"}-q4`, jobState]]);
  const table = {
    findMany: vi
      .fn()
      .mockImplementation(({ where }) =>
        Promise.resolve(
          where.status === "QUEUED" && row.status === "QUEUED" && row.nextRetryAt <= now
            ? [{ ...row }]
            : [],
        ),
      ),
    updateMany: vi.fn().mockImplementation(({ where }) => {
      if (row.status !== where.status || row.queueVersion !== where.queueVersion)
        return Promise.resolve({ count: 0 });
      row.queueVersion++;
      return Promise.resolve({ count: 1 });
    }),
  };
  const emptyTable = { findMany: vi.fn().mockResolvedValue([]) };
  const prisma = {
    generationRun: kind === "run" ? table : emptyTable,
    generationWorkItem: kind === "work" ? table : emptyTable,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const queue = {
    getJob: vi
      .fn()
      .mockImplementation(async (id: string) =>
        jobs.has(id) ? { getState: async () => jobs.get(id) } : null,
      ),
    add: vi
      .fn()
      .mockImplementation(async (_name: string, _data: unknown, options: { jobId: string }) => {
        jobs.set(options.jobId, "waiting");
        return {};
      }),
  };
  const runtime = {
    failExhaustedRun: vi.fn().mockResolvedValue(true),
    failExhaustedWorkItem: vi.fn().mockResolvedValue(true),
  };
  const medicalQueue = {
    getJob: vi.fn().mockResolvedValue(null),
    add: vi.fn().mockResolvedValue({}),
  };
  const reconciler = new GenerationReconciler(
    prisma as unknown as PrismaClient,
    queue as unknown as Queue<OrchestrateJob | EmployeeJob>,
    runtime as unknown as GenerationRuntime,
    medicalQueue as unknown as Queue<OrchestrateJob | EmployeeJob>,
  );
  return { row, table, queue, medicalQueue, runtime, reconciler };
}

describe("durable generation queue compensation", () => {
  it.each(["run", "work"] as const)(
    "redispatches new medical %s tasks only to the medical capability queue",
    async (kind) => {
      const f = fixture(kind, "completed", true);
      await f.reconciler.reconcile(now);
      expect(f.queue.getJob).not.toHaveBeenCalled();
      expect(f.queue.add).not.toHaveBeenCalled();
      expect(f.medicalQueue.add).toHaveBeenCalledOnce();
    },
  );

  it.each(["run", "work"] as const)(
    "redispatches a %s skipped before its retry deadline without resetting execution state",
    async (kind) => {
      const f = fixture(kind, "completed");
      await expect(f.reconciler.reconcile(now)).resolves.toMatchObject(
        kind === "run" ? { compensatedRuns: 1 } : { compensatedWorkItems: 1 },
      );
      expect(f.table.updateMany).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          data: { queueVersion: { increment: 1 } },
          where: expect.objectContaining({ status: "QUEUED", queueVersion: 4 }),
        }),
      );
      expect(f.queue.add).toHaveBeenCalledExactlyOnceWith(
        kind === "run" ? "orchestrate-run" : "generate-employee",
        expect.objectContaining({
          queueVersion: 5,
          ...(kind === "work" ? { reservationVersion: 3, workItemId: "work" } : {}),
        }),
        expect.objectContaining({ jobId: `${kind === "run" ? "run-run" : "work-work"}-q5` }),
      );
      expect(f.row).toMatchObject({ reservationVersion: 3, attemptCount: 4 });
      await expect(f.reconciler.reconcile(now)).resolves.toMatchObject({
        compensatedRuns: 0,
        compensatedWorkItems: 0,
      });
      expect(f.queue.add).toHaveBeenCalledTimes(1);
    },
  );

  it("recovers a failed Redis job whose durable item remains queued", async () => {
    const f = fixture("work", "failed");
    await expect(f.reconciler.reconcile(now)).resolves.toMatchObject({ compensatedWorkItems: 1 });
  });

  it.each(["active", "waiting", "delayed"])(
    "leaves an existing %s delivery alone",
    async (state) => {
      const f = fixture("work", state);
      await expect(f.reconciler.reconcile(now)).resolves.toMatchObject({ compensatedWorkItems: 0 });
      expect(f.table.updateMany).not.toHaveBeenCalled();
      expect(f.queue.add).not.toHaveBeenCalled();
    },
  );

  it("allows only one concurrent reconciler to advance the queue version", async () => {
    const f = fixture("work", "completed");
    const results = await Promise.all([f.reconciler.reconcile(now), f.reconciler.reconcile(now)]);
    expect(results.reduce((sum, result) => sum + result.compensatedWorkItems, 0)).toBe(1);
    expect(f.queue.add).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue when cancellation wins the version update", async () => {
    const f = fixture("work", "completed");
    f.table.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.reconciler.reconcile(now)).resolves.toMatchObject({ compensatedWorkItems: 0 });
    expect(f.queue.add).not.toHaveBeenCalled();
  });

  it("honors durable attempt limits and future retry deadlines", async () => {
    const f = fixture("work", "completed");
    f.row.nextRetryAt = new Date(now.getTime() + 3000);
    await expect(f.reconciler.reconcile(now)).resolves.toMatchObject({ compensatedWorkItems: 0 });
    expect(f.queue.getJob).not.toHaveBeenCalled();
    f.row.nextRetryAt = now;
    f.row.attemptCount = 6;
    await f.reconciler.reconcile(now);
    expect(f.runtime.failExhaustedWorkItem).toHaveBeenCalledExactlyOnceWith("work", "tenant");
    expect(f.queue.add).not.toHaveBeenCalled();
  });
});
