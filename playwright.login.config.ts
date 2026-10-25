import { defineConfig, devices } from "@playwright/test";

// Login security fixtures intercept SMS. No business-data setup or authenticated storage required.
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "login-security.spec.ts",
  workers: 1,
  outputDir: ".artifacts/playwright-login",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3101",
    screenshot: "only-on-failure",
  },
});
