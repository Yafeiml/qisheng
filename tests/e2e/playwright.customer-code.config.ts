import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "customer-code-generation.spec.ts",
  workers: 1,
  reporter: "list",
  outputDir: "../../.artifacts/playwright-customer-code",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 1440, height: 850 },
    screenshot: "only-on-failure",
  },
});
