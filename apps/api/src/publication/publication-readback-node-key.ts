import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isProductionRandomSecret } from "../platform-settings/production-secret";

export const MANAGED_READBACK_NODE_ID = "selfhost-readback";

export function managedReadbackNodeKey(): string | null {
  const runtime =
    process.env.QISHENG_RUNTIME_CONFIG ??
    process.env.QISHENG_CONFIG_FILE ??
    "/run/qisheng/runtime.json";
  try {
    const file = resolve(dirname(runtime), "readback-node-key");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return null;
    const key = readFileSync(file, "utf8").trim();
    return /^[\x21-\x7e]{32,512}$/u.test(key) &&
      (process.env.NODE_ENV !== "production" || isProductionRandomSecret(key, 32))
      ? key
      : null;
  } catch {
    return null;
  }
}
