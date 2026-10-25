import Redis from "ioredis";

const TEST_PREFIX_MARKER = ":vitest:";

export async function teardown(): Promise<void> {
  const prefix = process.env.REDIS_PREFIX;
  const redisUrl = process.env.REDIS_URL;
  if (!prefix || !redisUrl) return;
  if (!prefix.includes(TEST_PREFIX_MARKER)) {
    throw new Error(`Refusing to clean a non-test Redis namespace: ${prefix}`);
  }
  if (!/^[A-Za-z0-9:_-]+$/u.test(prefix)) {
    throw new Error("Vitest Redis namespace contains unsupported glob characters");
  }

  const redis = new Redis(redisUrl, {
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await redis.connect();
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 500);
      cursor = nextCursor;
      if (keys.length > 0) await redis.unlink(...keys);
    } while (cursor !== "0");
  } finally {
    redis.disconnect();
  }
}
