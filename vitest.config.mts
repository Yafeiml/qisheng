import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootEnvPath = fileURLToPath(new URL("./.env", import.meta.url));
if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

const configuredRedisPrefix = process.env.REDIS_PREFIX;
const testRedisPrefix = configuredRedisPrefix
  ? `${configuredRedisPrefix}:vitest:${process.pid}:${Date.now()}`
  : undefined;
if (testRedisPrefix) process.env.REDIS_PREFIX = testRedisPrefix;

export default defineConfig({
  resolve: {
    alias: {
      "@xhs-agentic/ai-gateway": fileURLToPath(
        new URL("./packages/ai-gateway/src/index.ts", import.meta.url),
      ),
      "@xhs-agentic/observability": fileURLToPath(
        new URL("./packages/observability/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      RATE_LIMIT_AUTH_IP_MAX: "10000",
      RATE_LIMIT_EXPENSIVE_MAX: "10000",
      RATE_LIMIT_GLOBAL_MAX: "10000",
      RATE_LIMIT_INTEGRATION_MAX: "10000",
      ...(testRedisPrefix ? { REDIS_PREFIX: testRedisPrefix } : {}),
    },
    exclude: [
      "deploy/**/*.test.mjs",
      "scripts/**/*.test.mjs",
      "tests/e2e/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.artifacts/**",
    ],
    fileParallelism: false,
    globalSetup: testRedisPrefix ? ["./apps/api/src/testing/vitest-global-teardown.ts"] : [],
  },
});
