import { ModelCredentialCipher, modelCredentialAssociatedData } from "@xhs-agentic/ai-gateway";
import {
  type ContentSafetyConfiguration,
  contentSafetyFingerprint,
} from "@xhs-agentic/content-safety";
import type { PlatformSetting, PrismaClient } from "@xhs-agentic/database";
import {
  type ConfiguredObjectStorageOptions,
  localStorageOptionsFromEnvironment,
} from "@xhs-agentic/object-storage";

const workerSettingKeys = [
  "content_safety.api_key",
  "content_safety.endpoint",
  "content_safety.mode",
  "content_safety.provider",
  "content_safety.timeout_ms",
  "content_safety.model_provider_id",
  "content_safety.model",
  "storage.access_key_id",
  "storage.provider",
  "storage.bucket",
  "storage.endpoint",
  "storage.force_path_style",
  "storage.region",
  "storage.secret_access_key",
  "worker.generation_concurrency",
  "worker.generation_heartbeat_interval_ms",
  "worker.generation_lease_duration_ms",
  "worker.generation_rate_limit",
  "worker.generation_reconcile_interval_ms",
  "worker.material_ingestion_concurrency",
  "worker.material_reconcile_interval_ms",
  "worker.provider_circuit_cooldown_ms",
  "worker.provider_circuit_failure_threshold",
  "worker.provider_circuit_probe_lease_ms",
] as const;

export type WorkerPlatformSettings = Readonly<{
  contentSafety: ContentSafetyConfiguration & Readonly<{ verified: boolean }>;
  generation: Readonly<{
    circuitBreaker: Readonly<{
      cooldownMs: number;
      failureThreshold: number;
      probeLeaseMs: number;
    }>;
    concurrency: number;
    heartbeatIntervalMs: number;
    leaseDurationMs: number;
    rateLimit: number;
    reconcileIntervalMs: number;
  }>;
  material: Readonly<{
    concurrency: number;
    reconcileIntervalMs: number;
  }>;
  storage: ConfiguredObjectStorageOptions;
}>;

export async function loadWorkerPlatformSettings(
  prisma: PrismaClient,
  options: Readonly<{ contentSafety?: boolean }> = {},
): Promise<WorkerPlatformSettings> {
  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: [...workerSettingKeys] } },
  });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const generation = {
    circuitBreaker: {
      cooldownMs: integer(
        byKey,
        "worker.provider_circuit_cooldown_ms",
        "PROVIDER_CIRCUIT_COOLDOWN_MS",
        60_000,
      ),
      failureThreshold: integer(
        byKey,
        "worker.provider_circuit_failure_threshold",
        "PROVIDER_CIRCUIT_FAILURE_THRESHOLD",
        5,
      ),
      probeLeaseMs: integer(
        byKey,
        "worker.provider_circuit_probe_lease_ms",
        "PROVIDER_CIRCUIT_PROBE_LEASE_MS",
        120_000,
      ),
    },
    concurrency: integer(
      byKey,
      "worker.generation_concurrency",
      "GENERATION_WORKER_CONCURRENCY",
      4,
    ),
    heartbeatIntervalMs: integer(
      byKey,
      "worker.generation_heartbeat_interval_ms",
      "GENERATION_HEARTBEAT_INTERVAL_MS",
      15_000,
    ),
    leaseDurationMs: integer(
      byKey,
      "worker.generation_lease_duration_ms",
      "GENERATION_LEASE_DURATION_MS",
      120_000,
    ),
    rateLimit: integer(byKey, "worker.generation_rate_limit", "GENERATION_WORKER_RATE_LIMIT", 10),
    reconcileIntervalMs: integer(
      byKey,
      "worker.generation_reconcile_interval_ms",
      "GENERATION_RECONCILE_INTERVAL_MS",
      60_000,
    ),
  };
  if (generation.heartbeatIntervalMs >= generation.leaseDurationMs / 2) {
    throw new Error("Generation heartbeat interval must be less than half the lease duration");
  }
  return {
    contentSafety:
      options.contentSafety === false
        ? { mode: "DISABLED", verified: false }
        : await contentSafetySettings(byKey, prisma),
    generation,
    material: {
      concurrency: integer(
        byKey,
        "worker.material_ingestion_concurrency",
        "MATERIAL_INGESTION_CONCURRENCY",
        2,
      ),
      reconcileIntervalMs: integer(
        byKey,
        "worker.material_reconcile_interval_ms",
        "MATERIAL_INGESTION_RECONCILE_INTERVAL_MS",
        30_000,
      ),
    },
    storage: storageSettings(byKey),
  };
}

function storageSettings(
  rows: ReadonlyMap<string, PlatformSetting>,
): ConfiguredObjectStorageOptions {
  const provider =
    rows.get("storage.provider")?.value ?? (process.env.OBJECT_STORAGE_PROVIDER || "S3");
  if (provider === "LOCAL") return { provider, ...localStorageOptionsFromEnvironment() };
  if (provider !== "S3") throw new Error("Platform setting storage.provider is invalid");
  const byKey = rows;
  return {
    provider,
    accessKeyId: secret(byKey, "storage.access_key_id", "OBJECT_STORAGE_ACCESS_KEY"),
    bucket: requiredText(byKey, "storage.bucket", "OBJECT_STORAGE_BUCKET"),
    endpoint: optionalText(byKey, "storage.endpoint", process.env.OBJECT_STORAGE_ENDPOINT),
    forcePathStyle: booleanValue(
      byKey,
      "storage.force_path_style",
      process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== "false",
    ),
    region: requiredText(byKey, "storage.region", "OBJECT_STORAGE_REGION"),
    secretAccessKey: secret(byKey, "storage.secret_access_key", "OBJECT_STORAGE_SECRET_KEY"),
  };
}

async function contentSafetySettings(
  rows: ReadonlyMap<string, PlatformSetting>,
  prisma: PrismaClient,
): Promise<WorkerPlatformSettings["contentSafety"]> {
  const rawMode =
    rows.get("content_safety.mode")?.value ?? process.env.CONTENT_SAFETY_MODE ?? "DISABLED";
  if (rawMode === "DISABLED") return { mode: "DISABLED", verified: false };
  if (rawMode !== "HTTP" && rawMode !== "MODEL")
    throw new Error("Platform setting content_safety.mode is invalid");
  let configuration: ContentSafetyConfiguration;
  if (rawMode === "MODEL") {
    const providerId = requiredText(
      rows,
      "content_safety.model_provider_id",
      "CONTENT_SAFETY_MODEL_PROVIDER_ID",
    );
    const provider = await prisma.modelProvider.findUnique({
      where: { id: providerId },
      include: { activeCredential: true },
    });
    if (
      provider?.status !== "ACTIVE" ||
      provider.synthetic ||
      provider.protocol !== "OPENAI_COMPATIBLE" ||
      provider.activeCredential?.status !== "ACTIVE"
    )
      throw new Error("Content-safety model provider is unavailable");
    configuration = {
      mode: "MODEL",
      apiKey: ModelCredentialCipher.fromEnvironment().decrypt(
        provider.activeCredential,
        modelCredentialAssociatedData(provider.id, provider.activeCredential.id),
      ),
      endpoint: provider.baseUrl,
      provider: provider.code,
      model: requiredText(rows, "content_safety.model", "CONTENT_SAFETY_MODEL"),
      timeoutMs: integer(rows, "content_safety.timeout_ms", "CONTENT_SAFETY_TIMEOUT_MS", 30000),
    };
  } else
    configuration = {
      apiKey: optionalSecret(rows, "content_safety.api_key", "CONTENT_SAFETY_API_KEY"),
      endpoint: requiredText(rows, "content_safety.endpoint", "CONTENT_SAFETY_ENDPOINT"),
      mode: "HTTP",
      provider: requiredText(rows, "content_safety.provider", "CONTENT_SAFETY_PROVIDER"),
      timeoutMs: integer(rows, "content_safety.timeout_ms", "CONTENT_SAFETY_TIMEOUT_MS", 30_000),
    };
  const fingerprint = contentSafetyFingerprint(configuration);
  const receipt = await prisma.auditLog.findFirst({
    where: {
      action: "platform-setting.content-safety-test",
      resourceId: "content-safety",
      metadata: { path: ["configurationFingerprint"], equals: fingerprint },
    },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const verified = Boolean(
    receipt?.metadata &&
      typeof receipt.metadata === "object" &&
      !Array.isArray(receipt.metadata) &&
      receipt.metadata.success === true,
  );
  return { ...configuration, verified };
}

function integer(
  rows: ReadonlyMap<string, PlatformSetting>,
  key: string,
  environmentVariable: string,
  fallback: number,
): number {
  const value = rows.get(key)?.value ?? process.env[environmentVariable] ?? fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Platform setting ${key} must be a positive integer`);
  }
  return parsed;
}

function requiredText(
  rows: ReadonlyMap<string, PlatformSetting>,
  key: string,
  environmentVariable: string,
): string {
  const value = rows.get(key)?.value ?? process.env[environmentVariable];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Platform setting ${key} must be a non-empty string`);
  }
  return value;
}

function optionalText(
  rows: ReadonlyMap<string, PlatformSetting>,
  key: string,
  fallback: string | undefined,
): string | undefined {
  const value = rows.get(key)?.value ?? fallback;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(
  rows: ReadonlyMap<string, PlatformSetting>,
  key: string,
  fallback: boolean,
): boolean {
  const value = rows.get(key)?.value ?? fallback;
  if (typeof value !== "boolean") throw new Error(`Platform setting ${key} must be boolean`);
  return value;
}

function secret(
  rows: ReadonlyMap<string, PlatformSetting>,
  key: string,
  environmentVariable: string,
): string {
  const row = rows.get(key);
  if (!row) return requiredEnv(environmentVariable);
  if (!row.authenticationTag || !row.ciphertext || !row.initializationVector || !row.keyVersion) {
    throw new Error(`Platform setting secret ${key} is incomplete`);
  }
  return ModelCredentialCipher.fromEnvironment().decrypt(
    {
      authenticationTag: row.authenticationTag,
      ciphertext: row.ciphertext,
      initializationVector: row.initializationVector,
      keyVersion: row.keyVersion,
    },
    `xhs-agentic:platform-setting:${key}`,
  );
}

function optionalSecret(
  rows: ReadonlyMap<string, PlatformSetting>,
  key: string,
  environmentVariable: string,
): string {
  const row = rows.get(key);
  if (!row) return requiredEnv(environmentVariable);
  if (!row.authenticationTag || !row.ciphertext || !row.initializationVector || !row.keyVersion) {
    throw new Error(`Platform setting secret ${key} is incomplete`);
  }
  return ModelCredentialCipher.fromEnvironment().decrypt(
    {
      authenticationTag: row.authenticationTag,
      ciphertext: row.ciphertext,
      initializationVector: row.initializationVector,
      keyVersion: row.keyVersion,
    },
    `xhs-agentic:platform-setting:${key}`,
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
