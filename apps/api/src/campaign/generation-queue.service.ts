import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { MEDICAL_GENERATION_QUEUE } from "@xhs-agentic/ai-gateway";
import { writeStructuredLog } from "@xhs-agentic/observability";
import { type ConnectionOptions, Queue } from "bullmq";

export const GENERATION_QUEUE_NAME = "campaign-generation-v1";

export type GenerationQueueJob = Readonly<{
  generationRunId: string;
  queueVersion: number;
  tenantId: string;
  medical?: boolean;
}>;

export type GenerationWorkItemQueueJob = GenerationQueueJob &
  Readonly<{ reservationVersion: number; workItemId: string }>;

export type GenerationQueueMetrics = Readonly<{
  active: number;
  completed: number;
  delayed: number;
  failed: number;
  paused: boolean;
  waiting: number;
  workers: number;
}>;

@Injectable()
export class GenerationQueueService implements OnModuleDestroy {
  private queue?: Queue<GenerationQueueJob>;
  private medicalQueue?: Queue<GenerationQueueJob>;

  async enqueueRun(data: GenerationQueueJob): Promise<void> {
    const queue = this.getQueue(data.medical);
    await queue.add("orchestrate-run", data, {
      attempts: 5,
      backoff: { delay: 1_000, type: "exponential" },
      jobId: `run-${data.generationRunId}-q${data.queueVersion}`,
      removeOnComplete: { age: 86_400, count: 2_000 },
      removeOnFail: { age: 604_800, count: 5_000 },
    });
    writeStructuredLog({
      event: "generation-run.enqueued",
      fields: {
        generationRunId: data.generationRunId,
        queueVersion: data.queueVersion,
        tenantId: data.tenantId,
      },
      level: "info",
      service: "api",
    });
  }

  async enqueueWorkItem(data: GenerationWorkItemQueueJob): Promise<void> {
    await this.getQueue(data.medical).add("generate-employee", data, {
      attempts: 3,
      backoff: { delay: 2_000, type: "exponential" },
      jobId: `work-${data.workItemId}-q${data.queueVersion}`,
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 604_800, count: 20_000 },
    });
  }

  async checkReadiness(): Promise<void> {
    const queue = this.getQueue();
    await queue.waitUntilReady();
    await queue.getJobCounts("active", "delayed", "failed", "waiting");
  }

  async getOperationalMetrics(medical?: boolean): Promise<GenerationQueueMetrics> {
    if (medical === undefined) {
      const [legacy, current] = await Promise.all([
        this.getOperationalMetrics(false),
        this.getOperationalMetrics(true),
      ]);
      return {
        active: legacy.active + current.active,
        completed: legacy.completed + current.completed,
        delayed: legacy.delayed + current.delayed,
        failed: legacy.failed + current.failed,
        waiting: legacy.waiting + current.waiting,
        paused: legacy.paused || current.paused,
        workers: Math.min(legacy.workers, current.workers),
      };
    }
    const queue = this.getQueue(medical);
    const [counts, paused, workers] = await Promise.all([
      queue.getJobCounts("active", "completed", "delayed", "failed", "waiting"),
      queue.isPaused(),
      queue.getWorkersCount(),
    ]);
    return {
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      paused,
      waiting: counts.waiting ?? 0,
      workers,
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    await this.medicalQueue?.close();
  }

  private getQueue(medical = false): Queue<GenerationQueueJob | GenerationWorkItemQueueJob> {
    if (medical) {
      this.medicalQueue ??= new Queue<GenerationQueueJob>(MEDICAL_GENERATION_QUEUE, {
        connection: redisConnection(requiredEnv("REDIS_URL")),
        prefix: requiredEnv("REDIS_PREFIX"),
      });
      return this.medicalQueue;
    }
    if (!this.queue) {
      this.queue = new Queue<GenerationQueueJob>(GENERATION_QUEUE_NAME, {
        connection: redisConnection(requiredEnv("REDIS_URL")),
        prefix: requiredEnv("REDIS_PREFIX"),
      });
    }
    return this.queue;
  }
}

function requiredEnv(name: "REDIS_PREFIX" | "REDIS_URL"): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
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
