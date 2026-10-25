import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { ModelCredentialCipher } from "../../packages/ai-gateway/src/credential-cipher";
import {
  AUTH_SECRET_NAMES,
  planLocalEnvironment,
  replaceEnvValues,
  strongEncryptionKey,
} from "./local-secret-helpers";

describe("local release secret preparation", () => {
  it("generates independent secrets and preserves unrelated developer configuration", () => {
    const before =
      "# keep this\nNODE_ENV=development\nADMIN_WEB_ORIGIN=http://127.0.0.1:3101\nDATABASE_URL=postgresql://user:secret@localhost/db\nADMIN_JWT_SECRET=dev-only\n";
    const plan = planLocalEnvironment(before);
    const updated = replaceEnvValues(before, plan.changes);
    const env = parseEnv(updated);
    expect(plan.rekey).toBe(true);
    expect(strongEncryptionKey(env.MODEL_CREDENTIAL_ENCRYPTION_KEY)).toBe(true);
    expect(new Set(AUTH_SECRET_NAMES.map((name) => env[name])).size).toBe(4);
    expect(AUTH_SECRET_NAMES.every((name) => env[name]?.length === 64)).toBe(true);
    expect(updated).toContain("# keep this\nNODE_ENV=development");
    expect(env.DATABASE_URL).toBe(parseEnv(before).DATABASE_URL);
    expect(planLocalEnvironment(updated).changes).toEqual({});
  });

  it("re-encrypts existing development ciphertext without changing the provider secret", () => {
    const plan = planLocalEnvironment("NODE_ENV=development\n");
    const oldCipher = ModelCredentialCipher.fromEnvironment(plan.environment);
    const newCipher = ModelCredentialCipher.fromEnvironment({
      ...plan.environment,
      ...plan.changes,
    });
    for (const aad of [
      "xhs-agentic:platform-setting:storage.secret_access_key",
      "xhs-agentic:model-provider:provider:credential:key",
      "xhs-agentic:directory:tenant:connection:connection",
    ]) {
      const old = oldCipher.encrypt("existing-provider-secret", aad);
      const rotated = newCipher.encrypt(oldCipher.decrypt(old, aad), aad);
      expect(newCipher.decrypt(rotated, aad)).toBe("existing-provider-secret");
      expect(() => oldCipher.decrypt(rotated, aad)).toThrow();
      expect(() => newCipher.decrypt(rotated, "incorrect-scope")).toThrow();
    }
  });

  it("replaces duplicate assignments and rejects unsafe generated values", () => {
    expect(
      parseEnv(
        replaceEnvValues("ADMIN_JWT_SECRET=one\nexport ADMIN_JWT_SECRET=two\n", {
          ADMIN_JWT_SECRET: "safe",
        }),
      ).ADMIN_JWT_SECRET,
    ).toBe("safe");
    expect(() => replaceEnvValues("", { ADMIN_JWT_SECRET: "value\nINJECTED=value" })).toThrow();
  });
});
