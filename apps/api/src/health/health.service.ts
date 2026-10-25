import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { postgresConnectionStringWithUtcSession } from "@xhs-agentic/observability";
import Redis from "ioredis";
import { Pool } from "pg";
import { GenerationQueueService } from "../campaign/generation-queue.service";
import { ImageDeliveryService } from "../campaign/image-delivery.service";

type CheckResult = {
  status: "ok" | "error";
  latencyMs: number;
};

export type ReadinessResult = Readonly<{
  checks: Readonly<{
    database: CheckResult;
    generationQueue: CheckResult;
    objectStorage: CheckResult;
    redis: CheckResult;
  }>;
  status: "error" | "ok";
}>;

@Injectable()
export class HealthService implements OnApplicationShutdown {
  private readonly checkTimeoutMs = positiveInteger(
    process.env.READINESS_TIMEOUT_MS ?? "3000",
    "READINESS_TIMEOUT_MS",
  );

  private readonly database = new Pool({
    connectionString: postgresConnectionStringWithUtcSession(this.requiredEnv("DATABASE_URL")),
    connectionTimeoutMillis: this.checkTimeoutMs,
    max: 2,
  });

  private readonly redis = new Redis(this.requiredEnv("REDIS_URL"), {
    commandTimeout: this.checkTimeoutMs,
    connectTimeout: this.checkTimeoutMs,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  constructor(
    @Inject(GenerationQueueService)
    private readonly generationQueue: GenerationQueueService,
    @Inject(ImageDeliveryService)
    private readonly imageDelivery: ImageDeliveryService,
  ) {}

  async checkDependencies(): Promise<ReadinessResult> {
    const [database, redis, objectStorage, generationQueue] = await Promise.all([
      this.measure(async () => {
        await this.database.query("SELECT 1");
      }),
      this.measure(async () => {
        if (this.redis.status === "wait") {
          await this.redis.connect();
        }
        await this.redis.ping();
      }),
      this.measure(() => this.imageDelivery.checkReadiness()),
      this.measure(() => this.generationQueue.checkReadiness()),
    ]);

    const checks = { database, generationQueue, objectStorage, redis };

    return {
      checks,
      status: Object.values(checks).every((check) => check.status === "ok") ? "ok" : "error",
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.database.end(), this.redis.quit()]);
  }

  private async measure(operation: () => Promise<void>): Promise<CheckResult> {
    const startedAt = performance.now();
    try {
      await withTimeout(operation(), this.checkTimeoutMs);
      return { status: "ok", latencyMs: Math.round(performance.now() - startedAt) };
    } catch {
      return { status: "error", latencyMs: Math.round(performance.now() - startedAt) };
    }
  }

  private requiredEnv(name: "DATABASE_URL" | "REDIS_URL"): string {
    const value = process.env[name];
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
  }
}

async function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Readiness dependency check timed out")), timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
