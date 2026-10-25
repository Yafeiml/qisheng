import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  generationDeliveryMode,
  MEDICAL_GENERATION_QUEUE,
  MEDICAL_PLAN_EXECUTION_VERSION,
} from "@xhs-agentic/ai-gateway";
import { createContentSafetyScanner } from "@xhs-agentic/content-safety";
import { PrismaClient } from "@xhs-agentic/database";
import { createObjectStorage } from "@xhs-agentic/object-storage";
import { runWithLogContext, writeStructuredLog } from "@xhs-agentic/observability";
import { type ConnectionOptions, type Job, Queue, UnrecoverableError, Worker } from "bullmq";
import {
  classifyGenerationError,
  type GenerationExecutionLease,
  GenerationLeaseLostError,
  generationRetryDelayMs,
} from "./generation-execution";
import {
  type EmployeeJob,
  enqueueWorkItem,
  GenerationReconciler,
  type OrchestrateJob,
} from "./generation-reconciler";
import { GenerationRuntime } from "./generation-runtime";
import { loadWorkerPlatformSettings } from "./platform-settings";

const QUEUE_NAME = "campaign-generation-v1";

export interface GenerationWorkerHandle {
  close(): Promise<void>;
}

export async function startGenerationWorker(): Promise<GenerationWorkerHandle> {
  const deliveryMode = generationDeliveryMode();
  const prisma = new PrismaClient();
  const queues: Queue<OrchestrateJob | EmployeeJob>[] = [];
  const workers: Worker<OrchestrateJob | EmployeeJob>[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = async (force = false) => {
    clearInterval(timer);
    await Promise.allSettled([
      ...workers.map((worker) => worker.close(force)),
      ...queues.map((queue) => queue.close()),
    ]);
    await prisma.$disconnect();
  };
  try {
    await prisma.$connect();
    const platformSettings = await loadWorkerPlatformSettings(prisma);
    const { heartbeatIntervalMs, leaseDurationMs } = platformSettings.generation;
    if (
      deliveryMode === "PRODUCTION" &&
      (platformSettings.contentSafety.mode === "DISABLED" ||
        !platformSettings.contentSafety.verified)
    ) {
      throw new Error("Production generation requires verified model or HTTP content safety");
    }
    const contentSafetyScanner = createContentSafetyScanner(
      platformSettings.contentSafety,
      deliveryMode === "PRODUCTION",
    );
    const storage = createObjectStorage(platformSettings.storage);
    await storage.ensureBucket(process.env.NODE_ENV !== "production");
    const runtime = new GenerationRuntime(prisma, storage, {
      circuitBreaker: platformSettings.generation.circuitBreaker,
      contentSafetyScanner,
      leaseDurationMs,
      requireContentSafety: deliveryMode === "PRODUCTION",
    });
    const connection = redisConnection(requiredEnv("REDIS_URL"));
    const prefix = requiredEnv("REDIS_PREFIX");
    for (const name of [QUEUE_NAME, MEDICAL_GENERATION_QUEUE])
      queues.push(new Queue<OrchestrateJob | EmployeeJob>(name, { connection, prefix }));
    const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
    const executeInSlot = generationExecutionSlots(platformSettings.generation.concurrency);
    for (const queue of queues)
      workers.push(
        new Worker<OrchestrateJob | EmployeeJob>(
          queue.name,
          async (job) =>
            runWithLogContext(jobLogContext(job), () =>
              executeInSlot(() => processJob(job, queue, runtime, workerId, heartbeatIntervalMs)),
            ),
          {
            name: `${MEDICAL_PLAN_EXECUTION_VERSION}:${workerId}`,
            concurrency: platformSettings.generation.concurrency,
            connection,
            limiter: {
              duration: 1_000,
              max: platformSettings.generation.rateLimit,
            },
            prefix,
          },
        ),
      );
    for (const worker of workers) {
      worker.on("completed", (job) => {
        workerLog("info", "generation-job.completed", { ...jobLogContext(job), name: job.name });
      });
      worker.on("failed", (job, error) => {
        const terminal =
          !job || error instanceof UnrecoverableError || hasExhaustedQueueAttempts(job);
        workerLog(
          terminal ? "error" : "warn",
          terminal ? "generation-job.failed" : "generation-job.retrying",
          {
            ...(job ? jobLogContext(job) : {}),
            attemptsMade: job?.attemptsMade,
            error,
            maxAttempts: job?.opts.attempts ?? 1,
            name: job?.name,
          },
        );
      });
      worker.on("error", (error) => {
        workerLog("error", "generation-worker.error", { error });
      });
    }
    await Promise.all([
      ...queues.map((queue) => queue.waitUntilReady()),
      ...workers.map((worker) => worker.waitUntilReady()),
    ]);

    const legacyQueue = queues[0];
    const medicalQueue = queues[1];
    if (!legacyQueue || !medicalQueue) throw new Error("Generation queues missing");
    const reconciler = new GenerationReconciler(prisma, legacyQueue, runtime, medicalQueue);
    await runReconcile(reconciler);
    const reconcileIntervalMs = platformSettings.generation.reconcileIntervalMs;
    timer = setInterval(() => void runReconcile(reconciler), reconcileIntervalMs);
    timer.unref();

    workerLog("info", "generation-worker.ready", {
      deliveryMode,
      heartbeatIntervalMs,
      leaseDurationMs,
      workerId,
    });
    return { close };
  } catch (error) {
    await close(true).catch(() => undefined);
    throw error;
  }
}

/** Both compatibility queues share the configured execution ceiling. */
export function generationExecutionSlots(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid generation execution limit");
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await operation();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

async function processJob(
  job: Job<OrchestrateJob | EmployeeJob>,
  queue: Queue<OrchestrateJob | EmployeeJob>,
  runtime: GenerationRuntime,
  workerId: string,
  heartbeatIntervalMs: number,
): Promise<Record<string, unknown>> {
  if (job.name === "orchestrate-run") {
    const data = job.data as OrchestrateJob;
    const lease = await claimExecution(() =>
      runtime.claimRun(data.generationRunId, data.tenantId, data.queueVersion, workerId),
    );
    if (!lease) return { generationRunId: data.generationRunId, skipped: true };
    try {
      const workItems = await withHeartbeat(runtime, lease, heartbeatIntervalMs, () =>
        runtime.prepareRun(lease, queue.name === MEDICAL_GENERATION_QUEUE),
      );
      for (const workItem of workItems) {
        await enqueueWorkItem(queue, {
          generationRunId: data.generationRunId,
          queueVersion: workItem.queueVersion,
          reservationVersion: workItem.reservationVersion,
          tenantId: data.tenantId,
          workItemId: workItem.id,
        });
      }
      return { enqueuedWorkItems: workItems.length, generationRunId: data.generationRunId };
    } catch (error) {
      return handleRunFailure(job, runtime, lease, error);
    }
  }
  if (job.name === "generate-employee") {
    const data = job.data as EmployeeJob;
    const lease = await claimExecution(() =>
      runtime.claimWorkItem(data.workItemId, data.tenantId, data.queueVersion, workerId),
    );
    if (!lease) return { generationRunId: data.generationRunId, skipped: true };
    try {
      await withHeartbeat(runtime, lease, heartbeatIntervalMs, () =>
        runtime.generateWorkItem(lease, queue.name === MEDICAL_GENERATION_QUEUE),
      );
      return { generationRunId: data.generationRunId, workItemId: data.workItemId };
    } catch (error) {
      return handleWorkItemFailure(job, runtime, lease, error);
    }
  }
  throw new UnrecoverableError(`Unsupported generation queue job: ${job.name}`);
}

async function handleRunFailure(
  job: Job,
  runtime: GenerationRuntime,
  lease: GenerationExecutionLease,
  error: unknown,
): Promise<Record<string, unknown>> {
  if (error instanceof GenerationLeaseLostError) return supersededResult(lease);
  const failure = classifyGenerationError(error);
  const finalAttempt =
    !failure.retryable || isFinalQueueAttempt(job) || lease.attemptCount >= lease.maxAttempts;
  try {
    if (finalAttempt) {
      await runtime.failRun(lease, failure);
    } else {
      await runtime.resetRunForQueueRetry(
        lease,
        failure,
        new Date(Date.now() + generationRetryDelayMs(lease.attemptCount, 1_000)),
      );
    }
  } catch (stateError) {
    if (stateError instanceof GenerationLeaseLostError) return supersededResult(lease);
    throw stateError;
  }
  if (finalAttempt) throw new UnrecoverableError(`${failure.code}: ${failure.message}`);
  throw error;
}

async function claimExecution(
  operation: () => Promise<GenerationExecutionLease | null>,
): Promise<GenerationExecutionLease | null> {
  try {
    return await operation();
  } catch (error) {
    const failure = classifyGenerationError(error);
    if (!failure.retryable) {
      throw new UnrecoverableError(`${failure.code}: ${failure.message}`);
    }
    throw error;
  }
}

async function handleWorkItemFailure(
  job: Job,
  runtime: GenerationRuntime,
  lease: GenerationExecutionLease,
  error: unknown,
): Promise<Record<string, unknown>> {
  if (error instanceof GenerationLeaseLostError) return supersededResult(lease);
  const failure = classifyGenerationError(error);
  const finalAttempt =
    !failure.retryable || isFinalQueueAttempt(job) || lease.attemptCount >= lease.maxAttempts;
  try {
    if (finalAttempt) {
      await runtime.failWorkItem(lease, failure);
    } else {
      await runtime.resetWorkItemForQueueRetry(
        lease,
        failure,
        new Date(Date.now() + generationRetryDelayMs(lease.attemptCount, 2_000)),
      );
    }
  } catch (stateError) {
    if (stateError instanceof GenerationLeaseLostError) return supersededResult(lease);
    throw stateError;
  }
  if (finalAttempt) throw new UnrecoverableError(`${failure.code}: ${failure.message}`);
  throw error;
}

async function withHeartbeat<T>(
  runtime: GenerationRuntime,
  lease: GenerationExecutionLease,
  intervalMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  let renewing = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void runtime
      .renewLease(lease)
      .then((renewed) => {
        if (!renewed && !stopped) {
          workerLog("warn", "generation-lease.lost", {
            executionVersion: lease.executionVersion,
            resourceId: lease.id,
          });
        }
      })
      .catch((error: unknown) => {
        workerLog("error", "generation-heartbeat.error", { error, resourceId: lease.id });
      })
      .finally(() => {
        renewing = false;
      });
  }, intervalMs);
  timer.unref();
  try {
    return await operation();
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}

async function runReconcile(reconciler: GenerationReconciler): Promise<void> {
  try {
    const result = await reconciler.reconcile();
    if (Object.values(result).some((count) => count > 0)) {
      workerLog("info", "generation-reconcile.completed", { ...result });
    }
  } catch (error) {
    workerLog("error", "generation-reconcile.error", { error });
  }
}

function supersededResult(lease: GenerationExecutionLease): Record<string, unknown> {
  return {
    executionVersion: lease.executionVersion,
    resourceId: lease.id,
    superseded: true,
  };
}

function isFinalQueueAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

function hasExhaustedQueueAttempts(job: Job): boolean {
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    db: Number(url.pathname.slice(1) || 0),
    host: url.hostname,
    password: decodeURIComponent(url.password),
    port: Number(url.port || 6379),
    username: decodeURIComponent(url.username),
  };
}

function requiredEnv(name: "REDIS_PREFIX" | "REDIS_URL"): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function jobLogContext(job: Job<OrchestrateJob | EmployeeJob>): {
  generationRunId: string;
  jobId?: string;
  tenantId: string;
  workItemId?: string;
} {
  const data = job.data;
  return {
    generationRunId: data.generationRunId,
    jobId: job.id,
    tenantId: data.tenantId,
    workItemId: "workItemId" in data ? data.workItemId : undefined,
  };
}

function workerLog(
  level: "error" | "info" | "warn",
  event: string,
  fields?: Readonly<Record<string, unknown>>,
): void {
  writeStructuredLog({ event, fields, level, service: "worker" });
}
