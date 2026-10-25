import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 5_000 },
  fullyParallel: false,
  globalSetup: "./tests/e2e/global-setup.ts",
  outputDir: ".artifacts/playwright",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  testDir: "./tests/e2e",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3101",
    screenshot: "only-on-failure",
    storageState: ".artifacts/mvp-storage-state.json",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { height: 1000, width: 1440 } },
    },
  ],
});
