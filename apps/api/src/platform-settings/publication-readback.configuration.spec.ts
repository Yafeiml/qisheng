import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { PlatformSetting } from "@xhs-agentic/database";
import { fetchNoteDetail, type NoteDetailResult } from "@xhs-agentic/xhs-api-collector";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import { managedReadbackNodeKey } from "../publication/publication-readback-node-key";
import { PlatformSettingCrypto } from "./platform-setting-crypto";
import { PlatformSettingsReader } from "./platform-settings.reader";
import { PublicationReadbackConfigurationService } from "./publication-readback.configuration";

vi.mock("@xhs-agentic/xhs-api-collector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xhs-agentic/xhs-api-collector")>()),
  fetchNoteDetail: vi.fn(),
}));
vi.mock("../publication/publication-readback-node-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../publication/publication-readback-node-key")>()),
  managedReadbackNodeKey: vi.fn(),
}));

const endpoint = "https://api.example.com/notes/detail";
const token = "fixture-provider-token-must-never-be-returned";
const available = (): NoteDetailResult => ({
  status: "AVAILABLE",
  note: {
    noteId: "000000000000000000000001",
    title: "测试样本",
    body: "仅用于离线回归测试的正文",
    authorId: null,
    publishedAt: null,
    imageCount: 0,
    hashtags: [],
    likes: 0,
    comments: 0,
    favorites: 0,
  },
});

function fixture() {
  vi.stubEnv("PUBLICATION_READBACK_ENABLED", "false");
  vi.stubEnv("MODEL_CREDENTIAL_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("MODEL_CREDENTIAL_ENCRYPTION_KEY_VERSION", "readback-test-v1");
  vi.mocked(managedReadbackNodeKey).mockReturnValue("node-key".repeat(8));
  vi.mocked(fetchNoteDetail).mockResolvedValue(available());
  const rows = new Map<string, PlatformSetting>();
  const audits: { id: string; action: string; metadata: Record<string, unknown> }[] = [];
  const principal = { userId: "administrator", scope: { type: "PLATFORM" } };
  const prisma = {
    platformSetting: {
      findMany: vi.fn(async ({ where }) =>
        [...rows.values()].filter((row) => where.key.in.includes(row.key)),
      ),
      findUnique: vi.fn(async ({ where }) => rows.get(where.key) ?? null),
      upsert: vi.fn(async ({ where, create, update }) => {
        const before = rows.get(where.key);
        const result = {
          updatedAt: new Date(),
          version: 1,
          ...before,
          ...(before ? update : create),
        };
        rows.set(where.key, result as PlatformSetting);
        return result;
      }),
    },
    auditLog: {
      findFirst: vi.fn(
        async ({ where }) =>
          [...audits]
            .reverse()
            .find(
              (row) =>
                row.action === where.action && row.metadata.fingerprint === where.metadata.equals,
            ) ?? null,
      ),
      count: vi.fn(async ({ where }) => audits.filter((row) => row.action === where.action).length),
      create: vi.fn(async ({ data }) => {
        const result = { id: `audit-${audits.length}`, ...data };
        audits.push(result);
        return result;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = audits.find((item) => item.id === where.id);
        if (!row) throw new Error("Missing audit fixture");
        Object.assign(row, data);
        return row;
      }),
    },
    publicationCollectionJob: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
    publishSubmission: { updateMany: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  let pending: Promise<unknown> = Promise.resolve();
  prisma.$transaction.mockImplementation((callback) => {
    const operation = pending.then(() => callback(prisma));
    pending = operation.catch(() => undefined);
    return operation;
  });
  const crypto = new PlatformSettingCrypto();
  const reader = new PlatformSettingsReader(prisma as unknown as PrismaService, crypto);
  const service = new PublicationReadbackConfigurationService(
    prisma as unknown as PrismaService,
    { requireSaasAdmin: () => principal } as unknown as RequestAccessContext,
    reader,
    crypto,
  );
  const save = (extra: Partial<Parameters<typeof service.save>[0]> = {}) =>
    service.save({ enabled: false, endpoint, token, reason: "离线测试配置", ...extra });
  return { service, save, rows, audits, prisma, principal };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("optional centrally managed readback", () => {
  it("defaults to disabled with an empty endpoint and rejects a sample without supplier calls or writes", async () => {
    const { service, prisma } = fixture();
    await expect(service.configuration()).resolves.toEqual({
      enabled: false,
      endpoint: "",
      tokenConfigured: false,
      verified: false,
      managedNodeConfigured: true,
      externalMode: false,
    });
    await expect(service.test("000000000000000000000001", "验证测试样本")).rejects.toThrow(
      "请先保存笔记详情接口和 Token",
    );
    expect(fetchNoteDetail).not.toHaveBeenCalled();
    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("encrypts credentials, preserves a blank replacement and keeps secrets out of GET and audit", async () => {
    const { service, save, rows, audits } = fixture();
    const saved = await save();
    const before = rows.get("publication.readback_token");
    expect(before?.ciphertext?.byteLength).toBeGreaterThan(0);
    expect(before?.value).toBeUndefined();
    await save({ token: "" });
    expect(rows.get("publication.readback_token")).toBe(before);
    expect((await service.runtime()).token).toBe(token);
    expect(JSON.stringify({ saved, audits })).not.toContain(token);
    expect(fetchNoteDetail).not.toHaveBeenCalled();
  });

  it("requires a matching verified sample and managed node before enabling", async () => {
    const { service, save } = fixture();
    await save();
    await expect(save({ enabled: true, token: "" })).rejects.toThrow("样本验证");
    await expect(service.test("000000000000000000000001", "验证测试样本")).resolves.toMatchObject({
      success: true,
    });
    expect(fetchNoteDetail).toHaveBeenCalledTimes(1);
    vi.mocked(managedReadbackNodeKey).mockReturnValue(null);
    await expect(save({ enabled: true, token: "" })).rejects.toThrow("同机回读容器");
    vi.mocked(managedReadbackNodeKey).mockReturnValue("key".repeat(20));
    await expect(save({ enabled: true, token: "" })).resolves.toMatchObject({
      enabled: true,
      verified: true,
    });
  });

  it("invalidates the sample when endpoint or credential changes", async () => {
    const { service, save } = fixture();
    await save();
    await service.test("000000000000000000000001", "验证测试样本");
    await save({ endpoint: endpoint.replace("/detail", "/detail-v2"), token: "" });
    expect((await service.configuration()).verified).toBe(false);
    await save();
    await save({ token: `${token}-replacement` });
    expect((await service.configuration()).verified).toBe(false);
  });

  it("requires an explicit credential for another origin without writes or supplier calls", async () => {
    const { service, save, prisma } = fixture();
    await save();
    const writes = prisma.platformSetting.upsert.mock.calls.length;
    await expect(save({ endpoint: "https://another.example/detail", token: "" })).rejects.toThrow(
      "重新输入 Token",
    );
    expect(prisma.platformSetting.upsert.mock.calls.length).toBe(writes);
    expect(fetchNoteDetail).not.toHaveBeenCalled();
    await expect(
      save({ endpoint: "https://another.example/detail", token: `${token}-new` }),
    ).resolves.toMatchObject({ endpoint: "https://another.example/detail", verified: false });
    expect((await service.runtime()).token).toBe(`${token}-new`);
  });

  it("can disable with an empty endpoint but cannot later send the saved credential to an unbound origin", async () => {
    const { service, save } = fixture();
    await save();
    await expect(save({ endpoint: "", token: "" })).resolves.toMatchObject({
      enabled: false,
      endpoint: "",
      tokenConfigured: true,
    });
    expect((await service.runtime()).token).toBe(token);
    await expect(save({ endpoint, token: "" })).rejects.toThrow("重新输入 Token");
  });

  it("uses the latest attempt so a failure after success cannot reuse old verification", async () => {
    const { service, save } = fixture();
    await save();
    await service.test("000000000000000000000001", "首次验证样本");
    vi.mocked(fetchNoteDetail).mockRejectedValue(new Error(`supplier detail ${token}`));
    const result = await service.test("000000000000000000000001", "再次验证样本");
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(token);
    expect((await service.configuration()).verified).toBe(false);
    await expect(save({ enabled: true, token: "" })).rejects.toThrow("样本验证");
  });

  it("reserves each billable attempt before invoking the supplier and blocks the fourth attempt", async () => {
    const { service, save } = fixture();
    await save();
    vi.mocked(fetchNoteDetail).mockResolvedValue({ status: "AUTH_ERROR", code: "HTTP_AUTH" });
    for (let i = 0; i < 3; i++) await service.test("000000000000000000000001", "验证测试样本");
    await expect(service.test("000000000000000000000001", "验证测试样本")).rejects.toThrow(
      "3 次上限",
    );
    expect(fetchNoteDetail).toHaveBeenCalledTimes(3);
  });

  it("does not allow enable while the current sample is pending", async () => {
    const { service, save } = fixture();
    await save();
    let complete!: (result: NoteDetailResult) => void;
    vi.mocked(fetchNoteDetail).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const test = service.test("000000000000000000000001", "验证测试样本");
    await vi.waitFor(() => expect(fetchNoteDetail).toHaveBeenCalledTimes(1));
    expect((await service.configuration()).verified).toBe(false);
    await expect(save({ enabled: true, token: "" })).rejects.toThrow("样本验证");
    complete(available());
    await test;
    expect((await service.configuration()).verified).toBe(true);
  });

  it("rejects missing interaction metrics and an unsafe endpoint without enabling", async () => {
    const { service, save } = fixture();
    await expect(save({ endpoint: "http://127.0.0.1/private" })).rejects.toThrow("公开 HTTPS");
    await save();
    const original = available();
    const missing =
      original.status === "AVAILABLE"
        ? { ...original, note: { ...original.note, likes: null } }
        : original;
    vi.mocked(fetchNoteDetail).mockResolvedValue(missing);
    expect((await service.test("000000000000000000000001", "验证测试样本")).success).toBe(false);
  });

  it("preserves legacy external mode when toggling off and back on without central credentials", async () => {
    const { service, rows } = fixture();
    vi.stubEnv("PUBLICATION_READBACK_ENABLED", "true");
    vi.mocked(managedReadbackNodeKey).mockReturnValue(null);
    expect(await service.configuration()).toMatchObject({ enabled: true, externalMode: true });
    expect(await service.save({ enabled: false, endpoint, reason: "关闭自动回读" })).toMatchObject({
      enabled: false,
      externalMode: true,
    });
    expect(rows.get("publication.readback_enabled")?.value).toBe(false);
    expect(await service.save({ enabled: true, endpoint, reason: "恢复原独立节点" })).toMatchObject(
      {
        enabled: true,
        externalMode: true,
        tokenConfigured: false,
        verified: false,
      },
    );
    expect(rows.get("publication.readback_enabled")?.value).toBe(true);
    expect(rows.has("publication.readback_token")).toBe(false);
    expect(fetchNoteDetail).not.toHaveBeenCalled();
  });

  it("rejects non-platform configuration before credentials or network are accessed", async () => {
    const { service, principal } = fixture();
    principal.scope.type = "TENANT";
    await expect(service.configuration()).rejects.toThrow("系统管理员");
    expect(fetchNoteDetail).not.toHaveBeenCalled();
  });
});
