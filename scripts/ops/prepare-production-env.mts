import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { PrismaClient } from "@xhs-agentic/database";
import type { ConfiguredObjectStorageOptions } from "@xhs-agentic/object-storage";
import { loadWorkerPlatformSettings } from "../../apps/worker/src/platform-settings.js";
import { ModelCredentialCipher } from "../../packages/ai-gateway/src/credential-cipher.js";
import { AUTH_SECRET_NAMES, planLocalEnvironment } from "./local-secret-helpers.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const destination = resolve(root, ".env.production.local");
let prisma: PrismaClient | undefined;

async function run() {
  if (existsSync(destination))
    throw new Error(
      "Existing production environment must be reviewed manually; refusing to overwrite it",
    );
  const source = readFileSync(resolve(root, ".env"), "utf8");
  const plan = planLocalEnvironment(source);
  if (plan.rekey || Object.keys(plan.changes).length)
    throw new Error("Harden local application secrets first");
  process.loadEnvFile(resolve(root, ".env"));
  prisma = new PrismaClient();
  const { storage } = await loadWorkerPlatformSettings(prisma);
  const cipher = ModelCredentialCipher.fromEnvironment();
  const signingSettings = await prisma.platformSetting.findMany({
    where: { key: { in: ["publication.metrics_ingest_key", "storage.delivery_signing_key"] } },
  });
  const values: Record<string, string> = { ...plan.environment };
  // Keep the master key paired with the migrated database, but separate production login secrets.
  for (const name of AUTH_SECRET_NAMES) values[name] = randomBytes(32).toString("hex");
  Object.assign(values, {
    NODE_ENV: "production",
    ENABLE_DEV_AUTH: "false",
    GENERATION_DELIVERY_MODE: "PRODUCTION",
    GENERATION_EXECUTION_MODE: "queue",
    MATERIAL_INGESTION_EXECUTION_MODE: "queue",
    MVP_GENERATION_ADAPTER: "openai-compatible",
    ADMIN_WEB_ORIGIN: "",
    NEXT_PUBLIC_API_BASE_URL: "",
    API_HOST: "127.0.0.1",
    API_PORT: "3100",
    TRUST_PROXY_HOPS: "0",
  });
  applyStorageEnvironment(values, storage);
  for (const setting of signingSettings) {
    if (
      !setting.ciphertext ||
      !setting.authenticationTag ||
      !setting.initializationVector ||
      !setting.keyVersion
    )
      throw new Error("Missing application signing secret");
    const plaintext = cipher.decrypt(
      {
        ciphertext: setting.ciphertext,
        authenticationTag: setting.authenticationTag,
        initializationVector: setting.initializationVector,
        keyVersion: setting.keyVersion,
      },
      `xhs-agentic:platform-setting:${setting.key}`,
    );
    values[
      setting.key === "publication.metrics_ingest_key"
        ? "HERMES_INGEST_KEY"
        : "ASSET_DELIVERY_SIGNING_KEY"
    ] = plaintext;
  }
  // Benchmark-only credentials do not belong in a deployment profile.
  for (const name of Object.keys(values))
    if (name.startsWith("PILOT_BENCHMARK_")) delete values[name];
  const lines = Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`);
  const body = `${lines.join("\n")}\n`;
  const parsed = parseEnv(body);
  if (Object.entries(values).some(([name, value]) => parsed[name] !== value))
    throw new Error("Cannot safely encode production environment");
  const header =
    "# PRIVATE deployment draft. Do not commit, serve, or paste this file.\n# Fill ADMIN_WEB_ORIGIN and NEXT_PUBLIC_API_BASE_URL with the real public HTTPS URLs.\n# DATABASE_URL/REDIS_URL still refer to local infrastructure: review the deployment targets.\n# Master key must travel together with the migrated database. Do not replace it independently.\n# No service is switched to production by generating this file.\n";
  writeFileSync(destination, header + body, { mode: 0o600, flag: "wx" });
  console.log(`Production environment draft created (0600): ${destination}`);
  console.log(
    "Fill public HTTPS URLs and deployment database/Redis targets; external provider acceptance remains required.",
  );
}

export function applyStorageEnvironment(
  values: Record<string, string>,
  storage: ConfiguredObjectStorageOptions,
): void {
  if (storage.provider === "LOCAL") {
    values.OBJECT_STORAGE_PROVIDER = "LOCAL";
    values.OBJECT_STORAGE_LOCAL_ROOT = storage.rootDirectory;
    for (const name of [
      "OBJECT_STORAGE_ENDPOINT",
      "OBJECT_STORAGE_REGION",
      "OBJECT_STORAGE_BUCKET",
      "OBJECT_STORAGE_ACCESS_KEY",
      "OBJECT_STORAGE_SECRET_KEY",
      "OBJECT_STORAGE_FORCE_PATH_STYLE",
    ]) {
      delete values[name];
    }
    return;
  }
  delete values.OBJECT_STORAGE_LOCAL_ROOT;
  Object.assign(values, {
    OBJECT_STORAGE_PROVIDER: "S3",
    OBJECT_STORAGE_ENDPOINT: storage.endpoint ?? "",
    OBJECT_STORAGE_REGION: storage.region,
    OBJECT_STORAGE_BUCKET: storage.bucket,
    OBJECT_STORAGE_ACCESS_KEY: storage.accessKeyId,
    OBJECT_STORAGE_SECRET_KEY: storage.secretAccessKey,
    OBJECT_STORAGE_FORCE_PATH_STYLE: String(storage.forcePathStyle ?? false),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .catch(() => {
      console.error(
        "Production environment preparation failed. Check hardened secrets and whether .env.production.local already exists; no existing environment was overwritten.",
      );
      process.exitCode = 1;
    })
    .finally(() => prisma?.$disconnect());
}
