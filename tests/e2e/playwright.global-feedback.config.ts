import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "global-feedback.spec.ts",
  workers: 1,
  reporter: "list",
  outputDir: "../../.artifacts/playwright-global-feedback",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3101",
    storageState: { cookies: [], origins: [] },
    screenshot: "only-on-failure",
  },
});
