import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import {
  hasMinimumByteDiversity,
  isProductionRandomSecret,
} from "../../apps/api/src/platform-settings/production-secret.js";

export const AUTH_SECRET_NAMES = [
  "ADMIN_JWT_SECRET",
  "EMPLOYEE_JWT_SECRET",
  "ADMIN_OTP_HMAC_SECRET",
  "EMPLOYEE_OTP_HMAC_SECRET",
] as const;

export function strongEncryptionKey(value: string | undefined): boolean {
  return Boolean(
    value &&
      /^[A-Za-z0-9+/]+={0,2}$/u.test(value) &&
      Buffer.from(value, "base64").length === 32 &&
      hasMinimumByteDiversity(Buffer.from(value, "base64")),
  );
}

export function replaceEnvValues(text: string, changes: Record<string, string>): string {
  let result = text;
  for (const [name, value] of Object.entries(changes)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || !/^[A-Za-z0-9+/=_-]+$/u.test(value))
      throw new Error("Unsafe generated environment assignment");
    const pattern = new RegExp(`^(?:export\\s+)?${name}=.*$`, "gm");
    result = pattern.test(result)
      ? result.replace(pattern, `${name}=${value}`)
      : `${result.replace(/\s*$/u, "")}\n${name}=${value}\n`;
  }
  return result;
}

export function planLocalEnvironment(text: string) {
  const environment = parseEnv(text);
  const changes: Record<string, string> = {};
  for (const name of AUTH_SECRET_NAMES) {
    if (!isProductionRandomSecret(environment[name], 32))
      changes[name] = randomBytes(32).toString("hex");
  }
  const rekey = !strongEncryptionKey(environment.MODEL_CREDENTIAL_ENCRYPTION_KEY);
  if (rekey) {
    changes.MODEL_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    changes.MODEL_CREDENTIAL_ENCRYPTION_KEY_VERSION = `local-${Date.now()}-${randomBytes(3).toString("hex")}`;
  }
  return { environment, changes, rekey };
}
