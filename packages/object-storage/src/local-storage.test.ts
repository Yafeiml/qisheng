import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createObjectStorage } from "./create-object-storage";
import {
  LocalObjectStorage,
  localStorageOptionsFromEnvironment,
  MAX_LOCAL_OBJECT_BYTES,
} from "./local-storage";
import { S3CompatibleObjectStorage } from "./s3-compatible-storage";

const signingKey = "independent-local-storage-signing-key-32-characters";
const key = "tenants/tenant_1/materials/material_1/artifact_1.txt";
const bytes = new Uint8Array([1, 2, 3]);
const checksum = createHash("sha256").update(bytes).digest("hex");
const tokenOf = (url: string) => url.slice("/api/storage/objects/".length);

describe("private local object storage", () => {
  let directory: string;
  let storage: LocalObjectStorage;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "qisheng-local-storage-"));
    storage = new LocalObjectStorage({ rootDirectory: directory, signingKey });
    await storage.ensureBucket(false);
  });
  afterEach(async () => {
    vi.useRealTimers();
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(directory).toContain("qisheng-local-storage-");
    await rm(directory, { force: true, recursive: true });
  });

  it("persists metadata and bytes across instances and deletes without leftovers", async () => {
    await expect(storage.put({ key, bytes, checksum, mimeType: "text/plain" })).resolves.toEqual({
      byteSize: 3,
      checksum,
      etag: checksum,
      key,
    });
    const reopened = new LocalObjectStorage({ rootDirectory: directory, signingKey });
    await expect(reopened.head(key)).resolves.toEqual({
      byteSize: 3,
      checksum,
      contentType: "text/plain",
      etag: checksum,
      key,
    });
    await expect(reopened.get(key, 3)).resolves.toEqual(bytes);
    await expect(reopened.get(key, 2)).rejects.toThrow("permitted read size");
    const files = await readdir(directory);
    expect(files).toEqual([`${createHash("sha256").update(key).digest("hex")}.object`]);
    if (process.platform !== "win32") {
      expect((await lstat(join(directory, files[0] ?? "missing"))).mode & 0o777).toBe(0o600);
    }
    await reopened.delete(key);
    await reopened.delete(key);
    expect(await readdir(directory)).toEqual([]);
    await expect(reopened.get(key)).rejects.toThrow();
  });

  it("keeps the existing object when a replacement checksum is wrong", async () => {
    await storage.put({ key, bytes, checksum, mimeType: "text/plain" });
    await expect(
      storage.put({ key, bytes: new Uint8Array([9]), checksum, mimeType: "text/plain" }),
    ).rejects.toThrow("checksum mismatch");
    await expect(storage.get(key)).resolves.toEqual(bytes);
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("atomically replaces a complete object", async () => {
    const replacement = new Uint8Array([4, 5, 6, 7]);
    await storage.put({ key, bytes, checksum, mimeType: "text/plain" });
    await storage.put({
      key,
      bytes: replacement,
      checksum: createHash("sha256").update(replacement).digest("hex"),
      mimeType: "application/pdf",
    });
    await expect(storage.get(key)).resolves.toEqual(replacement);
    await expect(storage.head(key)).resolves.toMatchObject({
      byteSize: 4,
      contentType: "application/pdf",
    });
    expect(await readdir(directory)).toHaveLength(1);
  });

  it.each([
    "",
    "../secret",
    "tenants/../../secret",
    "/absolute",
    "C:\\secret",
    "a//b",
    "a/%2e%2e/b",
    "a\u0000b",
  ])("rejects unsafe key %j at file and signing entry points", async (unsafe) => {
    await expect(storage.get(unsafe)).rejects.toThrow("unsupported characters");
    await expect(storage.delete(unsafe)).rejects.toThrow("unsupported characters");
    await expect(
      storage.put({ key: unsafe, bytes, checksum, mimeType: "text/plain" }),
    ).rejects.toThrow("unsupported characters");
    await expect(storage.signedGetUrl(unsafe)).rejects.toThrow("unsupported characters");
    expect(await readdir(directory)).toEqual([]);
  });

  it("issues relative signed URLs bound to method, expiry, upload length and MIME", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
    const getUrl = await storage.signedGetUrl(key, 60);
    const putUrl = await storage.signedPutUrl({ key, byteSize: 3, mimeType: "image/png" }, 60);
    expect(getUrl.startsWith("/api/storage/objects/")).toBe(true);
    expect(getUrl).not.toContain(directory);
    expect(storage.verifySignedRequest(tokenOf(getUrl), "GET")).toEqual({ key, method: "GET" });
    expect(storage.verifySignedRequest(tokenOf(putUrl), "PUT")).toEqual({
      key,
      method: "PUT",
      byteSize: 3,
      mimeType: "image/png",
    });
    expect(() => storage.verifySignedRequest(tokenOf(getUrl), "PUT")).toThrow("invalid or expired");
    expect(() => storage.verifySignedRequest(tokenOf(putUrl), "GET")).toThrow("invalid or expired");
    vi.setSystemTime(new Date("2026-10-24T12:01:00Z"));
    expect(() => storage.verifySignedRequest(tokenOf(getUrl), "GET")).toThrow("invalid or expired");
    expect(() => storage.verifySignedRequest(tokenOf(putUrl), "PUT")).toThrow("invalid or expired");
  });

  it("rejects token tampering, another signing key, another root and malformed tokens", async () => {
    const token = tokenOf(await storage.signedPutUrl({ key, byteSize: 3, mimeType: "text/plain" }));
    const [encoded = "", signature = ""] = token.split(".");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
    payload.byteSize = 999;
    const changed = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(() => storage.verifySignedRequest(`${changed}.${signature}`, "PUT")).toThrow();
    payload.byteSize = 3;
    payload.mimeType = "image/png";
    expect(() =>
      storage.verifySignedRequest(
        `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`,
        "PUT",
      ),
    ).toThrow();
    const otherKey = new LocalObjectStorage({
      rootDirectory: directory,
      signingKey: "x".repeat(32),
    });
    const otherRoot = new LocalObjectStorage({
      rootDirectory: join(directory, "other"),
      signingKey,
    });
    expect(() => otherKey.verifySignedRequest(token, "PUT")).toThrow();
    expect(() => otherRoot.verifySignedRequest(token, "PUT")).toThrow();
    for (const invalid of ["", "abc", ".signature", `${token}.extra`, "a".repeat(4097)]) {
      expect(() => storage.verifySignedRequest(invalid, "GET")).toThrow();
    }
  });

  it("rejects oversized uploads, invalid MIME and unsupported expiry", async () => {
    for (const byteSize of [0, -1, 1.5, MAX_LOCAL_OBJECT_BYTES + 1]) {
      await expect(storage.signedPutUrl({ key, byteSize, mimeType: "text/plain" })).rejects.toThrow(
        "byte size",
      );
    }
    await expect(
      storage.signedPutUrl({ key, byteSize: 3, mimeType: "text/plain\r\nX-Injected: yes" }),
    ).rejects.toThrow("MIME");
    for (const expiry of [0, 59, 3601, 60.5]) {
      await expect(storage.signedGetUrl(key, expiry)).rejects.toThrow("expiry");
    }
  });

  it("detects truncated files and altered content", async () => {
    await storage.put({ key, bytes, checksum, mimeType: "text/plain" });
    const file = join(directory, (await readdir(directory))[0] ?? "missing");
    const data = await readFile(file);
    data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 0xff;
    await writeFile(file, data);
    await expect(storage.get(key)).rejects.toThrow("checksum mismatch");
    await writeFile(file, data.subarray(0, data.length - 1));
    await expect(storage.head(key)).rejects.toThrow("metadata");
  });

  it("refuses symbolic-link roots and object files", async () => {
    const outside = join(directory, "outside");
    await mkdir(outside);
    const rootLink = join(directory, "root-link");
    try {
      await symlink(outside, rootLink, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const linked = new LocalObjectStorage({ rootDirectory: rootLink, signingKey });
    await expect(linked.ensureBucket()).rejects.toThrow("symbolic links");
    const absentChild = new LocalObjectStorage({
      rootDirectory: join(rootLink, "must-not-create"),
      signingKey,
    });
    await expect(absentChild.ensureBucket()).rejects.toThrow("symbolic links");
    await expect(lstat(join(outside, "must-not-create"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(linked.put({ key, bytes, checksum, mimeType: "text/plain" })).rejects.toThrow(
      "symbolic links",
    );
    const child = join(rootLink, "child");
    await mkdir(child);
    await expect(
      new LocalObjectStorage({ rootDirectory: child, signingKey }).ensureBucket(),
    ).rejects.toThrow("symbolic links");
    const target = join(outside, "preserved.txt");
    await writeFile(target, "preserved");
    const objectPath = join(directory, `${createHash("sha256").update(key).digest("hex")}.object`);
    try {
      await symlink(target, objectPath, "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(storage.get(key)).rejects.toThrow("regular private file");
    await expect(storage.delete(key)).rejects.toThrow("regular private file");
    expect(await readFile(target, "utf8")).toBe("preserved");
  });

  it("derives an independent storage signing key and preserves S3 factory compatibility", () => {
    const options = localStorageOptionsFromEnvironment({ ADMIN_JWT_SECRET: "a".repeat(32) });
    expect(options.rootDirectory).toBe("/var/lib/qisheng/storage");
    expect(options.signingKey).toHaveLength(64);
    expect(options.signingKey).not.toBe("a".repeat(32));
    expect(
      localStorageOptionsFromEnvironment({
        ADMIN_JWT_SECRET: "a".repeat(32),
        OBJECT_STORAGE_LOCAL_ROOT: directory,
      }).rootDirectory,
    ).toBe(directory);
    expect(() => localStorageOptionsFromEnvironment({})).toThrow("ADMIN_JWT_SECRET");
    expect(() => localStorageOptionsFromEnvironment({ ADMIN_JWT_SECRET: "short" })).toThrow(
      "ADMIN_JWT_SECRET",
    );
    expect(() => new LocalObjectStorage({ rootDirectory: ".", signingKey })).toThrow("absolute");
    expect(() => new LocalObjectStorage({ rootDirectory: directory, signingKey: "short" })).toThrow(
      "signing key",
    );
    expect(
      createObjectStorage({ ...options, rootDirectory: directory, provider: "LOCAL" }),
    ).toBeInstanceOf(LocalObjectStorage);
    expect(
      createObjectStorage({
        accessKeyId: "test",
        secretAccessKey: "independent-secret",
        region: "us-east-1",
        bucket: "test-bucket",
      }),
    ).toBeInstanceOf(S3CompatibleObjectStorage);
  });

  it("runs the real local probe without S3 credentials and leaves no test object", async () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", join(__dirname, "probe.ts")], {
      encoding: "utf8",
      env: {
        ...process.env,
        ADMIN_JWT_SECRET: signingKey,
        OBJECT_STORAGE_PROVIDER: "LOCAL",
        OBJECT_STORAGE_LOCAL_ROOT: directory,
        OBJECT_STORAGE_ACCESS_KEY: "",
        OBJECT_STORAGE_SECRET_KEY: "",
        OBJECT_STORAGE_BUCKET: "",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      provider: "LOCAL",
      byteSize: 8,
      checksumVerified: true,
      signedRequestVerified: true,
    });
    expect(result.stdout).not.toContain(directory);
    expect(result.stdout).not.toContain(signingKey);
    expect(await readdir(directory)).toEqual([]);
  });
});
