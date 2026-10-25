import "reflect-metadata";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExecutionContext } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../database/prisma.service";
import { PublicationReadbackGuard } from "./publication-readback.guard";

const secret = "readback-node-test-secret-with-at-least-32-characters";

function fixture(panelUrl?: string, panelHost?: string) {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PUBLICATION_READBACK_NODE_KEYS_JSON", JSON.stringify({ node123: secret }));
  const fields = [
    "GET",
    "/integrations/v1/publication-readback/status",
    String(Math.floor(Date.now() / 1000)),
    randomUUID(),
    createHash("sha256").update("").digest("hex"),
  ];
  if (panelUrl !== undefined) fields.push(panelUrl);
  const headers: Record<string, string> = {
    "x-collector-id": "node123",
    "x-collector-timestamp": fields[2] ?? "",
    "x-collector-request-id": fields[3] ?? "",
    "x-collector-signature": createHmac("sha256", secret).update(fields.join("\n")).digest("hex"),
  };
  if (panelUrl !== undefined) headers["x-collector-panel-url"] = panelUrl;
  if (panelHost !== undefined) headers["x-collector-panel-host"] = panelHost;
  const request = { method: fields[0], originalUrl: fields[1], headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const prisma = {
    publicationCollectorRequestNonce: {
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    publicationReadbackNode: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const guard = new PublicationReadbackGuard(prisma as unknown as PrismaService);
  return { guard, context, prisma, headers };
}

afterEach(() => vi.unstubAllEnvs());

describe("readback node panel address authentication", () => {
  it("reserves the managed identity for the persisted independent node key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "readback-guard-"));
    try {
      const { guard, context, headers } = fixture();
      vi.stubEnv("QISHENG_RUNTIME_CONFIG", join(directory, "runtime.json"));
      writeFileSync(join(directory, "readback-node-key"), secret, { mode: 0o600 });
      vi.stubEnv(
        "PUBLICATION_READBACK_NODE_KEYS_JSON",
        JSON.stringify({ "selfhost-readback": "a-different-configured-key-that-must-not-win" }),
      );
      headers["x-collector-id"] = "selfhost-readback";
      await expect(guard.canActivate(context)).resolves.toBe(true);
      rmSync(join(directory, "readback-node-key"));
      await expect(guard.canActivate(context)).rejects.toThrow("身份校验失败");
    } finally {
      if (resolve(directory) === directory && basename(directory).startsWith("readback-guard-"))
        rmSync(directory, { recursive: true });
    }
  });
  it.each([
    ["http://localhost:23110", "http://localhost:23110/"],
    ["http://127.0.0.1:13110/", "http://127.0.0.1:13110/"],
    ["http://192.168.1.20:8080", "http://192.168.1.20:8080/"],
    ["https://collector.example.com", "https://collector.example.com/"],
    ["http://[::1]:13110/", "http://[::1]:13110/"],
    ["https://[2001:db8::1]:8443", "https://[2001:db8::1]:8443/"],
  ])("accepts a signed HTTP(S) panel URL %s without network restrictions", async (value, saved) => {
    const { guard, context, prisma } = fixture(value);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.publicationReadbackNode.upsert).toHaveBeenCalledWith({
      create: { id: "node123", lastSeenAt: expect.any(Date), panelHost: null, panelUrl: saved },
      update: { lastSeenAt: expect.any(Date), panelUrl: saved },
      where: { id: "node123" },
    });
  });

  it("binds the reported address into the signature", async () => {
    const { guard, context, headers, prisma } = fixture("https://collector.example.com/");
    headers["x-collector-panel-url"] = "https://other.example.com/";
    await expect(guard.canActivate(context)).rejects.toThrow("回读节点身份校验失败");
    expect(prisma.publicationCollectorRequestNonce.create).not.toHaveBeenCalled();
    expect(prisma.publicationReadbackNode.upsert).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "ftp://collector.example.com/",
    "https://user:password@collector.example.com/",
    "https://@collector.example.com/",
    "https://collector.example.com/path",
    "https://collector.example.com/?query=1",
    "https://collector.example.com/?",
    "https://collector.example.com/#fragment",
    "https://collector.example.com/#",
    "https://collector.example.com:65536/",
    " https://collector.example.com/",
    "https://collec\ntor.example.com/",
    "https:\\collector.example.com/",
  ])("rejects a malformed or unsafe panel URL %s", async (value) => {
    const { guard, context, prisma } = fixture(value);
    await expect(guard.canActivate(context)).rejects.toThrow("回读节点身份校验失败");
    expect(prisma.publicationCollectorRequestNonce.create).not.toHaveBeenCalled();
  });

  it("preserves the legacy five-line signature and accepts an ordinary IPv4 host", async () => {
    const { guard, context, prisma } = fixture(undefined, "127.0.0.1");
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.publicationReadbackNode.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ panelHost: "127.0.0.1", panelUrl: null }),
        update: { lastSeenAt: expect.any(Date), panelHost: "127.0.0.1" },
      }),
    );
  });

  it("does not write non-IPv4 values into the legacy VARCHAR(15) host column", async () => {
    const { guard, context, prisma } = fixture(undefined, "2001:db8:1234:5678::1");
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.publicationReadbackNode.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ panelHost: null, panelUrl: null }),
        update: { lastSeenAt: expect.any(Date) },
      }),
    );
  });
});
