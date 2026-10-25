import { generationDeliveryMode, ModelCredentialCipher } from "@xhs-agentic/ai-gateway";

export function assertProductionWorkerBootstrapPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (environment.NODE_ENV !== "production") return;
  const invalid: string[] = [];
  let deliveryModeReady = false;
  try {
    deliveryModeReady = generationDeliveryMode(environment) === "PRODUCTION";
  } catch {
    // Report the invalid variable below without exposing its configured value.
  }
  if (!deliveryModeReady) invalid.push("GENERATION_DELIVERY_MODE");
  if (environment.GENERATION_EXECUTION_MODE !== "queue") {
    invalid.push("GENERATION_EXECUTION_MODE");
  }
  if (environment.MATERIAL_INGESTION_EXECUTION_MODE === "disabled") {
    invalid.push("MATERIAL_INGESTION_EXECUTION_MODE");
  }
  if (environment.MVP_GENERATION_ADAPTER === "synthetic") {
    invalid.push("MVP_GENERATION_ADAPTER");
  }
  try {
    ModelCredentialCipher.fromEnvironment(environment);
  } catch {
    invalid.push("MODEL_CREDENTIAL_ENCRYPTION_KEY");
  }
  if (invalid.length > 0) {
    throw new Error(`Unsafe production worker configuration: ${invalid.join(", ")}`);
  }
}
