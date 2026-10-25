import { createHash } from "node:crypto";
import type {
  ObjectStorage,
  PutObjectRequest,
  SignedPutObjectRequest,
  StoredObject,
  StoredObjectMetadata,
} from "./types";

export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, PutObjectRequest>();

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async put(request: PutObjectRequest): Promise<StoredObject> {
    const checksum = createHash("sha256").update(request.bytes).digest("hex");
    if (checksum !== request.checksum) throw new Error("Object checksum mismatch");
    this.objects.set(request.key, { ...request, bytes: new Uint8Array(request.bytes) });
    return {
      byteSize: request.bytes.byteLength,
      checksum,
      etag: checksum,
      key: request.key,
    };
  }

  async head(key: string): Promise<StoredObjectMetadata> {
    const value = this.objects.get(key);
    if (!value) throw new Error("Object does not exist");
    return {
      byteSize: value.bytes.byteLength,
      checksum: value.checksum,
      contentType: value.mimeType,
      etag: value.checksum,
      key,
    };
  }

  async signedGetUrl(key: string, expiresInSeconds = 900): Promise<string> {
    if (!this.objects.has(key)) throw new Error("Object does not exist");
    return `memory://object/${encodeURIComponent(key)}?expires=${expiresInSeconds}`;
  }

  async signedPutUrl(request: SignedPutObjectRequest, expiresInSeconds = 900): Promise<string> {
    return `memory://upload/${encodeURIComponent(request.key)}?bytes=${request.byteSize}&expires=${expiresInSeconds}`;
  }

  async get(key: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
    const value = this.objects.get(key);
    if (!value) throw new Error("Object does not exist");
    if (value.bytes.byteLength > maxBytes)
      throw new Error("Object exceeds the permitted read size");
    return new Uint8Array(value.bytes);
  }
}
