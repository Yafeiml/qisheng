import { defineConfig, devices } from "@playwright/test";

// Isolated requests: no demo initialization or real model invocations.
export default defineConfig({
  testDir: ".",
  testMatch: "generation-styles.spec.ts",
  workers: 1,
  outputDir: "../../.artifacts/playwright-styles",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
});
