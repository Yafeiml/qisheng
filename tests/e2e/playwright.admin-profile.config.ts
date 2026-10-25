import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "admin-profile-completion.spec.ts",
  workers: 1,
  reporter: "list",
  outputDir: "../../.artifacts/playwright-admin-profile",
  use: {
    ...devices["Desktop Chrome"],
    channel: process.env.PLAYWRIGHT_CHANNEL,
    baseURL: "http://127.0.0.1:3101",
    storageState: { cookies: [], origins: [] },
    screenshot: "only-on-failure",
  },
});
