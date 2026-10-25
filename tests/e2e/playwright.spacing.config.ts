import { defineConfig, devices } from "@playwright/test";

// Form submissions in the focused suites are mocked. The site survey only
// navigates the existing local demo; no destructive global demo setup is run.
export default defineConfig({
  testDir: ".",
  testMatch: [
    "console-spacing.spec.ts",
    "platform-spacing.spec.ts",
    "public-spacing.spec.ts",
    "site-spacing.spec.ts",
  ],
  workers: 1,
  reporter: "list",
  outputDir: "../../.artifacts/playwright-spacing",
  use: {
    ...devices["Desktop Chrome"],
    channel: process.env.PLAYWRIGHT_CHANNEL,
    actionTimeout: 10_000,
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
