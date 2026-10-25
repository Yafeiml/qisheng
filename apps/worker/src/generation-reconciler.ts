import { readMedicalPlan } from "@xhs-agentic/ai-gateway";
import type { PrismaClient } from "@xhs-agentic/database";
import type { Queue } from "bullmq";
import type { GenerationRuntime } from "./generation-runtime";

export type OrchestrateJob = Readonly<{
  generationRunId: string;
  queueVersion: number;
  tenantId: string;
}>;

export type EmployeeJob = Readonly<{
  generationRunId: string;
  queueVersion: number;
  reservationVersion: number;
  tenantId: string;
  workItemId: string;
}>;

type GenerationQueue = Queue<OrchestrateJob | EmployeeJob>;

export interface GenerationReconcileResult {
  compensatedRuns: number;
  compensatedWorkItems: number;
  recoveredRuns: number;
  recoveredWorkItems: number;
}

const RECONCILE_BATCH_SIZE = 500;

export class GenerationReconciler {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly queue: GenerationQueue,
    private readonly runtime: GenerationRuntime,
    private readonly medicalQueue?: GenerationQueue,
  ) {}

  async reconcile(now = new Date()): Promise<GenerationReconcileResult> {
    const recoveredRuns = await this.recoverExpiredRuns(now);
    const recoveredWorkItems = await this.recoverExpiredWorkItems(now);
    const compensatedRuns = await this.compensateQueuedRuns(now);
    const compensatedWorkItems = await this.compensateQueuedWorkItems(now);
    return { compensatedRuns, compensatedWorkItems, recoveredRuns, recoveredWorkItems };
  }

  private async recoverExpiredRuns(now: Date): Promise<number> {
    const candidates = await this.prisma.generationRun.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        campaign: { select: { enterpriseId: true } },
        attemptCount: true,
        executionVersion: true,
        id: true,
        leaseExpiresAt: true,
        leaseOwner: true,
        maxAttempts: true,
        queueVersion: true,
        tenantId: true,
      },
      take: RECONCILE_BATCH_SIZE,
      where: {
        campaign: { blueprint: { is: null } },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        status: "RUNNING",
      },
    });
    let recovered = 0;
    for (const run of candidates) {
      if (run.attemptCount >= run.maxAttempts) {
        await this.runtime.failExhaustedRun(run.id, run.tenantId);
        continue;
      }
      const changed = await this.prisma.$transaction(async (transaction) => {
        const updated = await transaction.generationRun.updateMany({
          data: {
            errorCode: "WORKER_LEASE_EXPIRED",
            errorMessage: "Expired generation run lease was recovered for durable redispatch",
            errorRetryable: true,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            nextRetryAt: now,
            queueVersion: { increment: 1 },
            recoveryCount: { increment: 1 },
            status: "QUEUED",
          },
          where: {
            executionVersion: run.executionVersion,
            id: run.id,
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
            status: "RUNNING",
            tenantId: run.tenantId,
          },
        });
        if (updated.count !== 1) return false;
        await transaction.auditLog.create({
          data: {
            action: "generation.run.lease-recovered",
            actorType: "SYSTEM",
            enterpriseId: run.campaign.enterpriseId,
            metadata: {
              executionVersion: run.executionVersion,
              expiredAt: run.leaseExpiresAt?.toISOString() ?? null,
              previousLeaseOwner: run.leaseOwner,
              queueVersion: run.queueVersion + 1,
            },
            resourceId: run.id,
            resourceType: "GenerationRun",
            tenantId: run.tenantId,
          },
        });
        return true;
      });
      if (changed) recovered += 1;
    }
    return recovered;
  }

  private async recoverExpiredWorkItems(now: Date): Promise<number> {
    const candidates = await this.prisma.generationWorkItem.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        enterpriseId: true,
        attemptCount: true,
        executionVersion: true,
        id: true,
        leaseExpiresAt: true,
        leaseOwner: true,
        maxAttempts: true,
        queueVersion: true,
        tenantId: true,
      },
      take: RECONCILE_BATCH_SIZE,
      where: {
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        status: "RUNNING",
      },
    });
    let recovered = 0;
    for (const item of candidates) {
      if (item.attemptCount >= item.maxAttempts) {
        await this.runtime.failExhaustedWorkItem(item.id, item.tenantId);
        continue;
      }
      const changed = await this.prisma.$transaction(async (transaction) => {
        const updated = await transaction.generationWorkItem.updateMany({
          data: {
            errorCode: "WORKER_LEASE_EXPIRED",
            errorMessage: "Expired generation work item lease was recovered for durable redispatch",
            errorRetryable: true,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            nextRetryAt: now,
            queueVersion: { increment: 1 },
            recoveryCount: { increment: 1 },
            status: "QUEUED",
          },
          where: {
            executionVersion: item.executionVersion,
            id: item.id,
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
            status: "RUNNING",
            tenantId: item.tenantId,
          },
        });
        if (updated.count !== 1) return false;
        await transaction.auditLog.create({
          data: {
            action: "generation.work-item.lease-recovered",
            actorType: "SYSTEM",
            enterpriseId: item.enterpriseId,
            metadata: {
              executionVersion: item.executionVersion,
              expiredAt: item.leaseExpiresAt?.toISOString() ?? null,
              previousLeaseOwner: item.leaseOwner,
              queueVersion: item.queueVersion + 1,
            },
            resourceId: item.id,
            resourceType: "GenerationWorkItem",
            tenantId: item.tenantId,
          },
        });
        return true;
      });
      if (changed) recovered += 1;
    }
    return recovered;
  }

  private async compensateQueuedRuns(now: Date): Promise<number> {
    const runs = await this.prisma.generationRun.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        attemptCount: true,
        campaign: { select: { enterpriseId: true } },
        id: true,
        generationInput: true,
        maxAttempts: true,
        queueVersion: true,
        tenantId: true,
      },
      take: RECONCILE_BATCH_SIZE,
      where: {
        campaign: { blueprint: { is: null } },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        status: "QUEUED",
      },
    });
    let compensated = 0;
    for (const run of runs) {
      const queue = this.queueFor(run.generationInput);
      if (run.attemptCount >= run.maxAttempts) {
        await this.runtime.failExhaustedRun(run.id, run.tenantId);
        continue;
      }
      let jobId = runJobId(run.id, run.queueVersion);
      const job = await queue.getJob(jobId);
      if (job) {
        const state = await job.getState();
        if (state !== "completed" && state !== "failed") continue;
        const updated = await this.prisma.generationRun.updateMany({
          data: { queueVersion: { increment: 1 } },
          where: {
            id: run.id,
            tenantId: run.tenantId,
            queueVersion: run.queueVersion,
            status: "QUEUED",
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          },
        });
        if (updated.count !== 1) continue;
        run.queueVersion++;
        jobId = runJobId(run.id, run.queueVersion);
      }
      await enqueueRun(queue, {
        generationRunId: run.id,
        queueVersion: run.queueVersion,
        tenantId: run.tenantId,
      });
      await this.prisma.auditLog.create({
        data: {
          action: "generation.run.queue-compensated",
          actorType: "SYSTEM",
          enterpriseId: run.campaign.enterpriseId,
          metadata: { jobId, queueVersion: run.queueVersion },
          resourceId: run.id,
          resourceType: "GenerationRun",
          tenantId: run.tenantId,
        },
      });
      compensated += 1;
    }
    return compensated;
  }

  private async compensateQueuedWorkItems(now: Date): Promise<number> {
    const items = await this.prisma.generationWorkItem.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        attemptCount: true,
        enterpriseId: true,
        generationRunId: true,
        generationRun: { select: { generationInput: true } },
        id: true,
        maxAttempts: true,
        queueVersion: true,
        reservationVersion: true,
        tenantId: true,
      },
      take: RECONCILE_BATCH_SIZE,
      where: {
        generationRun: { campaign: { blueprint: { isNot: null } }, status: "RUNNING" },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        status: "QUEUED",
      },
    });
    let compensated = 0;
    for (const item of items) {
      const queue = this.queueFor(item.generationRun?.generationInput);
      if (item.attemptCount >= item.maxAttempts) {
        await this.runtime.failExhaustedWorkItem(item.id, item.tenantId);
        continue;
      }
      let jobId = workItemJobId(item.id, item.queueVersion);
      const job = await queue.getJob(jobId);
      if (job) {
        const state = await job.getState();
        if (state !== "completed" && state !== "failed") continue;
        // An early delivery or clock skew can complete without claiming the durable queued item.
        const updated = await this.prisma.generationWorkItem.updateMany({
          data: { queueVersion: { increment: 1 } },
          where: {
            id: item.id,
            tenantId: item.tenantId,
            queueVersion: item.queueVersion,
            status: "QUEUED",
            generationRun: { status: "RUNNING" },
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          },
        });
        if (updated.count !== 1) continue;
        item.queueVersion++;
        jobId = workItemJobId(item.id, item.queueVersion);
      }
      await enqueueWorkItem(queue, {
        generationRunId: item.generationRunId,
        queueVersion: item.queueVersion,
        reservationVersion: item.reservationVersion,
        tenantId: item.tenantId,
        workItemId: item.id,
      });
      await this.prisma.auditLog.create({
        data: {
          action: "generation.work-item.queue-compensated",
          actorType: "SYSTEM",
          enterpriseId: item.enterpriseId,
          metadata: { jobId, queueVersion: item.queueVersion },
          resourceId: item.id,
          resourceType: "GenerationWorkItem",
          tenantId: item.tenantId,
        },
      });
      compensated += 1;
    }
    return compensated;
  }

  private queueFor(input: unknown): GenerationQueue {
    const value =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    if (!readMedicalPlan(value.medicalPlan)) return this.queue;
    if (!this.medicalQueue) throw new Error("Medical generation queue is not configured");
    return this.medicalQueue;
  }
}

export function enqueueRun(queue: GenerationQueue, data: OrchestrateJob) {
  return queue.add("orchestrate-run", data, {
    attempts: 5,
    backoff: { delay: 1_000, type: "exponential" },
    jobId: runJobId(data.generationRunId, data.queueVersion),
    removeOnComplete: { age: 86_400, count: 2_000 },
    removeOnFail: { age: 604_800, count: 5_000 },
  });
}

export function enqueueWorkItem(queue: GenerationQueue, data: EmployeeJob) {
  return queue.add("generate-employee", data, {
    attempts: 3,
    backoff: { delay: 2_000, type: "exponential" },
    jobId: workItemJobId(data.workItemId, data.queueVersion),
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 604_800, count: 20_000 },
  });
}

export function runJobId(generationRunId: string, queueVersion: number): string {
  return `run-${generationRunId}-q${queueVersion}`;
}

export function workItemJobId(workItemId: string, queueVersion: number): string {
  return `work-${workItemId}-q${queueVersion}`;
}
