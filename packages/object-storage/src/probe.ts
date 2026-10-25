import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LocalObjectStorage, localStorageOptionsFromEnvironment } from "./local-storage";
import { generatedImageObjectKey } from "./object-key";
import { S3CompatibleObjectStorage } from "./s3-compatible-storage";

const envPath = resolve(__dirname, "../../../.env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

async function run(): Promise<void> {
  if (process.env.OBJECT_STORAGE_PROVIDER === "LOCAL") {
    await runLocalProbe();
    return;
  }
  if (process.env.OBJECT_STORAGE_PROVIDER && process.env.OBJECT_STORAGE_PROVIDER !== "S3") {
    throw new Error("Object storage provider must be LOCAL or S3");
  }
  const storage = new S3CompatibleObjectStorage({
    accessKeyId: requiredEnv("OBJECT_STORAGE_ACCESS_KEY"),
    bucket: requiredEnv("OBJECT_STORAGE_BUCKET"),
    endpoint: requiredEnv("OBJECT_STORAGE_ENDPOINT"),
    forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== "false",
    region: requiredEnv("OBJECT_STORAGE_REGION"),
    secretAccessKey: requiredEnv("OBJECT_STORAGE_SECRET_KEY"),
  });
  await storage.ensureBucket(process.env.NODE_ENV !== "production");
  const lifecycle =
    process.env.NODE_ENV === "production"
      ? await storage.lifecycleState()
      : await storage.applyLifecyclePolicy({
          abortIncompleteMultipartUploadDays: 1,
          noncurrentVersionExpirationDays: 30,
        });
  if (!lifecycle.enabled || lifecycle.versioning !== "ENABLED") {
    throw new Error("Object storage versioning and lifecycle governance are not enabled");
  }
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const key = generatedImageObjectKey({
    campaignId: "infrastructure-probe",
    checksum,
    employeeContentId: "object-storage",
    mimeType: "image/png",
    sequence: 1,
    tenantId: "development",
  });
  const stored = await storage.put({ bytes, checksum, key, mimeType: "image/png" });
  let signedUrl: string;
  try {
    signedUrl = await storage.signedGetUrl(key, 60);
  } finally {
    await storage.delete(key);
  }
  process.stdout.write(
    `${JSON.stringify({ bucket: requiredEnv("OBJECT_STORAGE_BUCKET"), byteSize: stored.byteSize, lifecycle, signedUrl: signedUrl.startsWith("http") ? "ok" : "invalid" })}\n`,
  );
}

async function runLocalProbe(): Promise<void> {
  const storage = new LocalObjectStorage(localStorageOptionsFromEnvironment());
  await storage.ensureBucket();
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const key = generatedImageObjectKey({
    campaignId: "infrastructure-probe",
    checksum,
    employeeContentId: "object-storage",
    mimeType: "image/png",
    sequence: 1,
    tenantId: "development",
  });
  try {
    await storage.put({ bytes, checksum, key, mimeType: "image/png" });
    const metadata = await storage.head(key);
    const downloaded = await storage.get(key, bytes.byteLength);
    if (
      metadata.checksum !== checksum ||
      createHash("sha256").update(downloaded).digest("hex") !== checksum
    ) {
      throw new Error("Object storage probe checksum mismatch");
    }
    const url = await storage.signedGetUrl(key, 60);
    if (storage.verifySignedRequest(url.split("/").at(-1) ?? "", "GET").key !== key) {
      throw new Error("Object storage probe signed request mismatch");
    }
    process.stdout.write(
      `${JSON.stringify({ provider: "LOCAL", byteSize: bytes.byteLength, checksumVerified: true, signedRequestVerified: true })}\n`,
    );
  } finally {
    await storage.delete(key);
  }
}

function requiredEnv(
  name:
    | "OBJECT_STORAGE_ACCESS_KEY"
    | "OBJECT_STORAGE_BUCKET"
    | "OBJECT_STORAGE_ENDPOINT"
    | "OBJECT_STORAGE_REGION"
    | "OBJECT_STORAGE_SECRET_KEY",
): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `${process.env.OBJECT_STORAGE_PROVIDER !== "LOCAL" && error instanceof Error ? error.message : "Object storage probe failed"}\n`,
  );
  process.exitCode = 1;
});
