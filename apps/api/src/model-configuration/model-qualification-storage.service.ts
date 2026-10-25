import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  PlatformObjectStorageService,
  storageReadUrl,
} from "../platform-settings/platform-object-storage.service";

@Injectable()
export class ModelQualificationStorageService {
  constructor(
    @Inject(PlatformObjectStorageService)
    private readonly objectStorage: PlatformObjectStorageService,
  ) {}

  async verifyImageRoundTrip(
    qualificationId: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<Readonly<{ byteSize: number; checksum: string }>> {
    const normalizedMimeType = supportedImageMimeType(mimeType);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const key = `runtime-qualification/${safeSegment(qualificationId)}/${checksum}.${extension(normalizedMimeType)}`;
    const { storage } = await this.objectStorage.current();
    await storage.ensureBucket(false);
    try {
      const stored = await storage.put({ bytes, checksum, key, mimeType: normalizedMimeType });
      const signedUrl = await storage.signedGetUrl(key, 60);
      const response = await fetch(storageReadUrl(signedUrl), {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error(`Object storage signed read returned HTTP ${response.status}`);
      const downloaded = new Uint8Array(await response.arrayBuffer());
      const downloadedChecksum = createHash("sha256").update(downloaded).digest("hex");
      if (downloadedChecksum !== checksum) {
        throw new Error("Object storage round-trip checksum did not match");
      }
      return { byteSize: stored.byteSize, checksum };
    } finally {
      await storage.delete(key).catch(() => undefined);
    }
  }
}

function supportedImageMimeType(value: string): "image/jpeg" | "image/png" | "image/webp" {
  if (value === "image/jpeg" || value === "image/png" || value === "image/webp") return value;
  throw new Error(`Qualification image returned unsupported MIME type: ${value}`);
}

function extension(value: "image/jpeg" | "image/png" | "image/webp"): string {
  if (value === "image/jpeg") return "jpg";
  if (value === "image/webp") return "webp";
  return "png";
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("Qualification identifier contains unsupported object-key characters");
  }
  return value;
}
