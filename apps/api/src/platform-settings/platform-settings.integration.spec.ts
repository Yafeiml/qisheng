import "reflect-metadata";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ModelCredentialCipher, modelCredentialAssociatedData } from "@xhs-agentic/ai-gateway";
import type { AdminUser, GlobalUser, PlatformSetting, Prisma, Role } from "@xhs-agentic/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  enterpriseAccessScope,
  platformAccessScope,
  tenantAccessScope,
} from "../access/access-scope";
import { AuthTokenService } from "../access/auth-token.service";
import { AuthorizationRepository } from "../access/authorization.repository";
import { seedAuthorizationCatalog } from "../access/authorization.seed";
import { AppModule } from "../app.module";
import { configureApplication } from "../configure-application";
import { PrismaService } from "../database/prisma.service";
import { seedRuntimePolicy } from "../model-configuration/runtime-policy.seed";
import { PUBLICATION_SCORING_PROFILE_VERSION } from "../publication/publication-verification-scoring";
import { PlatformAssetDeliveryService } from "./platform-asset-delivery.service";
import { PlatformObjectStorageService } from "./platform-object-storage.service";
import { PlatformSettingsReader } from "./platform-settings.reader";
import { seedPlatformSettings } from "./platform-settings.seed";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

type ApiResponse = Readonly<{
  body: unknown;
  headers: Headers;
  status: number;
}>;

const mutatedSettingKeys = [
  "general.platform_name",
  "content_safety.api_key",
  "content_safety.endpoint",
  "content_safety.mode",
  "content_safety.provider",
  "content_safety.model_provider_id",
  "content_safety.model",
  "content_safety.timeout_ms",
  "security.cap_enabled",
  "security.cap_endpoint",
  "security.cap_secret",
  "notification.enabled",
  "notification.channel",
  "notification.wechat_template_id",
  "notification.wechat_template_fields",
  "notification.wechat_environment",
  "miniapp.wechat_app_id",
  "miniapp.wechat_app_secret",
  "notification.registration_smtp_password",
  "publication.api_key",
  "publication.endpoint",
  "publication.mode",
  "publication.provider",
  "miniapp.debug_code_enabled",
  "miniapp.debug_code_phones",
  "miniapp.debug_code_ips",
  "miniapp.debug_code_until",
  "storage.delivery_base_url",
  "storage.delivery_mode",
  "storage.delivery_signing_key",
  "storage.versioning_required",
] as const;
const miniappDebugKeysForTest = mutatedSettingKeys.filter((key) =>
  key.startsWith("miniapp.debug_code_"),
);

describe("platform parameter center API", { concurrent: false }, () => {
  const marker = `platform-settings-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const userIds: string[] = [];
  const adminUserIds: string[] = [];
  const employeeUserIds: string[] = [];
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let originalSettings: PlatformSetting[] = [];
  let platformAdmin: AdminUser;
  let tenantAdmin: AdminUser;
  let enterpriseAdmin: AdminUser;
  let employee: GlobalUser;
  let platformToken: string;
  let tenantToken: string;
  let enterpriseToken: string;
  let employeeToken: string;
  let tenantId: string;

  beforeAll(async () => {
    assertDevelopmentDatabase();
    app = await NestFactory.create(AppModule, {
      abortOnError: false,
      bodyParser: false,
      logger: ["error"],
    });
    configureApplication(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
    prisma = app.get(PrismaService);
    const tokens = app.get(AuthTokenService);
    const authorization = app.get(AuthorizationRepository);

    await seedAuthorizationCatalog(prisma);
    await seedRuntimePolicy(prisma);
    await seedPlatformSettings(prisma);
    originalSettings = await prisma.platformSetting.findMany({
      where: { key: { in: [...mutatedSettingKeys] } },
    });

    const [platformRole, tenantRole, enterpriseRole] = await Promise.all([
      requireRole(prisma, "PLATFORM_ADMIN"),
      requireRole(prisma, "TENANT_ADMIN"),
      requireRole(prisma, "ENTERPRISE_ADMIN"),
    ]);
    const tenant = await prisma.tenant.create({
      data: { customerType: "GROUP", name: `${marker}-tenant` },
    });
    tenantId = tenant.id;
    const enterprise = await prisma.enterprise.create({
      data: {
        code: `SETTING_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
        name: `${marker}-enterprise`,
        tenantId,
      },
    });
    const users = await Promise.all(
      [0, 1, 2].map((index) =>
        prisma.adminUser.create({
          data: {
            phone: testPhone(index),
            phoneVerifiedAt: new Date(),
          },
        }),
      ),
    );
    platformAdmin = requiredAt(users, 0);
    tenantAdmin = requiredAt(users, 1);
    enterpriseAdmin = requiredAt(users, 2);
    employee = await prisma.globalUser.create({
      data: { phone: testPhone(3), phoneVerifiedAt: new Date() },
    });
    adminUserIds.push(platformAdmin.id, tenantAdmin.id, enterpriseAdmin.id);
    employeeUserIds.push(employee.id);
    userIds.push(platformAdmin.id, tenantAdmin.id, enterpriseAdmin.id, employee.id);
    await Promise.all([
      authorization.createRoleBinding(platformAccessScope(), {
        roleId: platformRole.id,
        targetScope: platformAccessScope(),
        userId: platformAdmin.id,
      }),
      authorization.createRoleBinding(platformAccessScope(), {
        roleId: tenantRole.id,
        targetScope: tenantAccessScope(tenantId),
        userId: tenantAdmin.id,
      }),
      authorization.createRoleBinding(platformAccessScope(), {
        roleId: enterpriseRole.id,
        targetScope: enterpriseAccessScope(tenantId, enterprise.id),
        userId: enterpriseAdmin.id,
      }),
    ]);
    platformToken = tokens.issueAdminAccessToken(platformAdmin.id);
    tenantToken = tokens.issueAdminAccessToken(tenantAdmin.id);
    enterpriseToken = tokens.issueAdminAccessToken(enterpriseAdmin.id);
    employeeToken = tokens.issueEmployeeAccessToken(employee.id);
  });

  afterAll(async () => {
    if (!prisma) return;
    if (!tenantId) {
      await app.close();
      return;
    }
    await prisma.publicationVerificationPolicyEvidence.deleteMany({
      where: { registeredBy: { in: userIds } },
    });
    await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.roleBinding.deleteMany({ where: { userId: { in: adminUserIds } } });
    await prisma.enterprise.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.adminUser.deleteMany({ where: { id: { in: adminUserIds } } });
    await prisma.globalUser.deleteMany({ where: { id: { in: employeeUserIds } } });
    await restoreSettings(prisma, originalSettings);
    await app.close();
  });

  it("allows only a platform administrator to read settings", async () => {
    const [platform, tenant, enterprise, miniapp] = await Promise.all([
      apiRequest("/platform/settings", { token: platformToken }),
      apiRequest("/platform/settings", { token: tenantToken }),
      apiRequest("/platform/settings", { token: enterpriseToken }),
      apiRequest("/platform/settings", { token: employeeToken }),
    ]);

    expect(platform.status).toBe(200);
    expect(arrayField(platform.body, "groups")).toHaveLength(10);
    expect(
      arrayField(platform.body, "groups").some((group) => asRecord(group).group === "MINIAPP"),
    ).toBe(true);
    expect(
      arrayField(platform.body, "groups").some(
        (group) => asRecord(group).group === "CONTENT_SAFETY",
      ),
    ).toBe(true);
    expect(
      arrayField(platform.body, "groups").some((group) => asRecord(group).group === "PUBLICATION"),
    ).toBe(true);
    expect(tenant.status).toBe(403);
    expect(enterprise.status).toBe(403);
    expect(miniapp.status).toBe(401);
  });

  it("saves miniapp debug settings together, audits changes and rejects incomplete or unauthorized writes", async () => {
    const url = "/platform/settings/miniapp-debug";
    const configuration = {
      enabled: true,
      phones: "13800000099",
      ips: "*",
      until: "never",
      reason: "验证小程序临时验证码配置",
    };
    const denied = await apiRequest(url, {
      token: tenantToken,
      method: "POST",
      body: configuration,
    });
    expect(denied.status).toBe(403);
    const invalid = await apiRequest(url, {
      token: platformToken,
      method: "POST",
      body: { ...configuration, phones: "not-a-phone" },
    });
    expect(invalid.status).toBe(409);
    const unchanged = await prisma.platformSetting.findUnique({
      where: { key: "miniapp.debug_code_enabled" },
    });
    expect(unchanged?.value).not.toBe(true);
    const saved = await apiRequest(url, {
      token: platformToken,
      method: "POST",
      body: configuration,
    });
    expect(saved.status).toBe(200);
    const group = arrayField(saved.body, "groups").find(
      (item) => asRecord(item).group === "MINIAPP",
    );
    expect(group).toBeDefined();
    const rows = await prisma.platformSetting.findMany({
      where: { key: { in: [...miniappDebugKeysForTest] } },
    });
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.key === "miniapp.debug_code_enabled")?.value).toBe(true);
    expect(rows.find((row) => row.key === "miniapp.debug_code_phones")?.value).toBe("13800000099");
    const logs = await prisma.auditLog.findMany({
      where: {
        actorUserId: platformAdmin.id,
        resourceId: { in: [...miniappDebugKeysForTest] },
        reason: configuration.reason,
      },
    });
    expect(logs).toHaveLength(4);
    const genericWrite = await apiRequest("/platform/settings/miniapp.debug_code_enabled", {
      token: platformToken,
      method: "POST",
      body: { reason: configuration.reason, value: false },
    });
    expect(genericWrite.status).toBe(409);
    const disabled = await apiRequest(url, {
      token: platformToken,
      method: "POST",
      body: { ...configuration, enabled: false },
    });
    expect(disabled.status).toBe(200);
  });

  it("refuses production browser mode before persisting platform settings", async () => {
    const previousMode = await prisma.platformSetting.findUnique({
      select: { value: true },
      where: { key: "publication.mode" },
    });
    const productionSession = await prisma.adminSession.create({
      data: {
        expiresAt: new Date(Date.now() + 60 * 60_000),
        id: randomUUID(),
        refreshTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        userId: platformAdmin.id,
      },
    });
    const productionToken = app
      .get(AuthTokenService)
      .issueAdminAccessToken(platformAdmin.id, productionSession.id);
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const rejected = await apiRequest("/platform/settings/publication.mode", {
        body: { reason: "浏览器验真未完成独立生产验收", value: "BROWSER" },
        method: "POST",
        token: productionToken,
      });
      expect(rejected.status).toBe(409);
      expect(asRecord(rejected.body)).toMatchObject({
        code: "PUBLICATION_BROWSER_PRODUCTION_NOT_READY",
      });
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
      await prisma.adminSession.delete({ where: { id: productionSession.id } });
    }
    const unchanged = await prisma.platformSetting.findUnique({
      select: { value: true },
      where: { key: "publication.mode" },
    });
    expect(unchanged).toEqual(previousMode);
  });

  it("persists a normal parameter once and replays an identical idempotent request", async () => {
    const value = `企声发布 ${randomUUID().slice(0, 8)}`;
    const idempotencyKey = `setting-${randomUUID()}`;
    const input = { reason: "验证参数中心数据库写入与幂等重放", value };
    const first = await apiRequest("/platform/settings/general.platform_name", {
      body: input,
      idempotencyKey,
      method: "POST",
      token: platformToken,
    });
    const replayed = await apiRequest("/platform/settings/general.platform_name", {
      body: input,
      idempotencyKey,
      method: "POST",
      token: platformToken,
    });

    expect(first.status).toBe(200);
    expect(replayed.status).toBe(200);
    expect(first.headers.get("idempotency-replayed")).toBe("false");
    expect(replayed.headers.get("idempotency-replayed")).toBe("true");
    expect(asRecord(first.body)).toMatchObject({
      key: "general.platform_name",
      source: "DATABASE",
      value,
    });
    await expect(
      prisma.platformSetting.findUniqueOrThrow({
        select: { updatedBy: true, value: true },
        where: { key: "general.platform_name" },
      }),
    ).resolves.toMatchObject({ updatedBy: platformAdmin.id, value });
    await expect(
      prisma.auditLog.count({
        where: {
          action: "platform-setting.update",
          actorUserId: platformAdmin.id,
          resourceId: "general.platform_name",
        },
      }),
    ).resolves.toBe(1);
  });

  it("encrypts secret parameters and never exposes plaintext in responses or audit state", async () => {
    const secret = randomBytes(16).toString("hex");
    const updated = await apiRequest("/platform/settings/storage.delivery_signing_key", {
      body: { reason: "验证平台密钥加密与脱敏审计", value: secret },
      method: "POST",
      token: platformToken,
    });
    const listed = await apiRequest("/platform/settings", { token: platformToken });
    const row = await prisma.platformSetting.findUniqueOrThrow({
      where: { key: "storage.delivery_signing_key" },
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
      where: {
        action: "platform-setting.update",
        actorUserId: platformAdmin.id,
        resourceId: "storage.delivery_signing_key",
      },
    });

    expect(updated.status).toBe(200);
    expect(JSON.stringify(updated.body)).not.toContain(secret);
    expect(asRecord(updated.body)).toMatchObject({
      key: "storage.delivery_signing_key",
      maskedValue: `••••••••${secret.slice(-4)}`,
      secret: true,
      value: null,
    });
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    expect(row.value).toBeNull();
    expect(row.ciphertext).toBeInstanceOf(Uint8Array);
    expect(row.ciphertext?.byteLength).toBeGreaterThan(0);
    expect(row.secretLastFour).toBe(secret.slice(-4));
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(audit.stateAfter)).toContain("[REDACTED]");
  });

  it("persists the Cap endpoint and encrypted secret with masked responses and audited changes", async () => {
    const endpoint = "https://cap.example.com/settings-test-site/";
    const secret = `test-cap-${randomUUID()}`;
    const savedEndpoint = await apiRequest("/platform/settings/security.cap_endpoint", {
      body: { reason: "配置外部 Cap 人机验证站点", value: endpoint.slice(0, -1) },
      method: "POST",
      token: platformToken,
    });
    const savedSecret = await apiRequest("/platform/settings/security.cap_secret", {
      body: { reason: "配置 Cap 站点服务端验票密钥", value: secret },
      method: "POST",
      token: platformToken,
    });
    const invalidEndpoint = await apiRequest("/platform/settings/security.cap_endpoint", {
      body: { reason: "拒绝带查询参数的 Cap 服务地址", value: `${endpoint}?key=secret` },
      method: "POST",
      token: platformToken,
    });
    const denied = await apiRequest("/platform/settings/security.cap_secret", {
      body: { reason: "租户管理员不得调整平台验票密钥", value: "denied-test-secret" },
      method: "POST",
      token: tenantToken,
    });
    const listed = await apiRequest("/platform/settings", { token: platformToken });
    const rows = await prisma.platformSetting.findMany({
      where: { key: { in: ["security.cap_endpoint", "security.cap_secret"] } },
    });
    const logs = await prisma.auditLog.findMany({
      where: {
        action: "platform-setting.update",
        actorUserId: platformAdmin.id,
        resourceId: { in: ["security.cap_endpoint", "security.cap_secret"] },
      },
    });
    const resolved = await app
      .get(PlatformSettingsReader)
      .resolveMany(["security.cap_endpoint", "security.cap_secret"]);

    expect(savedEndpoint.status).toBe(200);
    expect(savedEndpoint.body).toMatchObject({
      configured: true,
      key: "security.cap_endpoint",
      source: "DATABASE",
      value: endpoint,
    });
    expect(savedSecret.status).toBe(200);
    expect(savedSecret.body).toMatchObject({
      configured: true,
      key: "security.cap_secret",
      maskedValue: `••••••••${secret.slice(-4)}`,
      secret: true,
      value: null,
    });
    expect(invalidEndpoint.status).toBe(409);
    expect(denied.status).toBe(403);
    expect(resolved.get("security.cap_endpoint")).toMatchObject({
      source: "DATABASE",
      value: endpoint,
    });
    expect(resolved.get("security.cap_secret")).toMatchObject({
      source: "DATABASE",
      value: secret,
    });
    expect(rows.find(({ key }) => key === "security.cap_endpoint")?.value).toBe(endpoint);
    const secretRow = rows.find(({ key }) => key === "security.cap_secret");
    expect(secretRow?.value).toBeNull();
    expect(secretRow?.ciphertext?.byteLength).toBeGreaterThan(0);
    expect(secretRow?.secretLastFour).toBe(secret.slice(-4));
    expect(logs).toHaveLength(2);
    expect(
      logs.find(({ resourceId }) => resourceId === "security.cap_endpoint")?.stateAfter,
    ).toMatchObject({ value: endpoint });
    expect(
      logs.find(({ resourceId }) => resourceId === "security.cap_secret")?.stateAfter,
    ).toMatchObject({ value: "[REDACTED]" });
    for (const response of [savedSecret.body, listed.body, logs]) {
      expect(JSON.stringify(response)).not.toContain(secret);
    }
  });

  it("saves SMTP authorization passwords encrypted without exposing them in the settings API", async () => {
    const password = `test-smtp-${randomUUID()}`;
    const updated = await apiRequest("/platform/settings/notification.registration_smtp_password", {
      body: { reason: "配置注册申请邮件 SMTP 授权密码", value: password },
      method: "POST",
      token: platformToken,
    });
    const row = await prisma.platformSetting.findUniqueOrThrow({
      where: { key: "notification.registration_smtp_password" },
    });
    expect(updated.status).toBe(200);
    expect(JSON.stringify(updated.body)).not.toContain(password);
    expect(asRecord(updated.body)).toMatchObject({ secret: true, value: null });
    expect(row.value).toBeNull();
    expect(row.ciphertext?.byteLength).toBeGreaterThan(0);
  });

  it("requires endpoint and encrypted secret before optional Cap verification can be enabled", async () => {
    const save = (key: string, value: unknown) =>
      apiRequest(`/platform/settings/${key}`, {
        body: { reason: "验证可选 Cap 配置门禁", value },
        method: "POST",
        token: platformToken,
      });
    expect((await save("security.cap_enabled", false)).status).toBe(200);
    expect((await save("security.cap_endpoint", "")).status).toBe(200);
    expect((await save("security.cap_secret", "")).status).toBe(409);
    await prisma.platformSetting.deleteMany({ where: { key: "security.cap_secret" } });
    expect((await save("security.cap_enabled", true)).status).toBe(409);
    expect((await save("security.cap_endpoint", "https://cap.example.test/site/")).status).toBe(
      200,
    );
    expect((await save("security.cap_secret", "test-only-cap-secret")).status).toBe(200);
    expect((await save("security.cap_enabled", true)).status).toBe(200);
    expect((await save("security.cap_secret", "")).status).toBe(409);
    expect((await save("security.cap_endpoint", "")).status).toBe(409);
    expect((await save("security.cap_enabled", false)).status).toBe(200);
  });

  it("fails closed when optional WeChat notification configuration is incomplete", async () => {
    const notification = await apiRequest("/platform/settings/notification.enabled", {
      body: { reason: "验证通知配置完整性", value: true },
      method: "POST",
      token: platformToken,
    });
    expect(notification.status).toBe(409);
    expect(JSON.stringify(notification.body)).toContain("WECHAT_NOTIFICATION_SETTINGS_INCOMPLETE");
  });
  it("enables configured subscription notifications and masks the miniapp secret", async () => {
    for (const [key, value] of Object.entries({
      "notification.channel": "WECHAT_TEMPLATE",
      "notification.wechat_template_id": "test-notification-template",
      "notification.wechat_template_fields": '{"thing4":"TASK_TITLE","time5":"EXPIRES_AT"}',
      "notification.wechat_environment": "formal",
      "miniapp.wechat_app_id": "wx1111111111111111",
    })) {
      const saved = await apiRequest(`/platform/settings/${key}`, {
        body: { reason: "配置通知测试模板", value },
        method: "POST",
        token: platformToken,
      });
      expect(saved.status).toBe(200);
    }
    const secret = "A".repeat(32);
    const configured = await apiRequest("/platform/settings/miniapp.wechat_app_secret", {
      body: { reason: "验证微信凭据加密及通知配置", value: secret },
      method: "POST",
      token: platformToken,
    });
    expect(configured.status).toBe(200);
    expect(JSON.stringify(configured.body)).not.toContain(secret);
    const enabled = await apiRequest("/platform/settings/notification.enabled", {
      body: { reason: "验证完整订阅消息参数可启用", value: true },
      method: "POST",
      token: platformToken,
    });
    expect(enabled.status).toBe(200);
    const appChanged = await apiRequest("/platform/settings/miniapp.wechat_app_id", {
      body: { reason: "拒绝通知运行中切换小程序", value: "wxaaaaaaaaaaaaaaaa" },
      method: "POST",
      token: platformToken,
    });
    expect(appChanged.status).toBe(409);
    const invalidFields = await apiRequest(
      "/platform/settings/notification.wechat_template_fields",
      {
        body: { reason: "拒绝字段类型不匹配", value: '{"time5":"TASK_TITLE"}' },
        method: "POST",
        token: platformToken,
      },
    );
    expect(invalidFields.status).toBe(409);
    await apiRequest("/platform/settings/notification.enabled", {
      body: { reason: "恢复测试前通知关闭状态", value: false },
      method: "POST",
      token: platformToken,
    });
  });

  it("performs a real object-storage put, signed read, checksum and cleanup probe", async () => {
    const response = await apiRequest("/platform/settings/storage/test", {
      body: { reason: "验证参数中心对象存储连接" },
      method: "POST",
      token: platformToken,
    });

    expect(response.status).toBe(200);
    expect(asRecord(response.body)).toMatchObject({ signedReadVerified: true });
    expect(numberField(response.body, "byteSize")).toBeGreaterThan(0);
    await expect(
      prisma.auditLog.findFirst({
        where: {
          action: "platform-setting.storage-test",
          actorUserId: platformAdmin.id,
        },
      }),
    ).resolves.not.toBeNull();
  });

  it("applies versioned lifecycle when supported or fails closed when the local store cannot enable it", async () => {
    // Development installations may intentionally opt out of versioning;
    // enable the policy only for this test and restore the setting in afterAll.
    const enabled = await apiRequest("/platform/settings/storage.versioning_required", {
      body: { reason: "验证仅针对本地对象桶启用版本控制", value: true },
      method: "POST",
      token: platformToken,
    });
    expect(enabled.status).toBe(200);
    const response = await apiRequest("/platform/settings/storage/lifecycle/apply", {
      body: { reason: "验证对象版本控制和历史版本生命周期策略" },
      method: "POST",
      token: platformToken,
    });

    if (response.status === 409) {
      expect(asRecord(response.body)).toMatchObject({
        code: "STORAGE_MANAGEMENT_UNSUPPORTED",
        details: { operation: "VERSIONING", httpStatus: 501 },
      });
    } else {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(asRecord(response.body)).toMatchObject({
        enabled: true,
        noncurrentVersionExpirationDays: 30,
        versioning: "ENABLED",
      });
      await expect(
        prisma.auditLog.findFirst({
          where: {
            action: "platform-setting.storage-lifecycle.apply",
            actorUserId: platformAdmin.id,
          },
        }),
      ).resolves.not.toBeNull();
    }
  });

  it("delivers a private object through the expiring Edge route without exposing credentials", async () => {
    const signingKey = `edge-${randomUUID()}-${randomUUID()}`;
    for (const [key, value] of [
      ["storage.delivery_base_url", baseUrl],
      ["storage.delivery_signing_key", signingKey],
      ["storage.delivery_mode", "EDGE_SIGNED"],
    ] as const) {
      const response = await apiRequest(`/platform/settings/${key}`, {
        body: { reason: "验证 CDN Edge 短期签名交付", value },
        method: "POST",
        token: platformToken,
      });
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(signingKey);
    }

    const objectStorage = app.get(PlatformObjectStorageService);
    const delivery = app.get(PlatformAssetDeliveryService);
    const { storage } = await objectStorage.current();
    const key = `tenants/${tenantId}/materials/${marker}/edge-test.txt`;
    const bytes = Buffer.from("private edge delivery test", "utf8");
    await storage.put({
      bytes,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      key,
      mimeType: "text/plain",
    });
    try {
      const url = await delivery.signedUrl(key);
      expect(url).toContain(`${baseUrl}/assets/`);
      expect(url).not.toContain(signingKey);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("immutable");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      await expect(response.text()).resolves.toBe(bytes.toString("utf8"));
      const tampered = await fetch(`${url.slice(0, -1)}x`);
      expect(tampered.status).toBe(404);
    } finally {
      await storage.delete(key);
    }
  });

  it("saves a model selection atomically, verifies image understanding and invalidates rotated credentials", async () => {
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      requests.push(body);
      const image = body.messages[1].content.find(
        (part: { type: string }) => part.type === "image_url",
      ).image_url.url;
      const decision = image.length > 2000 ? "REVIEW" : "PASS";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  decision,
                  reviewedImages: [1],
                  categories:
                    decision === "PASS"
                      ? []
                      : [{ code: "MEDICAL_CLAIMS", decision, message: "危险医疗宣传" }],
                }),
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing provider test address");
    const provider = await prisma.modelProvider.create({
      data: {
        code: `SAFETY_${randomUUID()}`,
        name: "Safety integration provider",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        status: "ACTIVE",
        synthetic: false,
        protocol: "OPENAI_COMPATIBLE",
      },
    });
    const credentialId = randomUUID();
    const key = `integration-only-${randomUUID()}`;
    const encrypted = ModelCredentialCipher.fromEnvironment().encrypt(
      key,
      modelCredentialAssociatedData(provider.id, credentialId),
    );
    await prisma.modelProviderCredential.create({
      data: {
        id: credentialId,
        providerId: provider.id,
        authenticationTag: Buffer.from(encrypted.authenticationTag),
        ciphertext: Buffer.from(encrypted.ciphertext),
        initializationVector: Buffer.from(encrypted.initializationVector),
        keyVersion: encrypted.keyVersion,
        lastFour: key.slice(-4),
        createdBy: platformAdmin.id,
      },
    });
    await prisma.modelProvider.update({
      where: { id: provider.id },
      data: { activeCredentialId: credentialId },
    });
    try {
      const body = {
        mode: "MODEL",
        modelProviderId: provider.id,
        model: "fixture-vision",
        timeoutMs: 30000,
      };
      expect(
        (
          await apiRequest("/platform/settings/content-safety", {
            method: "POST",
            token: tenantToken,
            body,
          })
        ).status,
      ).toBe(403);
      const saved = await apiRequest("/platform/settings/content-safety", {
        method: "POST",
        token: platformToken,
        body,
      });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ mode: "MODEL", model: "fixture-vision", verified: false });
      expect(JSON.stringify(saved.body)).not.toContain(key);
      const probe = await apiRequest("/platform/settings/content-safety/test", {
        method: "POST",
        token: platformToken,
        body: { reason: "验证多模态审核模型和凭据复用" },
      });
      expect(probe.status).toBe(200);
      expect(probe.body).toMatchObject({ imageRiskDetected: true });
      expect(requests).toHaveLength(2);
      expect(
        (await apiRequest("/platform/settings/content-safety", { token: platformToken })).body,
      ).toMatchObject({ verified: true });
      const rotated = ModelCredentialCipher.fromEnvironment().encrypt(
        `rotated-${randomUUID()}`,
        modelCredentialAssociatedData(provider.id, credentialId),
      );
      await prisma.modelProviderCredential.update({
        where: { id: credentialId },
        data: {
          authenticationTag: Buffer.from(rotated.authenticationTag),
          ciphertext: Buffer.from(rotated.ciphertext),
          initializationVector: Buffer.from(rotated.initializationVector),
        },
      });
      expect(
        (await apiRequest("/platform/settings/content-safety", { token: platformToken })).body,
      ).toMatchObject({ verified: false });
    } finally {
      await prisma.modelProvider.update({
        where: { id: provider.id },
        data: { activeCredentialId: null },
      });
      await prisma.modelProviderCredential.delete({ where: { id: credentialId } });
      await prisma.modelProvider.delete({ where: { id: provider.id } });
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("tests the platform-managed multimodal content-safety adapter without exposing its key", async () => {
    const provider = await startContentSafetyProvider();
    const apiKey = `content-safety-${randomUUID()}`;
    try {
      for (const [key, value] of [
        ["content_safety.api_key", apiKey],
        ["content_safety.endpoint", provider.endpoint],
        ["content_safety.provider", "LOCAL_SAFETY_TEST"],
        ["content_safety.mode", "HTTP"],
      ] as const) {
        const response = await apiRequest(`/platform/settings/${key}`, {
          body: { reason: "验证平台统一内容安全适配器", value },
          method: "POST",
          token: platformToken,
        });
        expect(response.status).toBe(200);
        expect(JSON.stringify(response.body)).not.toContain(apiKey);
      }
      const response = await apiRequest("/platform/settings/content-safety/test", {
        body: { reason: "验证内容安全图文请求、授权和响应契约" },
        method: "POST",
        token: platformToken,
      });
      expect(response.status).toBe(200);
      expect(asRecord(response.body)).toMatchObject({
        decision: "PASS",
        provider: "LOCAL_SAFETY_TEST",
      });
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.authorization).toBe(`Bearer ${apiKey}`);
      expect(provider.requests[0]?.body).toContain("内容安全服务检测");
      expect(JSON.stringify(response.body)).not.toContain(apiKey);
    } finally {
      await provider.close();
    }
  });

  it("tests the platform-managed public-content adapter without exposing provider credentials", async () => {
    const provider = await startPublicationVerificationProvider();
    const apiKey = `publication-${randomUUID()}`;
    try {
      for (const [key, value] of [
        ["publication.api_key", apiKey],
        ["publication.endpoint", provider.endpoint],
        ["publication.provider", "LOCAL_PUBLICATION_TEST"],
        ["publication.mode", "HTTP"],
      ] as const) {
        const response = await apiRequest(`/platform/settings/${key}`, {
          body: { reason: "验证平台统一公开内容验真适配器", value },
          method: "POST",
          token: platformToken,
        });
        expect(response.status).toBe(200);
        expect(JSON.stringify(response.body)).not.toContain(apiKey);
      }
      const response = await apiRequest("/platform/settings/publication-verification/test", {
        body: {
          reason: "验证小红书公开链接解析、授权和图片指纹响应契约",
          url: "https://www.xiaohongshu.com/explore/abcdef123456",
        },
        method: "POST",
        token: platformToken,
      });
      expect(response.status).toBe(200);
      expect(asRecord(response.body)).toMatchObject({
        available: true,
        imageCount: 1,
        policyVersion: "xhs-public-v1",
        provider: "LOCAL_PUBLICATION_TEST",
      });
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.authorization).toBe(`Bearer ${apiKey}`);
      expect(provider.requests[0]?.idempotencyKey).toBeTruthy();
      expect(provider.requests[0]?.body).toContain("xiaohongshu.com/explore/abcdef123456");
      expect(JSON.stringify(response.body)).not.toContain(apiKey);
      const tenantDenied = await apiRequest("/platform/settings/publication-verification/test", {
        body: {
          reason: "租户管理员不得探测平台验真供应商",
          url: "https://www.xiaohongshu.com/explore/abcdef123456",
        },
        method: "POST",
        token: tenantToken,
      });
      expect(tenantDenied.status).toBe(403);
      const audit = await prisma.auditLog.findFirstOrThrow({
        orderBy: { createdAt: "desc" },
        where: {
          action: "platform-setting.publication-verification-test",
          actorUserId: platformAdmin.id,
        },
      });
      expect(JSON.stringify(audit)).not.toContain(apiKey);
    } finally {
      await provider.close();
    }
  });

  it("registers only immutable P-014 evidence that matches the active production policy", async () => {
    const endpoint = "https://publication.example.com/v1/resolve";
    const providerCode = "PUBLICATION_VENDOR_V1";
    for (const [key, value] of [
      ["publication.api_key", `publication-production-${randomUUID()}`],
      ["publication.endpoint", endpoint],
      ["publication.provider", providerCode],
      ["publication.mode", "HTTP"],
    ] as const) {
      const response = await apiRequest(`/platform/settings/${key}`, {
        body: { reason: "准备登记正式 P-014 策略证据", value },
        method: "POST",
        token: platformToken,
      });
      expect(response.status).toBe(200);
    }
    const report = p014AcceptanceReport({ endpoint, providerCode });
    const acceptanceReportJson = JSON.stringify(report, null, 2);
    const registered = await apiRequest("/platform/settings/publication-verification/evidence", {
      body: { acceptanceReportJson, reason: "登记正式 P-014 真实样本验收证据" },
      method: "POST",
      token: platformToken,
    });
    const current = await apiRequest("/platform/settings/publication-verification/evidence", {
      token: platformToken,
    });
    const denied = await apiRequest("/platform/settings/publication-verification/evidence", {
      token: tenantToken,
    });

    expect(registered.status).toBe(200);
    expect(asRecord(registered.body)).toMatchObject({
      benchmarkId: report.benchmarkId,
      policyVersion: "xhs-public-v1",
      providerCode,
      sampleCount: 30,
      scoringProfileVersion: PUBLICATION_SCORING_PROFILE_VERSION,
    });
    expect(String(asRecord(registered.body).acceptanceReportSha256)).toMatch(/^[0-9a-f]{64}$/u);
    expect(current.status).toBe(200);
    expect(current.body).toEqual(registered.body);
    expect(denied.status).toBe(403);
    await expect(
      prisma.auditLog.findFirst({
        where: {
          action: "platform-setting.publication-policy-evidence.register",
          actorUserId: platformAdmin.id,
        },
      }),
    ).resolves.not.toBeNull();

    const mismatched = await apiRequest("/platform/settings/publication-verification/evidence", {
      body: {
        acceptanceReportJson: JSON.stringify({
          ...report,
          approvedPolicy: { ...report.approvedPolicy, textSimilarityThreshold: 0.9 },
        }),
        reason: "拒绝与当前阈值不一致的证据",
      },
      method: "POST",
      token: platformToken,
    });
    expect(mismatched.status).toBe(409);
  });

  it("exposes a secret-free unified production-readiness audit", async () => {
    const response = await apiRequest("/platform/operations/production-readiness", {
      token: platformToken,
    });

    expect(response.status).toBe(200);
    expect(asRecord(response.body)).toMatchObject({
      deliveryMode: "DEVELOPMENT",
      schemaVersion: 1,
      state: "BLOCKED",
    });
    const checks = arrayField(response.body, "checks").map(asRecord);
    expect(checks.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "RUNTIME_PRODUCTION_MODE",
        "INFRASTRUCTURE_DATABASE",
        "INFRASTRUCTURE_STORAGE_GOVERNANCE",
        "MODEL_ROUTE_QUALIFICATION",
        "ADAPTER_CONTENT_SAFETY",
        "ADAPTER_CAP",
      ]),
    );
    const serialized = JSON.stringify(response.body);
    for (const secret of [
      process.env.ADMIN_JWT_SECRET,
      process.env.EMPLOYEE_JWT_SECRET,
      process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY,
    ]) {
      if (secret) expect(serialized).not.toContain(secret);
    }
  });

  async function apiRequest(
    path: string,
    options: Readonly<{
      body?: unknown;
      idempotencyKey?: string;
      method?: "GET" | "POST";
      token?: string;
    }> = {},
  ): Promise<ApiResponse> {
    const headers = new Headers();
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.method === "POST") {
      headers.set("idempotency-key", options.idempotencyKey ?? randomUUID());
    }
    const response = await fetch(`${baseUrl}${path}`, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method: options.method ?? "GET",
    });
    const text = await response.text();
    return {
      body: text.length > 0 ? JSON.parse(text) : null,
      headers: response.headers,
      status: response.status,
    };
  }
});

async function startContentSafetyProvider(): Promise<{
  close(): Promise<void>;
  endpoint: string;
  requests: { authorization: string | undefined; body: string }[];
}> {
  const requests: { authorization: string | undefined; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ authorization: request.headers.authorization, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          categories: [],
          decision: "PASS",
          model: "local-safety-v1",
          requestId: `safety-${requests.length}`,
        }),
      );
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Content-safety test server failed");
  return {
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    endpoint: `http://127.0.0.1:${address.port}/v1/scan`,
    requests,
  };
}

async function startPublicationVerificationProvider(): Promise<{
  close(): Promise<void>;
  endpoint: string;
  requests: {
    authorization: string | undefined;
    body: string;
    idempotencyKey: string | undefined;
  }[];
}> {
  const requests: {
    authorization: string | undefined;
    body: string;
    idempotencyKey: string | undefined;
  }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body,
        idempotencyKey: headerValue(request.headers["idempotency-key"]),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          body: "公开内容正文",
          canonicalUrl: "https://www.xiaohongshu.com/explore/abcdef123456?utm_source=provider",
          externalPublishedAt: new Date().toISOString(),
          hashtags: ["公开内容"],
          images: [
            {
              checksum: "a".repeat(64),
              perceptualHash: "0123456789abcdef",
              url: "https://cdn.example.test/publication.jpg",
            },
          ],
          model: "local-publication-v1",
          reference: "provider-reference-1",
          requestId: `publication-${requests.length}`,
          status: "AVAILABLE",
          title: "公开内容标题",
        }),
      );
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Publication-verification test server failed");
  }
  return {
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    endpoint: `http://127.0.0.1:${address.port}/v1/resolve`,
    requests,
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function restoreSettings(
  prisma: PrismaService,
  settings: readonly PlatformSetting[],
): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: { in: [...mutatedSettingKeys] } } });
  for (const setting of settings) {
    await prisma.platformSetting.create({
      data: {
        authenticationTag: setting.authenticationTag,
        ciphertext: setting.ciphertext,
        createdAt: setting.createdAt,
        group: setting.group,
        initializationVector: setting.initializationVector,
        key: setting.key,
        keyVersion: setting.keyVersion,
        secretLastFour: setting.secretLastFour,
        updatedAt: setting.updatedAt,
        updatedBy: setting.updatedBy,
        value: setting.value === null ? undefined : (setting.value as Prisma.InputJsonValue),
        valueType: setting.valueType,
        version: setting.version,
      },
    });
  }
}

async function requireRole(prisma: PrismaService, code: string): Promise<Role> {
  const role = await prisma.role.findUnique({ where: { code } });
  if (!role) throw new Error(`Seeded role was not found: ${code}`);
  return role;
}

function arrayField(value: unknown, field: string): unknown[] {
  const result = asRecord(value)[field];
  if (!Array.isArray(result)) throw new Error(`Expected array field: ${field}`);
  return result;
}

function numberField(value: unknown, field: string): number {
  const result = asRecord(value)[field];
  if (typeof result !== "number") throw new Error(`Expected number field: ${field}`);
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Expected an object response");
  return value as Record<string, unknown>;
}

function assertDevelopmentDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for platform settings tests");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//u, "");
  if (databaseName !== "dev_xhs_agentic") {
    throw new Error(`Refusing to run integration tests against database: ${databaseName}`);
  }
}

function testPhone(index: number): string {
  const digits = Date.now().toString().slice(-7);
  return `199${digits}${index}`;
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (!value) throw new Error(`Expected test fixture at index ${index}`);
  return value;
}

function p014AcceptanceReport(input: { endpoint: string; providerCode: string }) {
  return {
    accepted: true,
    approvedPolicy: {
      imageSimilarityThreshold: 0.8,
      manualReviewMargin: 0.08,
      policyVersion: "xhs-public-v1",
      requireImageMatch: true,
      textSimilarityThreshold: 0.72,
    },
    automatedGatePassed: true,
    benchmarkId: `p014-production-${randomUUID()}`,
    checkedAt: new Date().toISOString(),
    errors: [],
    evidenceHashes: {
      manifestSha256: "a".repeat(64),
      manualReviewSha256: "b".repeat(64),
      reportSha256: "c".repeat(64),
      resultsSha256: "d".repeat(64),
    },
    manualReview: {
      accepted: true,
      approvedPolicyVersion: "xhs-public-v1",
      errors: [],
      failed: 0,
      passed: 30,
      reviewedAt: new Date().toISOString(),
      reviewer: "Integration Reviewer",
      total: 30,
    },
    provider: {
      declaredName: "Production Publication Vendor",
      endpoint: input.endpoint,
      runtimeCode: input.providerCode,
    },
    schemaVersion: 1,
    scoringProfileVersion: PUBLICATION_SCORING_PROFILE_VERSION,
    synthetic: false,
  } as const;
}
