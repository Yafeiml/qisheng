import { describe, expect, it } from "vitest";
import { assertProductionWorkerBootstrapPolicy } from "./production-bootstrap-policy";

describe("production worker bootstrap policy", () => {
  it("does not constrain non-production worker startup", () => {
    expect(() => assertProductionWorkerBootstrapPolicy({ NODE_ENV: "development" })).not.toThrow();
  });

  it("accepts queue workers with a high-diversity credential key", () => {
    expect(() => assertProductionWorkerBootstrapPolicy(productionEnvironment())).not.toThrow();
    const defaultDeliveryMode = productionEnvironment();
    delete defaultDeliveryMode.GENERATION_DELIVERY_MODE;
    expect(() => assertProductionWorkerBootstrapPolicy(defaultDeliveryMode)).not.toThrow();
  });

  it("rejects disabled production workers and synthetic execution", () => {
    expect(() =>
      assertProductionWorkerBootstrapPolicy({
        ...productionEnvironment(),
        GENERATION_DELIVERY_MODE: "DEVELOPMENT",
        GENERATION_EXECUTION_MODE: "inline",
        MATERIAL_INGESTION_EXECUTION_MODE: "disabled",
        MVP_GENERATION_ADAPTER: "synthetic",
      }),
    ).toThrow(
      /GENERATION_DELIVERY_MODE.*GENERATION_EXECUTION_MODE.*MATERIAL_INGESTION_EXECUTION_MODE.*MVP_GENERATION_ADAPTER/u,
    );
  });

  it("rejects a missing or low-diversity credential encryption key", () => {
    const missing = productionEnvironment();
    delete missing.MODEL_CREDENTIAL_ENCRYPTION_KEY;
    expect(() => assertProductionWorkerBootstrapPolicy(missing)).toThrow(
      /MODEL_CREDENTIAL_ENCRYPTION_KEY/u,
    );
    expect(() =>
      assertProductionWorkerBootstrapPolicy({
        ...productionEnvironment(),
        MODEL_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      }),
    ).toThrow(/MODEL_CREDENTIAL_ENCRYPTION_KEY/u);
  });
});

function productionEnvironment(): NodeJS.ProcessEnv {
  return {
    GENERATION_DELIVERY_MODE: "PRODUCTION",
    GENERATION_EXECUTION_MODE: "queue",
    MATERIAL_INGESTION_EXECUTION_MODE: "queue",
    MODEL_CREDENTIAL_ENCRYPTION_KEY: Buffer.from(
      Array.from({ length: 32 }, (_, index) => index + 1),
    ).toString("base64"),
    MVP_GENERATION_ADAPTER: "openai-compatible",
    NODE_ENV: "production",
  };
}
