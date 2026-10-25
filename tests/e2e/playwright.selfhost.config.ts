import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// All identities, business writes and model services are fixtures.
export default defineConfig({
  testDir: ".",
  testMatch: [
    "selfhost.spec.ts",
    "login-security.spec.ts",
    "installation.spec.ts",
    "industry-guidance.spec.ts",
  ],
  workers: 1,
  reporter: "list",
  outputDir: "../../.artifacts/playwright-selfhost",
  use: {
    ...devices["Desktop Chrome"],
    channel: process.env.PLAYWRIGHT_CHANNEL,
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:23111",
    actionTimeout: 10000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "node apps/admin-web/node_modules/next/dist/bin/next build apps/admin-web && node apps/admin-web/node_modules/next/dist/bin/next start apps/admin-web --port 23111 --hostname 127.0.0.1",
    cwd: resolve(__dirname, "../.."),
    url: "http://127.0.0.1:23111/setup",
    timeout: 120000,
    reuseExistingServer: false,
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_API_BASE_URL: "/api",
      INTERNAL_API_BASE_URL: "http://127.0.0.1:23110",
    },
  },
});
