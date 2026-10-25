import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "ip-installation.spec.ts",
  workers: 1,
  reporter: "list",
  outputDir: "../../.artifacts/playwright-ip-installation",
  use: {
    ...devices["Desktop Chrome"],
    channel: process.env.PLAYWRIGHT_CHANNEL,
    actionTimeout: 10000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        "--no-proxy-server",
        "--host-resolver-rules=MAP first-domain.example.test 127.0.0.1,MAP second-domain.example.test 127.0.0.1",
      ],
    },
  },
  webServer: {
    // Use the production handler: Next dev deliberately rejects unfamiliar HMR origins.
    // next start reuses local dependencies when Windows standalone links are unavailable.
    command:
      "node apps/admin-web/node_modules/next/dist/bin/next build apps/admin-web && node apps/admin-web/node_modules/next/dist/bin/next start apps/admin-web --port 23111 --hostname 0.0.0.0",
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
