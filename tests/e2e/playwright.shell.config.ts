import { defineConfig, devices } from "@playwright/test";

// Standalone fixtures: deliberately omit the default global setup and database access.
export default defineConfig({
  testDir: ".",
  testMatch: ["shell-entry-switcher.spec.ts"],
  workers: 1,
  reporter: "list",
  outputDir: "../../.artifacts/playwright-shell",
  use: {
    ...devices["Desktop Chrome"],
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    baseURL: "http://127.0.0.1:3101",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
