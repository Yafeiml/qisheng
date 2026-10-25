import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "content-safety-settings.spec.ts",
  workers: 1,
  reporter: "list",
  outputDir: "../../.artifacts/playwright-content-safety",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 1440, height: 1000 },
  },
});
