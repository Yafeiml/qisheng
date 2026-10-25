import { writeStructuredLog } from "@xhs-agentic/observability";
import Redis, { type RedisOptions } from "ioredis";

export function createLazyRedisClient(component: string, options: RedisOptions = {}): Redis {
  const client = new Redis(requiredRedisUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    ...options,
  });
  client.on("error", (error) => {
    writeStructuredLog({
      event: "redis.client.error",
      fields: { component, error },
      level: "warn",
      service: "api",
    });
  });
  return client;
}

export async function closeRedisClient(client: Redis): Promise<void> {
  if (client.status === "ready") {
    await client.quit();
    return;
  }
  client.disconnect();
}

function requiredRedisUrl(): string {
  const value = process.env.REDIS_URL;
  if (!value) throw new Error("Missing required environment variable: REDIS_URL");
  return value;
}
