import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { postgresConnectionStringWithUtcSession } from "@xhs-agentic/observability";
import { type ConnectionOptions, type Job, Queue, QueueEvents, Worker } from "bullmq";
import { Pool } from "pg";

const envPath = resolve(__dirname, "../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

function requiredEnv(name: "DATABASE_URL" | "REDIS_PREFIX" | "REDIS_URL"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    db: Number(url.pathname.slice(1) || 0),
  };
}

async function run(): Promise<void> {
  const database = new Pool({
    connectionString: postgresConnectionStringWithUtcSession(requiredEnv("DATABASE_URL")),
    max: 1,
  });
  const connection = redisConnection(requiredEnv("REDIS_URL"));
  const prefix = requiredEnv("REDIS_PREFIX");
  const queueName = "phase-zero-probe";
  const queue = new Queue(queueName, { connection, prefix });
  const queueEvents = new QueueEvents(queueName, { connection, prefix });
  const worker = new Worker(
    queueName,
    async (job: Job<{ runId: string }>) => ({ runId: job.data.runId, processed: true }),
    { connection, prefix },
  );

  try {
    const databaseResult = await database.query<{
      database: string;
      username: string;
    }>("SELECT current_database() AS database, current_user AS username");

    await Promise.all([
      queue.waitUntilReady(),
      queueEvents.waitUntilReady(),
      worker.waitUntilReady(),
    ]);

    const runId = randomUUID();
    const job = await queue.add("round-trip", { runId }, { removeOnComplete: true });
    const jobResult = (await job.waitUntilFinished(queueEvents, 10_000)) as {
      processed: boolean;
      runId: string;
    };

    const databaseRow = databaseResult.rows[0];
    if (!databaseRow || jobResult.runId !== runId || !jobResult.processed) {
      throw new Error("Infrastructure probe returned an unexpected result");
    }

    process.stdout.write(
      `${JSON.stringify({
        postgres: `${databaseRow.database}:${databaseRow.username}`,
        bullmq: "round-trip-ok",
      })}\n`,
    );
  } finally {
    await Promise.allSettled([worker.close(), queueEvents.close(), queue.close(), database.end()]);
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown infrastructure probe error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
