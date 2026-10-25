import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["material-intake.spec.ts", "poster-references.spec.ts", "promotion-focus.spec.ts"],
  workers: 1,
  reporter: "list",
  outputDir: "../../.artifacts/playwright-materials",
  use: {
    ...devices["Desktop Chrome"],
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
