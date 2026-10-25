import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const AUTHENTICATION_TAG_BYTES = 16;
const INITIALIZATION_VECTOR_BYTES = 12;
const KEY_BYTES = 32;

export type EncryptedCredential = Readonly<{
  authenticationTag: Uint8Array;
  ciphertext: Uint8Array;
  initializationVector: Uint8Array;
  keyVersion: string;
}>;

export class ModelCredentialCipher {
  private constructor(
    private readonly key: Buffer,
    readonly keyVersion: string,
  ) {}

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): ModelCredentialCipher {
    const configured = environment.MODEL_CREDENTIAL_ENCRYPTION_KEY?.trim();
    if (!configured) {
      if (environment.NODE_ENV === "production") {
        throw new Error("MODEL_CREDENTIAL_ENCRYPTION_KEY is required in production");
      }
      return new ModelCredentialCipher(
        createHash("sha256")
          .update("xhs-agentic-dedicated-development-model-credential-key-v1")
          .digest(),
        "development-v1",
      );
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(configured)) {
      throw new Error("MODEL_CREDENTIAL_ENCRYPTION_KEY must be base64 encoded");
    }
    const key = Buffer.from(configured, "base64");
    if (key.byteLength !== KEY_BYTES) {
      throw new Error("MODEL_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
    if (environment.NODE_ENV === "production" && new Set(key).size < 12) {
      throw new Error("MODEL_CREDENTIAL_ENCRYPTION_KEY has insufficient byte diversity");
    }
    const keyVersion = environment.MODEL_CREDENTIAL_ENCRYPTION_KEY_VERSION?.trim() || "v1";
    if (!/^[A-Za-z0-9._-]{1,40}$/u.test(keyVersion)) {
      throw new Error("MODEL_CREDENTIAL_ENCRYPTION_KEY_VERSION has an invalid format");
    }
    return new ModelCredentialCipher(key, keyVersion);
  }

  encrypt(plaintext: string, associatedData: string): EncryptedCredential {
    if (!plaintext.trim()) throw new Error("Model provider API key cannot be empty");
    const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, initializationVector, {
      authTagLength: AUTHENTICATION_TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      authenticationTag: cipher.getAuthTag(),
      ciphertext,
      initializationVector,
      keyVersion: this.keyVersion,
    };
  }

  decrypt(encrypted: EncryptedCredential, associatedData: string): string {
    if (encrypted.keyVersion !== this.keyVersion) {
      throw new Error(`Model credential key version is unavailable: ${encrypted.keyVersion}`);
    }
    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        this.key,
        Buffer.from(encrypted.initializationVector),
        { authTagLength: AUTHENTICATION_TAG_BYTES },
      );
      decipher.setAAD(Buffer.from(associatedData, "utf8"));
      decipher.setAuthTag(Buffer.from(encrypted.authenticationTag));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Model credential could not be decrypted or authenticated");
    }
  }
}

export function modelCredentialAssociatedData(providerId: string, credentialId: string): string {
  return `xhs-agentic:model-provider:${providerId}:credential:${credentialId}`;
}

export function modelCredentialLastFour(apiKey: string): string {
  return apiKey.slice(-4);
}
