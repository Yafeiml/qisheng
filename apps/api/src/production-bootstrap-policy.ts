import { generationDeliveryMode } from "@xhs-agentic/ai-gateway";
import {
  hasMinimumByteDiversity,
  isProductionRandomSecret,
} from "./platform-settings/production-secret";
import { isProductionHttpsEndpoint } from "./platform-settings/publication-policy-evidence";

const RANDOM_SECRET_KEYS = [
  "ADMIN_JWT_SECRET",
  "EMPLOYEE_JWT_SECRET",
  "ADMIN_OTP_HMAC_SECRET",
  "EMPLOYEE_OTP_HMAC_SECRET",
] as const;

export function assertProductionBootstrapPolicy(
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
  if (!deliveryModeReady) {
    invalid.push("GENERATION_DELIVERY_MODE");
  }
  if (environment.ENABLE_DEV_AUTH === "true") invalid.push("ENABLE_DEV_AUTH");
  if (environment.GENERATION_EXECUTION_MODE !== "queue") {
    invalid.push("GENERATION_EXECUTION_MODE");
  }
  if (environment.MVP_GENERATION_ADAPTER === "synthetic") {
    invalid.push("MVP_GENERATION_ADAPTER");
  }
  if (!productionOrigins(environment.ADMIN_WEB_ORIGIN)) invalid.push("ADMIN_WEB_ORIGIN");
  for (const key of RANDOM_SECRET_KEYS) {
    if (!isProductionRandomSecret(environment[key], 32)) invalid.push(key);
  }
  if (!productionEncryptionKey(environment.MODEL_CREDENTIAL_ENCRYPTION_KEY)) {
    invalid.push("MODEL_CREDENTIAL_ENCRYPTION_KEY");
  }
  if (invalid.length > 0) {
    throw new Error(`Unsafe production bootstrap configuration: ${invalid.join(", ")}`);
  }
}

function productionOrigins(value: string | undefined): boolean {
  const origins = (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return (
    origins.length > 0 &&
    origins.every((origin) => {
      try {
        const url = new URL(origin);
        const local =
          url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (!local && !isProductionHttpsEndpoint(origin)) return false;
        return url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
      } catch {
        return false;
      }
    })
  );
}

function productionEncryptionKey(value: string | undefined): boolean {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  const key = Buffer.from(value, "base64");
  return key.byteLength === 32 && hasMinimumByteDiversity(key);
}
