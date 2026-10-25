import { createHmac, timingSafeEqual } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PlatformObjectStorageService } from "./platform-object-storage.service";
import { PlatformSettingsReader } from "./platform-settings.reader";
import { isProductionCredential } from "./production-secret";

const MAX_DELIVERY_BYTES = 26_214_400;
const TOKEN_VERSION = 1;

type AssetTokenPayload = Readonly<{
  exp: number;
  key: string;
  v: number;
}>;

@Injectable()
export class PlatformAssetDeliveryService {
  constructor(
    @Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader,
    @Inject(PlatformObjectStorageService)
    private readonly objectStorage: PlatformObjectStorageService,
  ) {}

  async signedUrl(key: string): Promise<string> {
    assertDeliverableKey(key);
    const { provider, signedUrlTtlSeconds, storage } = await this.objectStorage.current();
    if (provider === "LOCAL") return storage.signedGetUrl(key, signedUrlTtlSeconds);
    const mode = await this.settings.string("storage.delivery_mode");
    if (mode === "S3_SIGNED") {
      return storage.signedGetUrl(key, signedUrlTtlSeconds);
    }
    if (mode !== "EDGE_SIGNED") throw new Error("Asset delivery mode is invalid");
    const [baseUrl, signingKey] = await Promise.all([
      this.settings.string("storage.delivery_base_url"),
      this.settings.string("storage.delivery_signing_key"),
    ]);
    if (
      !baseUrl ||
      (process.env.NODE_ENV === "production"
        ? !isProductionCredential(signingKey, 32)
        : signingKey.length < 32)
    ) {
      throw new Error("Edge asset delivery is not fully configured");
    }
    const payload: AssetTokenPayload = {
      exp: Math.floor(Date.now() / 1000) + signedUrlTtlSeconds,
      key,
      v: TOKEN_VERSION,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = sign(encoded, signingKey);
    return `${baseUrl.replace(/\/+$/u, "")}/assets/${encoded}.${signature}`;
  }

  async read(token: string) {
    const [encoded, suppliedSignature, extra] = token.split(".");
    if (!encoded || !suppliedSignature || extra || token.length > 4096) throw hiddenNotFound();
    let signingKey: string;
    try {
      const mode = await this.settings.string("storage.delivery_mode");
      if (mode !== "EDGE_SIGNED") throw new Error("Edge delivery is disabled");
      signingKey = await this.settings.string("storage.delivery_signing_key");
    } catch {
      throw hiddenNotFound();
    }
    if (
      (process.env.NODE_ENV === "production"
        ? !isProductionCredential(signingKey, 32)
        : signingKey.length < 32) ||
      !safeEqual(suppliedSignature, sign(encoded, signingKey))
    ) {
      throw hiddenNotFound();
    }
    const payload = parsePayload(encoded);
    const now = Math.floor(Date.now() / 1000);
    if (payload.v !== TOKEN_VERSION || payload.exp <= now || payload.exp > now + 3600) {
      throw hiddenNotFound();
    }
    assertDeliverableKey(payload.key);
    const { storage } = await this.objectStorage.current();
    try {
      const metadata = await storage.head(payload.key);
      const bytes = await storage.get(payload.key, MAX_DELIVERY_BYTES);
      return {
        byteSize: bytes.byteLength,
        bytes,
        cacheSeconds: Math.max(1, payload.exp - now),
        contentType: safeContentType(metadata.contentType),
        etag: metadata.etag,
      };
    } catch {
      throw hiddenNotFound();
    }
  }
}

function parsePayload(encoded: string): AssetTokenPayload {
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (
      typeof record.exp !== "number" ||
      !Number.isSafeInteger(record.exp) ||
      typeof record.key !== "string" ||
      typeof record.v !== "number"
    ) {
      throw new Error();
    }
    return { exp: record.exp, key: record.key, v: record.v };
  } catch {
    throw hiddenNotFound();
  }
}

function assertDeliverableKey(key: string): void {
  if (
    !key.startsWith("tenants/") ||
    key.includes("..") ||
    key.includes("\\") ||
    key.length > 1000
  ) {
    throw hiddenNotFound();
  }
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function safeContentType(value: string | undefined): string {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/csv",
    "text/plain",
  ]).has(normalized ?? "")
    ? (normalized as string)
    : "application/octet-stream";
}

function hiddenNotFound(): NotFoundException {
  return new NotFoundException("Asset was not found");
}
