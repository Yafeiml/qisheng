import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { writeStructuredLog } from "@xhs-agentic/observability";
import { type ConnectionOptions, Queue } from "bullmq";

export const MATERIAL_INGESTION_QUEUE_NAME = "material-ingestion-v1";

export type MaterialIngestionQueueJob = Readonly<{
  ingestionJobId: string;
  materialId: string;
  queueVersion: number;
  tenantId: string;
}>;

export type MaterialIngestionQueueMetrics = Readonly<{
  active: number;
  delayed: number;
  failed: number;
  paused: boolean;
  waiting: number;
  workers: number;
}>;

@Injectable()
export class MaterialIngestionQueueService implements OnModuleDestroy {
  private queue?: Queue<MaterialIngestionQueueJob>;

  async enqueue(data: MaterialIngestionQueueJob): Promise<void> {
    await this.getQueue().add("ingest-material", data, {
      attempts: 5,
      backoff: { delay: 2_000, type: "exponential" },
      jobId: `material-${data.materialId}-q${data.queueVersion}`,
      removeOnComplete: { age: 86_400, count: 5_000 },
      removeOnFail: { age: 604_800, count: 10_000 },
    });
    writeStructuredLog({
      event: "material-ingestion.enqueued",
      fields: data,
      level: "info",
      service: "api",
    });
  }

  async getOperationalMetrics(): Promise<MaterialIngestionQueueMetrics> {
    const queue = this.getQueue();
    const [counts, paused, workers] = await Promise.all([
      queue.getJobCounts("active", "delayed", "failed", "waiting"),
      queue.isPaused(),
      queue.getWorkersCount(),
    ]);
    return {
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      paused,
      waiting: counts.waiting ?? 0,
      workers,
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  private getQueue(): Queue<MaterialIngestionQueueJob> {
    this.queue ??= new Queue<MaterialIngestionQueueJob>(MATERIAL_INGESTION_QUEUE_NAME, {
      connection: redisConnection(requiredEnv("REDIS_URL")),
      prefix: requiredEnv("REDIS_PREFIX"),
    });
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
