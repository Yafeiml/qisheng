import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "generation-lab.spec.ts",
  workers: 1,
  outputDir: "../../.artifacts/playwright-lab",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
});
