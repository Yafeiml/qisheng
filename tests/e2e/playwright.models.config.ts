import { defineConfig, devices } from "@playwright/test";

// Isolated UI regression suite; never runs the demo-data global setup.
export default defineConfig({
  testDir: ".",
  testMatch: ["model-configuration.spec.ts", "generation-service-notice.spec.ts"],
  workers: 1,
  outputDir: "../../.artifacts/playwright-models",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 1440, height: 1000 },
  },
});
