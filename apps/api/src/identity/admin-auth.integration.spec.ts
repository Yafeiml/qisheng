import DysmsClient, { SendSmsResponse, SendSmsResponseBody } from "@alicloud/dysmsapi20170525";
import { AdminSmsService } from "./admin-sms.service";
import { hashPassword } from "./password";
import "reflect-metadata";

import { createHash, randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { AdminUser, PlatformSetting, Prisma, Role, Tenant } from "@xhs-agentic/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { platformAccessScope, tenantAccessScope } from "../access/access-scope";
import { AuthTokenService } from "../access/auth-token.service";
import { AuthorizationRepository } from "../access/authorization.repository";
import { seedAuthorizationCatalog } from "../access/authorization.seed";
import { AppModule } from "../app.module";
import { configureApplication } from "../configure-application";
import { PrismaService } from "../database/prisma.service";
import { NotificationMailer } from "../notifications/notification-mailer";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { seedPlatformSettings } from "../platform-settings/platform-settings.seed";
import { closeRedisClient, createLazyRedisClient } from "../redis/redis-client";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

type ApiResponse = Readonly<{
  body: unknown;
  headers: Headers;
  status: number;
}>;

describe("formal SaaS administrator authentication", { concurrent: false }, () => {
  const users: AdminUser[] = [];
  const employeeUserIds: string[] = [];
  const tenants: Tenant[] = [];
  let app: INestApplication;
  let authorization: AuthorizationRepository;
  let baseUrl: string;
  let platformRole: Role;
  let prisma: PrismaService;
  let tenantRole: Role;
  let restoreSmsConfiguration = () => {};

  beforeEach(() => {
    // Authentication fixtures must never inherit a real SMS sender from the local database.
    const configuration = vi.spyOn(AdminSmsService.prototype, "current").mockResolvedValue({
      mode: "DEVELOPMENT",
      delivery: "DEVELOPMENT_ADAPTER",
    });
    restoreSmsConfiguration = () => configuration.mockRestore();
    vi.spyOn(DysmsClient.prototype, "sendSmsWithOptions").mockRejectedValue(
      new Error("Real SMS delivery is disabled in authentication tests"),
    );
  });

  afterEach(() => vi.restoreAllMocks());

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
    authorization = app.get(AuthorizationRepository);
    await seedAuthorizationCatalog(prisma);
    await seedPlatformSettings(prisma);
    [platformRole, tenantRole] = await Promise.all([
      requireRole(prisma, "PLATFORM_ADMIN"),
      requireRole(prisma, "TENANT_ADMIN"),
    ]);
  });

  afterAll(async () => {
    if (!prisma) return;
    const userIds = users.map(({ id }) => id);
    await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.adminSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.roleBinding.deleteMany({ where: { userId: { in: userIds } } });
    const tenantIds = tenants.map(({ id }) => id);
    await prisma.enterpriseMembership.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenantCapabilityPolicy.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.enterprise.deleteMany({
      where: { tenantId: { in: tenants.map(({ id }) => id) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants.map(({ id }) => id) } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.globalUser.deleteMany({ where: { id: { in: employeeUserIds } } });
    await app.close();
  });

  it("rejects public registration and serves administrator-created employee accounts over HTTP", async () => {
    const username = `web-${randomUUID().slice(0, 8)}`;
    const password = "Http-password-2026";
    const rejected = await apiRequest("/auth/admin/register", {
      method: "POST",
      body: { username, password, name: "网页管理员", workspaceName: "不可自行创建的工作空间" },
    });
    expect(rejected.status).toBe(403);
    expect(await prisma.adminUser.findUnique({ where: { username } })).toBeNull();
    const owner = await prisma.adminUser.create({
      data: { username, passwordHash: await hashPassword(password), name: "网页管理员" },
    });
    users.push(owner);
    const tenant = await prisma.tenant.create({
      data: { name: `${username} workspace`, customerType: "SINGLE_ENTERPRISE" },
    });
    tenants.push(tenant);
    const enterprise = await prisma.enterprise.create({
      data: { tenantId: tenant.id, name: "网页测试企业", code: `web-${randomUUID()}` },
    });
    const enterpriseRole = await requireRole(prisma, "ENTERPRISE_ADMIN");
    await prisma.roleBinding.create({
      data: {
        userId: owner.id,
        roleId: enterpriseRole.id,
        scopeType: "ENTERPRISE",
        scopeId: enterprise.id,
        tenantId: tenant.id,
        enterpriseId: enterprise.id,
      },
    });
    const login = await apiRequest("/auth/admin/password-login", {
      method: "POST",
      body: { username, password },
    });
    expect(login.status).toBe(200);
    expect(JSON.stringify(login.body)).not.toContain(password);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    const membership = await prisma.enterpriseMembership.create({
      data: {
        tenantId: tenant.id,
        enterpriseId: enterprise.id,
        phone: uniquePhone(),
        name: "网页员工",
        seatStatus: "ENABLED",
        seatEnabledAt: new Date(),
      },
    });
    const created = await apiRequest(
      `/console/tenants/${tenant.id}/enterprises/${enterprise.id}/memberships/${membership.id}/web-account`,
      {
        method: "POST",
        token: stringField(login.body, "accessToken"),
        body: { username: `${username}-employee`, password },
      },
    );
    expect(created.status).toBe(200);
    expect(JSON.stringify(created.body)).not.toContain(password);
    const employee = await prisma.adminUser.findUniqueOrThrow({
      where: { username: `${username}-employee` },
    });
    users.push(employee);
    if (!employee.employeeUserId) throw new Error("Expected an employee identity");
    employeeUserIds.push(employee.employeeUserId);
    const employeeLogin = await apiRequest("/auth/admin/password-login", {
      method: "POST",
      body: { username: employee.username, password },
    });
    expect(employeeLogin.status).toBe(200);
    const webSession = await apiRequest("/auth/employee/web-session", {
      method: "POST",
      token: stringField(employeeLogin.body, "accessToken"),
    });
    expect(webSession.status).toBe(200);
    const employeeToken = stringField(webSession.body, "accessToken");
    expect((await apiRequest("/employee/tasks", { token: employeeToken })).status).toBe(200);
    await apiRequest("/auth/admin/logout", {
      method: "POST",
      cookie: cookiePair(employeeLogin),
    });
    expect((await apiRequest("/employee/tasks", { token: employeeToken })).status).toBe(401);
  });

  it("exchanges a password login for a revocable employee token without sending cookies", async () => {
    const username = `miniapp-${randomUUID().slice(0, 8)}`;
    const password = "Miniapp-password-2026";
    const identity = await prisma.globalUser.create({ data: {} });
    employeeUserIds.push(identity.id);
    const account = await prisma.adminUser.create({
      data: {
        username,
        passwordHash: await hashPassword(password),
        name: "小程序员工",
        employeeUserId: identity.id,
      },
    });
    users.push(account);
    const tenant = await prisma.tenant.create({
      data: { name: `${username} enterprise`, customerType: "SINGLE_ENTERPRISE" },
    });
    tenants.push(tenant);
    const enterprise = await prisma.enterprise.create({
      data: { tenantId: tenant.id, name: "小程序测试企业", code: username },
    });
    const membership = await prisma.enterpriseMembership.create({
      data: {
        tenantId: tenant.id,
        enterpriseId: enterprise.id,
        globalUserId: identity.id,
        phone: uniquePhone(),
        name: account.name ?? "小程序员工",
        status: "ACTIVE",
        seatStatus: "ENABLED",
        seatEnabledAt: new Date(),
        boundAt: new Date(),
      },
    });
    expect(identity.phone).toBeNull();
    expect(await prisma.roleBinding.count({ where: { userId: account.id } })).toBe(0);

    // Native requests intentionally ignore the refresh cookie returned by password login.
    const login = await apiRequest("/auth/admin/password-login", {
      method: "POST",
      body: { username, password },
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(asRecord(login.body)).not.toHaveProperty("refreshToken");
    const accountToken = stringField(login.body, "accessToken");
    const exchange = await apiRequest("/auth/employee/web-session", {
      method: "POST",
      token: accountToken,
    });
    expect(exchange.status).toBe(200);
    expect(asRecord(exchange.body)).toMatchObject({
      audience: "xhs-employee-miniapp",
      userId: identity.id,
      memberships: [{ membershipId: membership.id, enterpriseId: enterprise.id }],
    });
    const employeeToken = stringField(exchange.body, "accessToken");
    expect(app.get(AuthTokenService).verifyEmployeeAccessToken(employeeToken)).toEqual({
      sessionId: stringField(login.body, "sessionId"),
      userId: identity.id,
    });
    expect((await apiRequest("/employee/tasks", { token: employeeToken })).status).toBe(200);
    expect((await apiRequest("/employee/tasks", { token: accountToken })).status).toBe(401);
    expect(
      (await apiRequest("/auth/employee/web-session", { method: "POST", token: employeeToken }))
        .status,
    ).toBe(401);
    expect(DysmsClient.prototype.sendSmsWithOptions).not.toHaveBeenCalled();

    await prisma.adminSession.update({
      where: { id: stringField(login.body, "sessionId") },
      data: { revokedAt: new Date() },
    });
    expect((await apiRequest("/employee/tasks", { token: employeeToken })).status).toBe(401);
    expect(
      (await apiRequest("/auth/employee/web-session", { method: "POST", token: accountToken }))
        .status,
    ).toBe(401);
  });

  it("does not disclose whether an administrator phone exists when requesting a code", async () => {
    const response = await apiRequest("/auth/admin/request-code", {
      body: { phone: uniquePhone() },
      method: "POST",
    });

    expect(response.status).toBe(202);
    expect(asRecord(response.body)).toMatchObject({
      delivery: "DEVELOPMENT_ADAPTER",
      expiresInSeconds: 300,
    });
  });

  it("logs in with a one-time code and keeps the refresh token out of the response body", async () => {
    const administrator = await createPlatformAdministrator();
    const code = await requestDevelopmentCode(fixturePhone(administrator.phone));
    const login = await apiRequest("/auth/admin/login", {
      body: { code, phone: administrator.phone },
      method: "POST",
    });

    expect(login.status).toBe(200);
    expect(asRecord(login.body)).toMatchObject({
      audience: "xhs-saas-admin",
      tokenType: "Bearer",
    });
    expect(asRecord(login.body)).not.toHaveProperty("refreshToken");
    expect(login.headers.get("set-cookie")).toContain("xhs_admin_refresh=");
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("SameSite=Strict");

    const session = await apiRequest("/auth/admin/session", {
      token: stringField(login.body, "accessToken"),
    });
    expect(session.status).toBe(200);
    expect(asRecord(session.body)).toMatchObject({
      audience: "xhs-saas-admin",
      sessionId: stringField(login.body, "sessionId"),
      userId: administrator.id,
    });
    const persisted = await prisma.adminSession.findUnique({
      where: { id: stringField(login.body, "sessionId") },
    });
    expect(persisted?.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(persisted)).not.toContain(cookiePair(login));
  });

  it("lets every authenticated administrator read and maintain their own account", async () => {
    const administrator = await createPlatformAdministrator();
    await prisma.adminUser.update({
      data: { email: `${administrator.id}@example.test`, name: "个人中心测试管理员" },
      where: { id: administrator.id },
    });
    await prisma.adminOrganizationProfile.create({
      data: {
        department: "平台运营部",
        jobTitle: "值班管理员",
        scopeId: "platform",
        scopeType: "PLATFORM",
        userId: administrator.id,
      },
    });
    const login = await loginAdministrator(fixturePhone(administrator.phone));
    const token = stringField(login.body, "accessToken");

    const account = await apiRequest("/auth/admin/account", { token });
    expect(account.status).toBe(200);
    expect(asRecord(account.body)).toMatchObject({
      activeSessionCount: 1,
      email: `${administrator.id}@example.test`,
      id: administrator.id,
      loginMethod: "SMS_CODE",
      name: "个人中心测试管理员",
      phone: administrator.phone,
      scopes: [
        {
          department: "平台运营部",
          jobTitle: "值班管理员",
          roles: [{ code: "PLATFORM_ADMIN" }],
          scopeId: "platform",
          scopeType: "PLATFORM",
        },
      ],
    });

    const updated = await apiRequest("/auth/admin/account", {
      body: { email: `updated-${administrator.id}@example.test`, name: "已更新的个人姓名" },
      method: "PATCH",
      token,
    });
    expect(updated.status).toBe(200);
    expect(asRecord(updated.body)).toMatchObject({
      email: `updated-${administrator.id}@example.test`,
      name: "已更新的个人姓名",
    });
    await expect(
      prisma.adminUser.findUniqueOrThrow({ where: { id: administrator.id } }),
    ).resolves.toMatchObject({
      email: `updated-${administrator.id}@example.test`,
      name: "已更新的个人姓名",
    });
  });

  it("allows an optional email and verifies expiring, single-use verification links", async () => {
    const administrator = await createPlatformAdministrator();
    const login = await loginAdministrator(fixturePhone(administrator.phone));
    const token = stringField(login.body, "accessToken");
    for (const body of [
      { name: " ", email: "user@example.com" },
      { name: "姓名", email: "" },
    ]) {
      expect(
        (await apiRequest("/auth/admin/account", { method: "PATCH", token, body })).status,
      ).toBe(400);
    }
    expect(
      (await apiRequest("/auth/admin/account", { method: "PATCH", token, body: { name: "姓名" } }))
        .status,
    ).toBe(200);
    expect((await apiRequest("/auth/admin/account/email/status")).status).toBe(401);
    const initialStatus = await apiRequest("/auth/admin/account/email/status", { token });
    expect(initialStatus.status).toBe(200);
    expect(initialStatus.body).toEqual({ retryAfterSeconds: 0 });
    const email = `${administrator.id}@example.test`;
    const profile = { name: "邮箱验证测试", email };
    expect(
      (await apiRequest("/auth/admin/account", { method: "PATCH", token, body: profile })).status,
    ).toBe(200);
    mockEmailConfiguration();
    const sentTokens: string[] = [];
    const mail = vi
      .spyOn(NotificationMailer.prototype, "sendEmailVerification")
      .mockImplementation(async (config, link) => {
        expect(config.recipient).toBe(email);
        const url = new URL(link);
        expect(url.pathname).toBe("/verify-email");
        expect(url.search).toBe("");
        sentTokens.push(verificationToken(url.toString()));
        return undefined;
      });
    expect(
      (await apiRequest("/auth/admin/account/email/send", { method: "POST", body: {} })).status,
    ).toBe(401);
    expect(
      (await apiRequest("/auth/admin/account/email/send", { method: "POST", token, body: {} }))
        .status,
    ).toBe(200);
    const sendingStatus = await apiRequest("/auth/admin/account/email/status", { token });
    expect(sendingStatus.status).toBe(200);
    expect(asRecord(sendingStatus.body).retryAfterSeconds).toBeGreaterThan(0);
    expect(asRecord(sendingStatus.body).retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(
      (await apiRequest("/auth/admin/account/email/send", { method: "POST", token, body: {} }))
        .status,
    ).toBe(429);
    expect(mail).toHaveBeenCalledTimes(1);
    const firstToken = sentTokens[0];
    if (!firstToken) throw new Error("Expected verification email");
    const stored = await prisma.adminUser.findUniqueOrThrow({ where: { id: administrator.id } });
    expect(stored.emailVerificationTokenHash).toBe(
      createHash("sha256").update(firstToken).digest("hex"),
    );
    const confirmations = await Promise.all(
      [1, 2].map(() =>
        apiRequest("/auth/admin/email/confirm", { method: "POST", body: { token: sentTokens[0] } }),
      ),
    );
    expect(confirmations.map((result) => result.status).sort()).toEqual([200, 400]);
    expect((await apiRequest("/auth/admin/account", { token })).body).toMatchObject({
      email,
      emailVerifiedAt: expect.any(String),
    });
    const unchanged = await apiRequest("/auth/admin/account", {
      method: "PATCH",
      token,
      body: { ...profile, name: "新姓名" },
    });
    expect(unchanged.body).toMatchObject({ emailVerifiedAt: expect.any(String) });
    const changed = await apiRequest("/auth/admin/account", {
      method: "PATCH",
      token,
      body: { ...profile, email: `new-${email}` },
    });
    expect(changed.body).toMatchObject({ emailVerifiedAt: null });
    const tokenHash = createHash("sha256").update(firstToken).digest("hex");
    await prisma.adminUser.update({
      where: { id: administrator.id },
      data: {
        emailVerificationTokenHash: tokenHash,
        emailVerificationExpiresAt: new Date(Date.now() - 1000),
      },
    });
    expect(
      (
        await apiRequest("/auth/admin/email/confirm", {
          method: "POST",
          body: { token: sentTokens[0] },
        })
      ).status,
    ).toBe(400);
    await prisma.adminUser.update({
      where: { id: administrator.id },
      data: { emailVerificationExpiresAt: new Date(Date.now() + 60_000) },
    });
    await apiRequest("/auth/admin/account", { method: "PATCH", token, body: profile });
    expect(
      (
        await apiRequest("/auth/admin/email/confirm", {
          method: "POST",
          body: { token: sentTokens[0] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await apiRequest("/auth/admin/email/confirm", {
          method: "POST",
          body: { token: "invalid" },
        })
      ).status,
    ).toBe(400);
  });

  it("keeps email send budgets atomic across instances and email changes, and invalidates replaced links", async () => {
    const administrator = await createPlatformAdministrator();
    const login = await loginAdministrator(fixturePhone(administrator.phone));
    const token = stringField(login.body, "accessToken");
    await apiRequest("/auth/admin/account", {
      method: "PATCH",
      token,
      body: { name: "限流测试", email: `${administrator.id}@example.test` },
    });
    mockEmailConfiguration();
    const tokens: string[] = [];
    vi.spyOn(NotificationMailer.prototype, "sendEmailVerification").mockImplementation(
      async (_, link) => {
        tokens.push(verificationToken(link));
      },
    );
    const redis = createLazyRedisClient("email-verification-test");
    const cooldown = `${process.env.REDIS_PREFIX}:identity:email-verification:cooldown:${createHash("sha256").update(administrator.id).digest("hex")}`;
    try {
      const concurrent = await Promise.all(
        [1, 2].map(() =>
          apiRequest("/auth/admin/account/email/send", { method: "POST", token, body: {} }),
        ),
      );
      expect(concurrent.map((response) => response.status).sort()).toEqual([200, 429]);
      await redis.del(cooldown);
      expect(
        (await apiRequest("/auth/admin/account/email/send", { method: "POST", token, body: {} }))
          .status,
      ).toBe(200);
      expect(
        (
          await apiRequest("/auth/admin/email/confirm", {
            method: "POST",
            body: { token: tokens[0] },
          })
        ).status,
      ).toBe(400);
      await redis.del(cooldown);
      await apiRequest("/auth/admin/account", {
        method: "PATCH",
        token,
        body: { name: "限流测试", email: `new-${administrator.id}@example.test` },
      });
      expect(
        (await apiRequest("/auth/admin/account/email/send", { method: "POST", token, body: {} }))
          .status,
      ).toBe(200);
      await redis.del(cooldown);
      expect(
        (await apiRequest("/auth/admin/account/email/send", { method: "POST", token, body: {} }))
          .status,
      ).toBe(429);
      expect(tokens).toHaveLength(3);
    } finally {
      await closeRedisClient(redis);
    }
  });

  it("invalidates failed deliveries, retains their cooldown and refuses verification for disabled accounts", async () => {
    const administrator = await createPlatformAdministrator();
    const login = await loginAdministrator(fixturePhone(administrator.phone));
    const token = stringField(login.body, "accessToken");
    await apiRequest("/auth/admin/account", {
      method: "PATCH",
      token,
      body: { name: "发信失败测试", email: `${administrator.id}@example.test` },
    });
    mockEmailConfiguration();
    let emailedToken = "";
    vi.spyOn(NotificationMailer.prototype, "sendEmailVerification").mockImplementation(
      async (_, link) => {
        emailedToken = verificationToken(link);
        throw new Error("SMTP test failure");
      },
    );
    const failed = await apiRequest("/auth/admin/account/email/send", {
      method: "POST",
      token,
      body: {},
    });
    expect(failed.status).toBe(503);
    expect(failed.body).toMatchObject({
      code: "ADMIN_EMAIL_DELIVERY_FAILED",
      details: { retryAfterSeconds: expect.any(Number) },
    });
    expect(asRecord(asRecord(failed.body).details).retryAfterSeconds).toBeGreaterThan(0);
    expect((await apiRequest("/auth/admin/account/email/status", { token })).body).toMatchObject({
      retryAfterSeconds: expect.any(Number),
    });
    expect(
      (await prisma.adminUser.findUniqueOrThrow({ where: { id: administrator.id } }))
        .emailVerificationTokenHash,
    ).toBeNull();
    expect(
      (
        await apiRequest("/auth/admin/email/confirm", {
          method: "POST",
          body: { token: emailedToken },
        })
      ).status,
    ).toBe(400);
    expect(
      (await apiRequest("/auth/admin/account/email/send", { method: "POST", token, body: {} }))
        .status,
    ).toBe(429);
    await prisma.adminUser.update({
      where: { id: administrator.id },
      data: {
        status: "DISABLED",
        emailVerificationTokenHash: createHash("sha256").update(emailedToken).digest("hex"),
        emailVerificationExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(
      (
        await apiRequest("/auth/admin/email/confirm", {
          method: "POST",
          body: { token: emailedToken },
        })
      ).status,
    ).toBe(400);
  });

  it("rotates refresh tokens and revokes the session when an old token is replayed", async () => {
    const administrator = await createPlatformAdministrator();
    const login = await loginAdministrator(fixturePhone(administrator.phone));
    const originalCookie = cookiePair(login);
    const refresh = await apiRequest("/auth/admin/refresh", {
      cookie: originalCookie,
      method: "POST",
    });

    expect(refresh.status).toBe(200);
    expect(cookiePair(refresh)).not.toBe(originalCookie);
    const replay = await apiRequest("/auth/admin/refresh", {
      cookie: originalCookie,
      method: "POST",
    });
    expect(replay.status).toBe(401);

    const accessAfterReplay = await apiRequest("/auth/admin/session", {
      token: stringField(refresh.body, "accessToken"),
    });
    expect(accessAfterReplay.status).toBe(401);
    await expect(
      prisma.adminSession.findUnique({
        select: { revokeReason: true, revokedAt: true },
        where: { id: stringField(login.body, "sessionId") },
      }),
    ).resolves.toMatchObject({
      revokeReason: "REFRESH_REPLAY_OR_INVALID",
      revokedAt: expect.any(Date),
    });
  });

  it("revokes a session on logout and clears its HttpOnly cookie", async () => {
    const administrator = await createPlatformAdministrator();
    const login = await loginAdministrator(fixturePhone(administrator.phone));
    const logout = await apiRequest("/auth/admin/logout", {
      cookie: cookiePair(login),
      method: "POST",
    });

    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    const denied = await apiRequest("/auth/admin/session", {
      token: stringField(login.body, "accessToken"),
    });
    expect(denied.status).toBe(401);
  });

  it("invalidates an existing formal session as soon as its last RoleBinding is removed", async () => {
    const administrator = await createPlatformAdministrator();
    const login = await loginAdministrator(fixturePhone(administrator.phone));
    await prisma.roleBinding.deleteMany({ where: { userId: administrator.id } });

    const denied = await apiRequest("/auth/admin/session", {
      token: stringField(login.body, "accessToken"),
    });
    expect(denied.status).toBe(401);
  });

  it("keeps a formally authenticated tenant administrator out of platform routes", async () => {
    const tenant = await prisma.tenant.create({
      data: { customerType: "GROUP", name: `正式登录租户 ${Date.now()}` },
    });
    tenants.push(tenant);
    await prisma.enterprise.create({
      data: {
        code: `AUTH_${randomInt(100_000, 1_000_000)}`,
        name: "正式登录作用域企业",
        tenantId: tenant.id,
      },
    });
    const administrator = await prisma.adminUser.create({
      data: { phone: uniquePhone(), phoneVerifiedAt: new Date() },
    });
    users.push(administrator);
    await authorization.createRoleBinding(platformAccessScope(), {
      roleId: tenantRole.id,
      targetScope: tenantAccessScope(tenant.id),
      userId: administrator.id,
    });
    const login = await loginAdministrator(fixturePhone(administrator.phone));
    const token = stringField(login.body, "accessToken");

    const ownTenant = await apiRequest(`/console/tenants/${tenant.id}/enterprises`, { token });
    const platform = await apiRequest("/platform/tenants", { token });
    expect(ownTenant.status).toBe(200);
    expect(platform.status).toBe(403);
  });

  it("does not issue a SaaS session to a user without a backend RoleBinding", async () => {
    const employeeOnly = await prisma.globalUser.create({
      data: { phone: uniquePhone(), phoneVerifiedAt: new Date() },
    });
    employeeUserIds.push(employeeOnly.id);
    const code = await requestDevelopmentCode(fixturePhone(employeeOnly.phone));
    const denied = await apiRequest("/auth/admin/login", {
      body: { code, phone: employeeOnly.phone },
      method: "POST",
    });

    expect(denied.status).toBe(401);
    await expect(prisma.adminSession.count({ where: { userId: employeeOnly.id } })).resolves.toBe(
      0,
    );
  });

  it("uses the platform-managed HTTP SMS gateway with a random one-time code", async () => {
    const settingKeys = [
      "security.admin_sms_api_key",
      "security.admin_sms_endpoint",
      "security.admin_sms_mode",
      "security.admin_sms_provider",
      "security.admin_sms_sender",
      "security.admin_sms_template_id",
    ] as const;
    const originalSettings = await prisma.platformSetting.findMany({
      where: { key: { in: [...settingKeys] } },
    });
    const gateway = await startSmsGateway();
    const apiKey = `sms-${randomUUID()}`;
    const administrator = await createPlatformAdministrator();
    const platformLogin = await loginAdministrator(fixturePhone(administrator.phone));
    const platformToken = stringField(platformLogin.body, "accessToken");
    const smsAdministrator = await createPlatformAdministrator();
    try {
      for (const [key, value] of [
        ["security.admin_sms_api_key", apiKey],
        ["security.admin_sms_endpoint", gateway.endpoint],
        ["security.admin_sms_provider", "LOCAL_SMS_TEST"],
        ["security.admin_sms_sender", "小红书营销助手"],
        ["security.admin_sms_template_id", "ADMIN_LOGIN_V1"],
        ["security.admin_sms_mode", "HTTP"],
      ] as const) {
        const response = await apiRequest(`/platform/settings/${key}`, {
          body: { reason: "验证管理员正式短信登录适配器", value },
          method: "POST",
          token: platformToken,
        });
        expect(response.status).toBe(200);
        expect(JSON.stringify(response.body)).not.toContain(apiKey);
      }

      // The settings above now point exclusively to this test's local HTTP gateway.
      restoreSmsConfiguration();
      const requested = await apiRequest("/auth/admin/request-code", {
        body: { phone: smsAdministrator.phone },
        method: "POST",
      });
      expect(requested.status).toBe(202);
      expect(asRecord(requested.body)).toMatchObject({ delivery: "HTTP_SMS_GATEWAY" });
      expect(asRecord(requested.body)).not.toHaveProperty("developmentCode");
      expect(gateway.requests).toHaveLength(1);
      const delivered = JSON.parse(gateway.requests[0]?.body ?? "{}") as Record<string, unknown>;
      expect(gateway.requests[0]?.authorization).toBe(`Bearer ${apiKey}`);
      expect(delivered.phone).toBe(smsAdministrator.phone);
      expect(delivered.code).toMatch(/^\d{6}$/u);
      expect(delivered.code).not.toBe("000000");

      const login = await apiRequest("/auth/admin/login", {
        body: { code: delivered.code, phone: smsAdministrator.phone },
        method: "POST",
      });
      expect(login.status).toBe(200);
      const deliveryAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: "admin-auth.code-delivered",
          resourceId: createHash("sha256")
            .update(fixturePhone(smsAdministrator.phone))
            .digest("hex"),
        },
      });
      expect(JSON.stringify(deliveryAudit)).not.toContain(apiKey);
      expect(JSON.stringify(deliveryAudit)).not.toContain(String(delivered.code));
    } finally {
      await restorePlatformSettings(prisma, settingKeys, originalSettings);
      await prisma.auditLog.deleteMany({
        where: {
          action: "admin-auth.code-delivered",
          resourceId: createHash("sha256")
            .update(fixturePhone(smsAdministrator.phone))
            .digest("hex"),
        },
      });
      await gateway.close();
    }
  });

  it("uses Aliyun login codes once and permits retry after delivery fails", async () => {
    const administrator = await createPlatformAdministrator();
    const current = vi.spyOn(AdminSmsService.prototype, "current").mockResolvedValue({
      mode: "ALIYUN",
      delivery: "ALIYUN_SMS",
      accessKeyId: "LTAI-test-access",
      accessKeySecret: "test-sms-private-key",
      signName: "测试签名",
      templateCode: "SMS_123456",
    });
    const codes: string[] = [];
    const send = vi
      .spyOn(DysmsClient.prototype, "sendSmsWithOptions")
      .mockImplementation(async (request) => {
        codes.push(JSON.parse(request.templateParam ?? "{}").code);
        return new SendSmsResponse({
          body: new SendSmsResponseBody({
            code: codes.length === 1 ? "isv.BUSINESS_LIMIT_CONTROL" : "OK",
            bizId: "aliyun-test-message",
            requestId: "aliyun-test-request",
          }),
        });
      });
    try {
      const failed = await apiRequest("/auth/admin/request-code", {
        body: { phone: administrator.phone },
        method: "POST",
      });
      expect(failed.status).toBe(503);
      const requested = await apiRequest("/auth/admin/request-code", {
        body: { phone: administrator.phone },
        method: "POST",
      });
      expect(requested.status).toBe(202);
      expect(requested.body).toMatchObject({ delivery: "ALIYUN_SMS" });
      expect(requested.body).not.toHaveProperty("developmentCode");
      expect(send).toHaveBeenCalledTimes(2);
      const login = await apiRequest("/auth/admin/login", {
        body: { code: codes[1], phone: administrator.phone },
        method: "POST",
      });
      expect(login.status).toBe(200);
      const replay = await apiRequest("/auth/admin/login", {
        body: { code: codes[1], phone: administrator.phone },
        method: "POST",
      });
      expect(replay.status).toBe(401);
    } finally {
      current.mockRestore();
      send.mockRestore();
      await prisma.auditLog.deleteMany({
        where: {
          action: "admin-auth.code-delivered",
          resourceId: createHash("sha256").update(fixturePhone(administrator.phone)).digest("hex"),
        },
      });
    }
  });

  function mockEmailConfiguration() {
    const settings = app.get(PlatformSettingsReader);
    const originalResolve = settings.resolveMany.bind(settings);
    vi.spyOn(settings, "resolveMany").mockImplementation(async (keys, client) => {
      if (!keys.every((key) => key.startsWith("notification.")))
        return originalResolve(keys, client);
      return new Map(
        keys.map((key) => [
          key,
          {
            value: key.endsWith("smtp_sender")
              ? "sender@example.test"
              : key.endsWith("smtp_password")
                ? "test-only"
                : "",
            configured: true,
            source: "DATABASE" as const,
            lastFour: null,
            updatedAt: null,
            updatedBy: null,
            version: 1,
          },
        ]),
      );
    });
  }

  async function createPlatformAdministrator(): Promise<AdminUser> {
    const administrator = await prisma.adminUser.create({
      data: { phone: uniquePhone(), phoneVerifiedAt: new Date() },
    });
    users.push(administrator);
    await authorization.createRoleBinding(platformAccessScope(), {
      roleId: platformRole.id,
      targetScope: platformAccessScope(),
      userId: administrator.id,
    });
    return administrator;
  }

  async function requestDevelopmentCode(phone: string): Promise<string> {
    const response = await apiRequest("/auth/admin/request-code", {
      body: { phone },
      method: "POST",
    });
    expect(response.status).toBe(202);
    return stringField(response.body, "developmentCode");
  }

  async function loginAdministrator(phone: string): Promise<ApiResponse> {
    const code = await requestDevelopmentCode(phone);
    const response = await apiRequest("/auth/admin/login", {
      body: { code, phone },
      method: "POST",
    });
    expect(response.status).toBe(200);
    return response;
  }

  async function apiRequest(
    path: string,
    options: Readonly<{
      body?: unknown;
      cookie?: string;
      method?: "GET" | "PATCH" | "POST";
      token?: string;
    }> = {},
  ): Promise<ApiResponse> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.cookie) headers.set("cookie", options.cookie);
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (options.method && options.method !== "GET") {
      headers.set("idempotency-key", randomUUID());
    }
    const response = await fetch(`${baseUrl}${path}`, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method: options.method ?? "GET",
    });
    const text = await response.text();
    return {
      body: text ? JSON.parse(text) : null,
      headers: response.headers,
      status: response.status,
    };
  }
});

async function startSmsGateway(): Promise<{
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
      response.end(JSON.stringify({ messageId: `message-${requests.length}`, status: "ACCEPTED" }));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SMS test gateway failed");
  return {
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    endpoint: `http://127.0.0.1:${address.port}/v1/messages`,
    requests,
  };
}

async function restorePlatformSettings(
  prisma: PrismaService,
  keys: readonly string[],
  originals: readonly PlatformSetting[],
): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: { in: [...keys] } } });
  for (const setting of originals) {
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

function cookiePair(response: ApiResponse): string {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!value) throw new Error("Expected administrator refresh cookie");
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object response");
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, key: string): string {
  const field = asRecord(value)[key];
  if (typeof field !== "string") throw new Error(`Expected string field: ${key}`);
  return field;
}

function uniquePhone(): string {
  return `139${randomInt(10_000_000, 100_000_000)}`;
}

async function requireRole(prisma: PrismaService, code: string): Promise<Role> {
  const role = await prisma.role.findUnique({ where: { code } });
  if (!role) throw new Error(`${code} role is required`);
  return role;
}

function assertDevelopmentDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl.includes("dev_xhs_agentic")) {
    throw new Error("Administrator authentication tests require dev_xhs_agentic");
  }
  if (process.env.ENABLE_DEV_AUTH !== "true" || process.env.NODE_ENV === "production") {
    throw new Error(`${markerForError()} requires development authentication`);
  }
}

function markerForError(): string {
  return "Formal administrator authentication integration suite";
}

function verificationToken(link: string): string {
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
  if (!token) throw new Error("Missing verification token");
  return token;
}

function fixturePhone(phone: string | null): string {
  if (!phone) throw new Error("Expected a phone-based fixture");
  return phone;
}
