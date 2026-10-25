import { describe, expect, it } from "vitest";
import { generationDeliveryMode, syntheticGenerationAllowed } from "./generation-delivery-mode";

describe("generation delivery mode", () => {
  it("defaults production NODE_ENV to the production delivery boundary", () => {
    expect(generationDeliveryMode({ NODE_ENV: "production" })).toBe("PRODUCTION");
    expect(syntheticGenerationAllowed({ NODE_ENV: "production" })).toBe(false);
  });

  it("allows an explicit development delivery boundary outside production", () => {
    expect(
      generationDeliveryMode({
        GENERATION_DELIVERY_MODE: "development",
        NODE_ENV: "development",
      }),
    ).toBe("DEVELOPMENT");
  });

  it("rejects ambiguous delivery mode values", () => {
    expect(() => generationDeliveryMode({ GENERATION_DELIVERY_MODE: "preview" })).toThrow(
      "GENERATION_DELIVERY_MODE must be DEVELOPMENT or PRODUCTION",
    );
  });
});
