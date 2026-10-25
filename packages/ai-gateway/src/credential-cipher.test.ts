import { describe, expect, it } from "vitest";
import {
  ModelCredentialCipher,
  modelCredentialAssociatedData,
  modelCredentialLastFour,
} from "./credential-cipher";

const environment = {
  MODEL_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  MODEL_CREDENTIAL_ENCRYPTION_KEY_VERSION: "test-v1",
  NODE_ENV: "test",
};

describe("model credential cipher", () => {
  it("encrypts with authenticated provider and credential identity", () => {
    const cipher = ModelCredentialCipher.fromEnvironment(environment);
    const apiKey = "fixture-model-provider-secret-value";
    const associatedData = modelCredentialAssociatedData("provider-a", "credential-a");
    const encrypted = cipher.encrypt(apiKey, associatedData);

    expect(Buffer.from(encrypted.ciphertext).toString("utf8")).not.toContain(apiKey);
    expect(encrypted.initializationVector).toHaveLength(12);
    expect(encrypted.authenticationTag).toHaveLength(16);
    expect(cipher.decrypt(encrypted, associatedData)).toBe(apiKey);
    expect(() => cipher.decrypt(encrypted, `${associatedData}:tampered`)).toThrow(
      "could not be decrypted",
    );
  });

  it("requires an explicit production key and returns only a suffix for display", () => {
    expect(() => ModelCredentialCipher.fromEnvironment({ NODE_ENV: "production" })).toThrow(
      "required in production",
    );
    expect(() =>
      ModelCredentialCipher.fromEnvironment({
        MODEL_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        NODE_ENV: "production",
      }),
    ).toThrow("insufficient byte diversity");
    expect(modelCredentialLastFour("sk-secret-1234")).toBe("1234");
  });
});
