import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  type ConfiguredObjectStorageOptions,
  createObjectStorage,
  type LocalObjectStorage,
  localStorageOptionsFromEnvironment,
  type S3CompatibleObjectStorage,
} from "@xhs-agentic/object-storage";
import { PlatformSettingsReader } from "./platform-settings.reader";

type CachedStorage = Readonly<{
  expiresAt: number;
  fingerprint: string;
  provider: "LOCAL" | "S3";
  signedUrlTtlSeconds: number;
  storage: LocalObjectStorage | S3CompatibleObjectStorage;
}>;

@Injectable()
export class PlatformObjectStorageService {
  private cached?: CachedStorage;

  constructor(@Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader) {}

  async current(): Promise<
    Readonly<{
      provider: "LOCAL" | "S3";
      signedUrlTtlSeconds: number;
      storage: LocalObjectStorage | S3CompatibleObjectStorage;
    }>
  > {
    const resolved = await this.settings.resolveMany([
      "storage.provider",
      "storage.signed_url_ttl_seconds",
    ]);
    const provider = resolved.get("storage.provider")?.value ?? "S3";
    if (provider !== "LOCAL" && provider !== "S3") throw missing("Provider");
    let options: ConfiguredObjectStorageOptions;
    if (provider === "LOCAL") {
      options = { ...localStorageOptionsFromEnvironment(), provider };
    } else {
      const resolved = await this.settings.resolveMany([
        "storage.access_key_id",
        "storage.bucket",
        "storage.endpoint",
        "storage.force_path_style",
        "storage.region",
        "storage.secret_access_key",
      ]);
      options = {
        provider,
        accessKeyId: requiredString(resolved.get("storage.access_key_id")?.value, "Access Key ID"),
        bucket: requiredString(resolved.get("storage.bucket")?.value, "Bucket"),
        endpoint: optionalString(resolved.get("storage.endpoint")?.value),
        forcePathStyle: requiredBoolean(
          resolved.get("storage.force_path_style")?.value,
          "Force Path Style",
        ),
        region: requiredString(resolved.get("storage.region")?.value, "Region"),
        secretAccessKey: requiredString(
          resolved.get("storage.secret_access_key")?.value,
          "Secret Access Key",
        ),
      };
    }
    const signedUrlTtlSeconds = requiredNumber(
      resolved.get("storage.signed_url_ttl_seconds")?.value,
      "Signed URL TTL",
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ ...options, signedUrlTtlSeconds }))
      .digest("hex");
    if (
      this.cached &&
      this.cached.expiresAt > Date.now() &&
      this.cached.fingerprint === fingerprint
    ) {
      return this.cached;
    }
    this.cached = {
      expiresAt: Date.now() + 3_000,
      fingerprint,
      provider,
      signedUrlTtlSeconds,
      storage: createObjectStorage(options),
    };
    return this.cached;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

export function storageReadUrl(signedUrl: string): string {
  if (!signedUrl.startsWith("/api/storage/objects/")) return signedUrl;
  if (!/^\/api\/storage\/objects\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(signedUrl))
    throw new Error("Invalid local object URL");
  const port = process.env.API_PORT || "3100";
  if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("Invalid internal API port");
  return `http://127.0.0.1:${port}${signedUrl.slice(4)}`;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw missing(label);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw missing(label);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number") throw missing(label);
  return value;
}

function missing(label: string): ConflictException {
  return new ConflictException({
    code: "OBJECT_STORAGE_SETTING_MISSING",
    message: `Object storage ${label} is not configured`,
  });
}
