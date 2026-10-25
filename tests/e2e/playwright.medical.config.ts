import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: [
    "medical-selection.spec.ts",
    "content-regeneration.spec.ts",
    "generation-lab.spec.ts",
  ],
  workers: 1,
  outputDir: "../../.artifacts/playwright-medical",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    baseURL: "http://127.0.0.1:3101",
    screenshot: "only-on-failure",
  },
});
