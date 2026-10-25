import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { type Prisma, PrismaClient } from "@xhs-agentic/database";
import { afterAll, describe, expect, it, vi } from "vitest";
import { platformAccessScope, tenantAccessScope } from "../access/access-scope";
import { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import { AdminSmsService } from "../identity/admin-sms.service";
import type { AliyunSmsClient } from "../identity/aliyun-sms.client";
import { ADMIN_SMS_MODE_KEY, ALIYUN_SMS_KEYS } from "./admin-sms.configuration";
import { AdminSmsSettingsService } from "./admin-sms-settings.service";
import { PlatformSettingCrypto } from "./platform-setting-crypto";
import { PlatformSettingsReader } from "./platform-settings.reader";

const prisma = new PrismaClient();
const rollback = new Error("SMS_TEST_ROLLBACK");
const keys = [...Object.values(ALIYUN_SMS_KEYS), ADMIN_SMS_MODE_KEY];
const config = {
  accessKeyId: "LTAI-test-confidential-id",
  accessKeySecret: "confidential-sms-secret",
  signName: "测试签名",
  templateCode: "SMS_123456",
};
afterAll(() => prisma.$disconnect());
function access(userId: string) {
  const context = new RequestAccessContext();
  context.initialize({
    audience: "SAAS_ADMIN",
    userId,
    scope: platformAccessScope(),
    permissions: ["platform.settings.manage"],
  });
  return context;
}
async function isolated(
  run: (
    tx: Prisma.TransactionClient,
    service: AdminSmsSettingsService,
    reader: PlatformSettingsReader,
    sender: ReturnType<typeof vi.fn>,
  ) => Promise<void>,
) {
  if (!process.env.DATABASE_URL?.includes("dev_")) throw new Error("Requires development database");
  try {
    await prisma.$transaction(
      async (tx) => {
        const admin = await tx.adminUser.create({
          data: { phone: `sms-${randomUUID().slice(0, 16)}` },
        });
        const database = new Proxy(tx, {
          get(target, key) {
            if (key === "$transaction")
              return (operation: (t: Prisma.TransactionClient) => Promise<unknown>) =>
                operation(tx);
            return Reflect.get(target, key);
          },
        }) as unknown as PrismaService;
        const crypto = new PlatformSettingCrypto();
        const reader = new PlatformSettingsReader(database, crypto);
        const sender = vi.fn().mockResolvedValue({
          provider: "ALIYUN",
          messageId: "test-message",
          requestId: "test-request",
        });
        const service = new AdminSmsSettingsService(database, access(admin.id), reader, crypto, {
          send: sender,
        } as unknown as AliyunSmsClient);
        await run(tx, service, reader, sender);
        throw rollback;
      },
      { timeout: 15000 },
    );
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe("four-field administrator SMS settings", () => {
  it("encrypts credentials, enables Aliyun atomically and retains secrets on later edits", async () => {
    await isolated(async (tx, service, reader) => {
      const result = await service.save(config);
      expect(result).toMatchObject({
        configured: true,
        enabled: true,
        accessKeyIdConfigured: true,
        accessKeySecretConfigured: true,
      });
      expect(JSON.stringify(result)).not.toContain(config.accessKeyId);
      expect(JSON.stringify(result)).not.toContain(config.accessKeySecret);
      for (const key of [ALIYUN_SMS_KEYS.accessKeyId, ALIYUN_SMS_KEYS.accessKeySecret]) {
        const stored = await tx.platformSetting.findUniqueOrThrow({ where: { key } });
        expect(stored.value).toBeNull();
        expect(stored.ciphertext?.length).toBeGreaterThan(0);
      }
      await service.save({ signName: "更新签名", templateCode: "SMS_654321" });
      expect(await reader.string(ALIYUN_SMS_KEYS.accessKeySecret)).toBe(config.accessKeySecret);
      const mode = await new AdminSmsService(reader, {} as AliyunSmsClient).current();
      expect(mode).toMatchObject({ mode: "ALIYUN", delivery: "ALIYUN_SMS", signName: "更新签名" });
      const audit = await tx.auditLog.findMany({
        where: { action: "platform-setting.admin-sms.save" },
      });
      expect(JSON.stringify(audit)).not.toContain(config.accessKeySecret);
      expect(JSON.stringify(audit)).not.toContain(config.accessKeyId);
    });
  });
  it("rolls back the first credential when encrypting the second credential fails", async () => {
    const before = await prisma.platformSetting.findMany({
      where: { key: { in: keys } },
      orderBy: { key: "asc" },
    });
    const admin = await prisma.adminUser.findFirstOrThrow();
    const crypto = new PlatformSettingCrypto();
    const encrypt = crypto.encrypt.bind(crypto);
    crypto.encrypt = (value, key) => {
      if (key === ALIYUN_SMS_KEYS.accessKeySecret) throw new Error("Simulated encryption failure");
      return encrypt(value, key);
    };
    const reader = new PlatformSettingsReader(prisma as unknown as PrismaService, crypto);
    const service = new AdminSmsSettingsService(
      prisma as unknown as PrismaService,
      access(admin.id),
      reader,
      crypto,
      {} as AliyunSmsClient,
    );
    await expect(service.save(config)).rejects.toThrow("Simulated encryption failure");
    expect(
      await prisma.platformSetting.findMany({
        where: { key: { in: keys } },
        orderBy: { key: "asc" },
      }),
    ).toEqual(before);
  });
  it("sends a test through the same Aliyun adapter without returning or auditing its code", async () => {
    await isolated(async (tx, service, _reader, sender) => {
      await service.save(config);
      const result = await service.test("13800138000");
      expect(sender).toHaveBeenCalledOnce();
      expect(sender.mock.calls[0]?.[0]).toEqual(config);
      const sent = sender.mock.calls[0]?.[1] as { code: string; phone: string; requestId: string };
      expect(sent.code).toMatch(/^\d{6}$/u);
      expect(sent.requestId).toMatch(/^admin-sms-test:/u);
      expect(result).toMatchObject({ status: "ACCEPTED", phoneMasked: "138****8000" });
      expect(JSON.stringify(result)).not.toContain(sent.code);
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: "platform-setting.admin-sms.test", resourceId: result.requestId },
      });
      expect(JSON.stringify(audit)).not.toContain(sent.phone);
      expect(JSON.stringify(audit)).not.toContain(sent.code);
    });
  });
  it("does not let a tenant administrator test platform SMS", async () => {
    const context = new RequestAccessContext();
    context.initialize({
      audience: "SAAS_ADMIN",
      userId: "tenant-user",
      scope: tenantAccessScope("tenant"),
      permissions: [],
    });
    const sender = vi.fn();
    const service = new AdminSmsSettingsService(
      {} as PrismaService,
      context,
      {} as PlatformSettingsReader,
      {} as PlatformSettingCrypto,
      { send: sender } as unknown as AliyunSmsClient,
    );
    await expect(service.test("13800138000")).rejects.toThrow("仅平台管理员");
    expect(sender).not.toHaveBeenCalled();
  });
});
