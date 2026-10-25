import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body, Controller, type INestApplication, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { LocalObjectStorage, MemoryObjectStorage } from "@xhs-agentic/object-storage";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureApplication } from "../configure-application";
import { ModelQualificationStorageService } from "../model-configuration/model-qualification-storage.service";
import { LocalObjectStorageController } from "./local-object-storage.controller";
import { PlatformObjectStorageService, storageReadUrl } from "./platform-object-storage.service";
import { PlatformSettingsService } from "./platform-settings.service";

let storage: LocalObjectStorage | MemoryObjectStorage;
const objectStorage = { current: async () => ({ provider: "LOCAL", storage }) };
@Controller("ordinary-json")
class OrdinaryJsonController {
  @Post()
  echo(@Body() body: unknown) {
    return body;
  }
}
@Module({
  controllers: [LocalObjectStorageController, OrdinaryJsonController],
  providers: [{ provide: PlatformObjectStorageService, useValue: objectStorage }],
})
class LocalStorageTestModule {}

describe("local storage signed HTTP delivery", () => {
  let app: INestApplication;
  let origin: string;
  let directory: string;
  let local: LocalObjectStorage;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "qisheng-local-http-"));
    local = new LocalObjectStorage({
      rootDirectory: directory,
      signingKey: randomBytes(32).toString("hex"),
    });
    storage = local;
    vi.stubEnv("ADMIN_WEB_ORIGIN", "http://localhost:3101");
    app = await NestFactory.create(LocalStorageTestModule, { logger: false });
    configureApplication(app);
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("API_PORT", String(address.port));
  });

  afterEach(() => {
    storage = local;
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const httpUrl = (value: string) => `${origin}${value.slice(4)}`;
  const tokenUrl = async (bytes: Buffer, mimeType = "text/plain") =>
    local.signedPutUrl(
      { key: "tenants/tenant/materials/material/upload.txt", byteSize: bytes.length, mimeType },
      60,
    );

  it("uploads raw bytes and reads them through a private signature without a domain or S3", async () => {
    const bytes = Buffer.from("local private object");
    const upload = await tokenUrl(bytes);
    expect(
      (
        await fetch(httpUrl(upload), {
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: bytes,
        })
      ).status,
    ).toBe(204);
    const key = local.verifySignedRequest(upload.split("/").at(-1) ?? "", "PUT").key;
    const download = await local.signedGetUrl(key, 60);
    const response = await fetch(httpUrl(download));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toBe(
      `"${createHash("sha256").update(bytes).digest("hex")}"`,
    );
  });

  it("preserves JSON upload bytes without changing the ordinary API JSON limit", async () => {
    const bytes = Buffer.from(JSON.stringify({ text: "x".repeat(120_000) }));
    const upload = await tokenUrl(bytes, "application/json");
    const response = await fetch(httpUrl(upload), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: bytes,
    });
    expect(response.status).toBe(204);
    const key = local.verifySignedRequest(upload.split("/").at(-1) ?? "", "PUT").key;
    expect(Buffer.from(await local.get(key))).toEqual(bytes);
    expect(
      (
        await fetch(`${origin}/ordinary-json`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bytes,
        })
      ).status,
    ).toBe(413);
  });

  it("rejects invalid upload signatures from headers alone without buffering a large body", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${origin}/storage/objects/invalid-signature`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "Content-Length": 26_214_400 },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
          request.destroy();
        },
      );
      request.on("error", reject);
      request.setTimeout(2000, () =>
        request.destroy(new Error("Signature rejection waited for upload body")),
      );
      request.flushHeaders();
    });
    expect(status).toBe(404);
  });

  it("rejects a wrong MIME, wrong byte size, tampered token and swapped methods", async () => {
    const upload = await tokenUrl(Buffer.from("four"));
    expect(
      (
        await fetch(httpUrl(upload), {
          method: "PUT",
          headers: { "Content-Type": "image/png" },
          body: "four",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(httpUrl(upload), {
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: "extra",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(httpUrl(`${upload}invalid`), {
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: "four",
        })
      ).status,
    ).toBe(404);
    expect((await fetch(httpUrl(upload))).status).toBe(404);
    const download = await local.signedGetUrl("tenants/tenant/missing.txt", 60);
    expect(
      (
        await fetch(httpUrl(download), {
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: "four",
        })
      ).status,
    ).toBe(404);
  });

  it("bounds a chunked upload to the signed byte size", async () => {
    const upload = await tokenUrl(Buffer.from("four"));
    const response = await fetch(httpUrl(upload), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from("extra"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
  });

  it("expires signatures and disables the local route for a different backend", async () => {
    const download = await local.signedGetUrl("tenants/tenant/missing.txt", 60);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    expect((await fetch(httpUrl(download))).status).toBe(404);
    vi.restoreAllMocks();
    storage = new MemoryObjectStorage();
    expect((await fetch(httpUrl(download))).status).toBe(404);
    expect((await fetch(`${origin}/storage/objects`)).status).toBe(404);
  });

  it("runs the platform storage test through the real signed HTTP endpoint and cleans its object", async () => {
    const before = await readdir(directory);
    const audit = vi.fn().mockResolvedValue({});
    const service = new PlatformSettingsService(
      { auditLog: { create: audit } } as never,
      { requireSaasAdmin: () => ({ userId: "admin", scope: { type: "PLATFORM" } }) } as never,
      {
        string: () => {
          throw new Error("S3 settings must not be read");
        },
      } as never,
      {} as never,
      {} as never,
      objectStorage as never,
    );
    await expect(service.testStorage("local-test")).resolves.toMatchObject({
      bucket: "LOCAL",
      signedReadVerified: true,
    });
    expect(audit).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual(before);
  });

  it("runs model image round trips through the same signed HTTP endpoint", async () => {
    const service = new ModelQualificationStorageService(objectStorage as never);
    const bytes = Buffer.from("qualification image bytes");
    await expect(
      service.verifyImageRoundTrip("qualification", bytes, "image/png"),
    ).resolves.toEqual({
      byteSize: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("only resolves the exact local signature path to the fixed internal API", () => {
    expect(storageReadUrl("/api/storage/objects/payload.signature")).toBe(
      `${origin}/storage/objects/payload.signature`,
    );
    expect(storageReadUrl("https://s3.example.test/signed")).toBe("https://s3.example.test/signed");
    expect(() => storageReadUrl("/api/storage/objects/../auth/admin/session")).toThrow(
      "Invalid local object URL",
    );
  });
});
