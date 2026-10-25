export type GenerationDeliveryMode = "DEVELOPMENT" | "PRODUCTION";

export function generationDeliveryMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GenerationDeliveryMode {
  const configured = environment.GENERATION_DELIVERY_MODE?.trim().toUpperCase();
  if (configured === "DEVELOPMENT" || configured === "PRODUCTION") return configured;
  if (configured) {
    throw new Error("GENERATION_DELIVERY_MODE must be DEVELOPMENT or PRODUCTION");
  }
  return environment.NODE_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT";
}

export function syntheticGenerationAllowed(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return generationDeliveryMode(environment) === "DEVELOPMENT";
}
