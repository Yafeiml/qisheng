import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: [
    "medical-materials.spec.ts",
    "material-intake.spec.ts",
    "material-failure-guidance.spec.ts",
  ],
  workers: 1,
  outputDir: "../../.artifacts/playwright-medical-materials",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    baseURL: "http://127.0.0.1:3101",
    screenshot: "only-on-failure",
  },
});
