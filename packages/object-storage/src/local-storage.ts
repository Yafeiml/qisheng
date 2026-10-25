import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ObjectStorage,
  PutObjectRequest,
  SignedPutObjectRequest,
  StoredObject,
  StoredObjectMetadata,
} from "./types";

export const MAX_LOCAL_OBJECT_BYTES = 26_214_400;
const MAX_HEADER_BYTES = 4096;
const LOCAL_OBJECT_PATH = "/api/storage/objects/";

export type LocalObjectStorageOptions = Readonly<{
  rootDirectory: string;
  signingKey: string;
}>;

export type LocalSignedRequest =
  | Readonly<{ key: string; method: "GET" }>
  | Readonly<SignedPutObjectRequest & { method: "PUT" }>;

type ObjectHeader = Readonly<{
  byteSize: number;
  checksum: string;
  key: string;
  mimeType: string;
  version: 1;
}>;

export function localStorageOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): LocalObjectStorageOptions {
  const secret = environment.ADMIN_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Local storage requires ADMIN_JWT_SECRET with at least 32 characters");
  }
  return {
    rootDirectory: environment.OBJECT_STORAGE_LOCAL_ROOT || "/var/lib/qisheng/storage",
    signingKey: createHmac("sha256", secret)
      .update("qisheng-local-object-storage-v1")
      .digest("hex"),
  };
}

export class LocalObjectStorage implements ObjectStorage {
  private readonly root: string;
  private readonly audience: string;
  private readonly signingKey: string;

  constructor(options: LocalObjectStorageOptions) {
    if (!isAbsolute(options.rootDirectory)) {
      throw new Error("Local storage root must be an absolute directory");
    }
    if (options.signingKey.length < 32) {
      throw new Error("Local storage signing key must contain at least 32 characters");
    }
    this.root = resolve(options.rootDirectory);
    this.audience = createHash("sha256").update(this.root).digest("hex");
    this.signingKey = options.signingKey;
  }

  async ensureBucket(_createWhenMissing = false): Promise<void> {
    let existingParent = this.root;
    for (;;) {
      try {
        await assertDirectory(existingParent);
        break;
      } catch (error) {
        if (!missingFile(error) || dirname(existingParent) === existingParent) throw error;
        existingParent = dirname(existingParent);
      }
    }
    await mkdir(this.root, { mode: 0o700, recursive: true });
    await this.assertRoot();
    const probe = join(this.root, `.probe-${randomUUID()}`);
    const handle = await open(probe, "wx+", 0o600);
    try {
      await handle.writeFile("storage-readiness");
      await handle.sync();
      const bytes = Buffer.alloc(17);
      await readExactly(handle, bytes, 0);
      if (bytes.toString() !== "storage-readiness")
        throw new Error("Local storage readback failed");
    } finally {
      await handle.close();
      await unlink(probe);
    }
  }

  async put(request: PutObjectRequest): Promise<StoredObject> {
    assertKey(request.key);
    assertByteSize(request.bytes.byteLength);
    assertMimeType(request.mimeType);
    const checksum = createHash("sha256").update(request.bytes).digest("hex");
    if (checksum !== request.checksum) throw new Error("Object checksum mismatch");
    await this.assertRoot();
    const header: ObjectHeader = {
      byteSize: request.bytes.byteLength,
      checksum,
      key: request.key,
      mimeType: request.mimeType,
      version: 1,
    };
    const encoded = Buffer.from(JSON.stringify(header));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(encoded.byteLength);
    const temporary = join(this.root, `.upload-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(Buffer.concat([length, encoded, request.bytes]));
      await handle.sync();
      await handle.close();
      await this.assertRoot();
      await rename(temporary, this.objectPath(request.key));
    } finally {
      await handle.close();
      await unlink(temporary).catch((error: unknown) => {
        if (!missingFile(error)) throw error;
      });
    }
    return { byteSize: header.byteSize, checksum, etag: checksum, key: request.key };
  }

  async head(key: string): Promise<StoredObjectMetadata> {
    const { handle, header } = await this.readHeader(key);
    await handle.close();
    return {
      byteSize: header.byteSize,
      checksum: header.checksum,
      contentType: header.mimeType,
      etag: header.checksum,
      key,
    };
  }

  async get(key: string, maxBytes = MAX_LOCAL_OBJECT_BYTES): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid read limit");
    const { handle, header, offset } = await this.readHeader(key);
    try {
      if (header.byteSize > maxBytes) throw new Error("Object exceeds the permitted read size");
      const bytes = Buffer.alloc(header.byteSize);
      await readExactly(handle, bytes, offset);
      if (createHash("sha256").update(bytes).digest("hex") !== header.checksum) {
        throw new Error("Stored object checksum mismatch");
      }
      return new Uint8Array(bytes);
    } finally {
      await handle.close();
    }
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.assertRoot();
    const path = this.objectPath(key);
    try {
      assertRegularFile(await lstat(path));
      await unlink(path);
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
  }

  async signedGetUrl(key: string, expiresInSeconds = 900): Promise<string> {
    assertKey(key);
    return this.signedUrl({ key, method: "GET" }, expiresInSeconds);
  }

  async signedPutUrl(request: SignedPutObjectRequest, expiresInSeconds = 900): Promise<string> {
    assertKey(request.key);
    assertByteSize(request.byteSize);
    assertMimeType(request.mimeType);
    return this.signedUrl({ ...request, method: "PUT" }, expiresInSeconds);
  }

  verifySignedRequest(token: string, method: "GET" | "PUT"): LocalSignedRequest {
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra || token.length > 4096) throw invalidRequest();
    const expected = Buffer.from(this.sign(encoded));
    const supplied = Buffer.from(signature);
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw invalidRequest();
    }
    try {
      const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      const now = Math.floor(Date.now() / 1000);
      if (
        value.version !== 1 ||
        value.audience !== this.audience ||
        value.method !== method ||
        !Number.isSafeInteger(value.exp) ||
        value.exp <= now ||
        value.exp > now + 3600
      ) {
        throw invalidRequest();
      }
      assertKey(value.key);
      if (method === "GET") return { key: value.key, method };
      assertByteSize(value.byteSize);
      assertMimeType(value.mimeType);
      return { byteSize: value.byteSize, key: value.key, method, mimeType: value.mimeType };
    } catch {
      throw invalidRequest();
    }
  }

  private signedUrl(request: LocalSignedRequest, expiresInSeconds: number): string {
    if (
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 60 ||
      expiresInSeconds > 3600
    ) {
      throw new Error("Signed object URL expiry must be between 60 and 3600 seconds");
    }
    const encoded = Buffer.from(
      JSON.stringify({
        ...request,
        audience: this.audience,
        exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
        version: 1,
      }),
    ).toString("base64url");
    return `${LOCAL_OBJECT_PATH}${encoded}.${this.sign(encoded)}`;
  }

  private sign(encoded: string): string {
    return createHmac("sha256", this.signingKey).update(encoded).digest("base64url");
  }

  private objectPath(key: string): string {
    return join(this.root, `${createHash("sha256").update(key).digest("hex")}.object`);
  }

  private async assertRoot(): Promise<void> {
    await assertDirectory(this.root);
  }

  private async readHeader(key: string) {
    assertKey(key);
    await this.assertRoot();
    const path = this.objectPath(key);
    assertRegularFile(await lstat(path));
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      assertRegularFile(stat);
      const length = Buffer.alloc(4);
      await readExactly(handle, length, 0);
      const headerLength = length.readUInt32BE();
      if (headerLength < 1 || headerLength > MAX_HEADER_BYTES)
        throw new Error("Invalid object header");
      const encoded = Buffer.alloc(headerLength);
      await readExactly(handle, encoded, 4);
      const header = JSON.parse(encoded.toString("utf8")) as ObjectHeader;
      assertByteSize(header.byteSize);
      assertMimeType(header.mimeType);
      if (
        header.version !== 1 ||
        header.key !== key ||
        !/^[a-f0-9]{64}$/u.test(header.checksum) ||
        stat.size !== 4 + headerLength + header.byteSize
      ) {
        throw new Error("Invalid object metadata");
      }
      return { handle, header, offset: 4 + headerLength };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}

async function assertDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  const canonical = await realpath(path);
  const comparable = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (!stat.isDirectory() || stat.isSymbolicLink() || comparable(canonical) !== comparable(path)) {
    throw new Error("Local storage root must be a real directory without symbolic links");
  }
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      position + offset,
    );
    if (bytesRead === 0) throw new Error("Stored object is incomplete");
    offset += bytesRead;
  }
}

function assertKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.length > 1000 ||
    key.includes("..") ||
    !key.split("/").every((segment) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(segment))
  ) {
    throw new Error("Object key contains unsupported characters");
  }
}

function assertByteSize(byteSize: number): void {
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_LOCAL_OBJECT_BYTES) {
    throw new Error(`Object byte size must be between 1 and ${MAX_LOCAL_OBJECT_BYTES}`);
  }
}

function assertMimeType(mimeType: string): void {
  if (
    typeof mimeType !== "string" ||
    mimeType.length > 255 ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(mimeType)
  ) {
    throw new Error("Object MIME type is invalid");
  }
}

function assertRegularFile(stat: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  nlink: number;
}): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("Local object must be a regular private file");
  }
}

function missingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function invalidRequest(): Error {
  return new Error("Local object request is invalid or expired");
}
