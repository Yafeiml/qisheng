import { defineConfig, devices } from "@playwright/test";

// Every identity and business request is mocked; no demo mutations or providers.
export default defineConfig({
  testDir: ".",
  testMatch: ["checkbox-console.spec.ts", "checkbox-platform.spec.ts", "checkbox-states.spec.ts"],
  workers: 1,
  reporter: "list",
  outputDir: "../../.artifacts/playwright-checkbox",
  use: {
    ...devices["Desktop Chrome"],
    channel: process.env.PLAYWRIGHT_CHANNEL,
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 10_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
