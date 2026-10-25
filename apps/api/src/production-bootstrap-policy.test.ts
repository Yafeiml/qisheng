import { describe, expect, it } from "vitest";
import { assertProductionBootstrapPolicy } from "./production-bootstrap-policy";

describe("production bootstrap policy", () => {
  it("does not constrain non-production startup", () => {
    expect(() => assertProductionBootstrapPolicy({ NODE_ENV: "development" })).not.toThrow();
  });

  it("accepts a production environment with independent high-diversity secrets", () => {
    expect(() => assertProductionBootstrapPolicy(productionEnvironment())).not.toThrow();
    const defaultDeliveryMode = productionEnvironment();
    delete defaultDeliveryMode.GENERATION_DELIVERY_MODE;
    expect(() => assertProductionBootstrapPolicy(defaultDeliveryMode)).not.toThrow();
  });

  it("rejects development execution paths in production", () => {
    expect(() =>
      assertProductionBootstrapPolicy({
        ...productionEnvironment(),
        ENABLE_DEV_AUTH: "true",
        GENERATION_DELIVERY_MODE: "DEVELOPMENT",
        GENERATION_EXECUTION_MODE: "inline",
        MVP_GENERATION_ADAPTER: "synthetic",
      }),
    ).toThrow(/ENABLE_DEV_AUTH.*GENERATION_EXECUTION_MODE.*MVP_GENERATION_ADAPTER/u);
  });

  it("allows a loopback-only self-hosted browser but requires HTTPS for remote origins", () => {
    for (const origin of ["http://localhost:3101", "http://127.0.0.1:3101", "http://[::1]:3101"]) {
      expect(() =>
        assertProductionBootstrapPolicy({ ...productionEnvironment(), ADMIN_WEB_ORIGIN: origin }),
      ).not.toThrow();
    }
    for (const origin of [
      "http://admin.example.com",
      "http://localhost.example.com",
      "http://localhost:3101/path",
      "http://user:pass@localhost:3101",
    ]) {
      expect(() =>
        assertProductionBootstrapPolicy({ ...productionEnvironment(), ADMIN_WEB_ORIGIN: origin }),
      ).toThrow("ADMIN_WEB_ORIGIN");
    }
  });

  it("rejects private origins and low-diversity application secrets", () => {
    expect(() =>
      assertProductionBootstrapPolicy({
        ...productionEnvironment(),
        ADMIN_JWT_SECRET: "a".repeat(48),
        ADMIN_WEB_ORIGIN: "https://127.0.0.1",
        MODEL_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      }),
    ).toThrow(/ADMIN_WEB_ORIGIN.*ADMIN_JWT_SECRET.*MODEL_CREDENTIAL_ENCRYPTION_KEY/u);
  });
});

function productionEnvironment(): NodeJS.ProcessEnv {
  return {
    ADMIN_JWT_SECRET: "admin-jwt-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    ADMIN_OTP_HMAC_SECRET: "admin-otp-9876543210-ZYXWVUTSRQPONMLKJIHGFEDCBA",
    ADMIN_WEB_ORIGIN: "https://admin.example.com",
    EMPLOYEE_JWT_SECRET: "employee-jwt-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789",
    EMPLOYEE_OTP_HMAC_SECRET: "employee-otp-ZYXWVUTSRQPONMLKJIHGFEDCBA-9876543210",
    ENABLE_DEV_AUTH: "false",
    GENERATION_DELIVERY_MODE: "PRODUCTION",
    GENERATION_EXECUTION_MODE: "queue",
    MODEL_CREDENTIAL_ENCRYPTION_KEY: Buffer.from(
      Array.from({ length: 32 }, (_, index) => index + 1),
    ).toString("base64"),
    MVP_GENERATION_ADAPTER: "openai-compatible",
    NODE_ENV: "production",
  };
}
