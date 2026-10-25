import "reflect-metadata";

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type INestApplication, Module } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { WechatMiniappClient, WechatMiniappError } from "@xhs-agentic/wechat-miniapp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessModule } from "../access/access.module";
import { AuthTokenService } from "../access/auth-token.service";
import { configureApplication } from "../configure-application";
import { PrismaModule } from "../database/prisma.module";
import { PrismaService } from "../database/prisma.service";
import { IdempotencyInterceptor } from "../http/idempotency.interceptor";
import { IdempotencyService } from "../http/idempotency.service";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { EmployeeNotificationsController } from "./employee-notifications.controller";
import { EmployeeNotificationsService } from "./employee-notifications.service";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

const APP_A = "wx1111111111111111";
const APP_B = "wx0123456789abcdef";
const SECRET = "a".repeat(32);
const TEMPLATE = "template_new_task_fixture";
const gateway = {
  exchangeCode: vi.fn<WechatMiniappClient["exchangeCode"]>(),
  sendSubscription: vi.fn<WechatMiniappClient["sendSubscription"]>(),
};
let enabled = true;
let configuredAppId = APP_A;
const settingsReader = {
  resolveMany: vi.fn(
    async () =>
      new Map<string, { value: unknown }>([
        ["miniapp.wechat_app_id", { value: configuredAppId }],
        ["miniapp.wechat_app_secret", { value: SECRET }],
        ["notification.enabled", { value: enabled }],
        ["notification.channel", { value: "WECHAT_TEMPLATE" }],
        ["notification.wechat_template_id", { value: TEMPLATE }],
        [
          "notification.wechat_template_fields",
          { value: '{"thing1":"TASK_TITLE","time2":"VISIBLE_AT"}' },
        ],
        ["notification.wechat_environment", { value: "trial" }],
      ]),
  ),
};

// Real request guards, validation and persistence; provider/settings are isolated test fixtures.
@Module({
  imports: [PrismaModule, AccessModule],
  controllers: [EmployeeNotificationsController],
  providers: [
    EmployeeNotificationsService,
    IdempotencyService,
    { provide: PlatformSettingsReader, useValue: settingsReader },
    { provide: WechatMiniappClient, useValue: gateway },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
class EmployeeNotificationsTestModule {}

type EmployeeFixture = { id: string; token: string; openId: string };
type HttpResult = { status: number; body: Record<string, unknown>; headers: Headers };

describe("employee new-task notification API", { concurrent: false }, () => {
  const marker = `notification-api-${randomUUID()}`;
  const userIds: string[] = [];
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AuthTokenService;
  let baseUrl: string;
  let tenantId: string;
  let enterpriseId: string;
  let employee: EmployeeFixture;

  beforeAll(async () => {
    assertDevelopmentDatabase();
    app = await NestFactory.create(EmployeeNotificationsTestModule, {
      abortOnError: false,
      bodyParser: false,
      logger: false,
    });
    configureApplication(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);
    const tenant = await prisma.tenant.create({ data: { customerType: "GROUP", name: marker } });
    tenantId = tenant.id;
    const enterprise = await prisma.enterprise.create({
      data: { tenantId, name: `${marker}-enterprise`, code: `NOTIFY_${randomUUID()}` },
    });
    enterpriseId = enterprise.id;
  }, 30_000);

  beforeEach(async () => {
    enabled = true;
    configuredAppId = APP_A;
    gateway.exchangeCode.mockReset();
    gateway.sendSubscription.mockReset();
    employee = await createEmployee();
    gateway.exchangeCode.mockResolvedValue({
      openId: employee.openId,
      unionId: `union_${employee.id}`,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (!prisma) {
      await app?.close();
      return;
    }
    try {
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
      await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: userIds } } });
      // Identities, subscription quotas and request ledgers cascade from fixture users only.
      if (tenantId) await prisma.enterpriseMembership.deleteMany({ where: { tenantId } });
      await prisma.globalUser.deleteMany({ where: { id: { in: userIds } } });
      if (tenantId) {
        await prisma.enterprise.deleteMany({ where: { tenantId } });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      }
    } finally {
      await app.close();
    }
  });

  it("returns disabled configuration without credentials and refuses identity/subscription mutations", async () => {
    enabled = false;
    const configuration = await request("configuration");
    expect(configuration.status).toBe(200);
    expect(configuration.body).toEqual({
      enabled: false,
      appId: null,
      templateId: null,
      identityLinked: false,
      identityVersion: null,
      authorizationGeneration: null,
      remainingSubscriptions: 0,
      subscriptionStatus: "NONE",
    });
    expect(JSON.stringify(configuration.body)).not.toContain(SECRET);
    expect(configuration.body).not.toHaveProperty("appSecret");
    const identity = await request("identity", { body: { code: "fixture-login-code" } });
    const subscription = await request("subscriptions", {
      body: {
        templateId: TEMPLATE,
        status: "accept",
        identityVersion: 1,
        authorizationGeneration: 1,
      },
    });
    expect(identity.status).toBe(409);
    expect(subscription.status).toBe(409);
    expect(gateway.exchangeCode).not.toHaveBeenCalled();
    expect(await prisma.wechatMiniappIdentity.count({ where: { userId: employee.id } })).toBe(0);
  });

  it("exchanges the wx login code server-side, exposes only public configuration and preserves repeated identity links", async () => {
    const result = await request("identity", { body: { code: "fixture-login-code" } });
    expect(result.status).toBe(200);
    expect(gateway.exchangeCode).toHaveBeenCalledWith({
      appId: APP_A,
      appSecret: SECRET,
      code: "fixture-login-code",
    });
    expect(result.body).toMatchObject({
      enabled: true,
      appId: APP_A,
      templateId: TEMPLATE,
      identityLinked: true,
      identityVersion: 1,
      authorizationGeneration: 1,
    });
    expect(JSON.stringify(result.body)).not.toContain(SECRET);
    expect(result.body).not.toHaveProperty("openId");
    expect(result.body).not.toHaveProperty("unionId");
    const linked = await identityFor(employee.id, APP_A);
    expect(linked).toMatchObject({ appId: APP_A, openId: employee.openId, version: 1 });
    await accept("initial-subscribe-key");
    const repeated = await request("identity", { body: { code: "another-wx-login-code" } });
    expect(repeated.status).toBe(200);
    expect(repeated.body.remainingSubscriptions).toBe(1);
    expect((await identityFor(employee.id, APP_A))?.version).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { actorUserId: employee.id, action: "employee.wechat-identity.link" },
      }),
    ).toBe(1);
  });

  it("does not accept client-supplied OpenID and hides provider exchange error details", async () => {
    const forged = await request("identity", {
      body: { code: "fixture-login-code", openId: "forged-recipient" },
    });
    expect(forged.status).toBe(400);
    expect(gateway.exchangeCode).not.toHaveBeenCalled();
    gateway.exchangeCode.mockRejectedValueOnce(new WechatMiniappError("40029", "PERMANENT"));
    const failed = await request("identity", { body: { code: "invalid-wx-login-code" } });
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed.body)).toContain("WECHAT_IDENTITY_EXCHANGE_FAILED");
    expect(JSON.stringify(failed.body)).not.toContain(SECRET);
    expect(await identityFor(employee.id, APP_A)).toBeNull();
  });

  it("refuses another employee's OpenID in the same app while permitting the same OpenID in another app", async () => {
    await link();
    const other = await createEmployee();
    gateway.exchangeCode.mockResolvedValue({ openId: employee.openId });
    const collision = await request("identity", {
      token: other.token,
      body: { code: "other-wx-code" },
    });
    expect(collision.status).toBe(409);
    expect(await identityFor(other.id, APP_A)).toBeNull();
    configuredAppId = APP_B;
    const separateApp = await request("identity", {
      token: other.token,
      body: { code: "separate-app-code" },
    });
    expect(separateApp.status).toBe(200);
    expect(await identityFor(other.id, APP_B)).toMatchObject({
      userId: other.id,
      openId: employee.openId,
      appId: APP_B,
    });
    expect(await identityFor(employee.id, APP_A)).toMatchObject({
      userId: employee.id,
      openId: employee.openId,
      appId: APP_A,
    });
  });

  it("increments a subscription once per authorization request, replays safely and rejects key reuse with a different status", async () => {
    await link();
    const initial = await accept("same-authorization-request");
    const replay = await accept("same-authorization-request");
    expect(initial.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.body.remainingSubscriptions).toBe(1);
    expect(await subscriptionFor(employee.id)).toMatchObject({
      remainingSubscriptions: 1,
      status: "ACCEPT",
      version: 2,
    });
    const collision = await request("subscriptions", {
      idempotencyKey: "same-authorization-request",
      body: {
        templateId: TEMPLATE,
        status: "reject",
        identityVersion: 1,
        authorizationGeneration: 1,
      },
    });
    expect(collision.status).toBe(409);
    expect((await subscriptionFor(employee.id))?.remainingSubscriptions).toBe(1);
    expect(
      await prisma.employeeSubscriptionRequest.count({
        where: { identity: { userId: employee.id } },
      }),
    ).toBe(1);
  });

  it("does not grant a second consent after subscription commit succeeds but response persistence is lost", async () => {
    await link();
    const completion = vi
      .spyOn(IdempotencyService.prototype, "complete")
      .mockRejectedValueOnce(new Error("simulated response storage failure after commit"));
    const interrupted = await accept("recover-committed-subscription");
    expect(interrupted.status).toBe(500);
    expect((await subscriptionFor(employee.id))?.remainingSubscriptions).toBe(1);
    completion.mockRestore();
    const retried = await accept("recover-committed-subscription");
    expect(retried.status).toBe(200);
    expect(retried.body.remainingSubscriptions).toBe(1);
    expect(
      await prisma.employeeSubscriptionRequest.count({
        where: { identity: { userId: employee.id } },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { actorUserId: employee.id, action: "employee.notification.subscribe" },
      }),
    ).toBe(1);
  });

  it("refuses a pending authorization for the previous WeChat identity but safely replays an already committed request", async () => {
    const linked = await link();
    expect(linked.body.identityVersion).toBe(1);
    const responseLost = vi
      .spyOn(IdempotencyService.prototype, "complete")
      .mockRejectedValueOnce(new Error("simulated committed v1 authorization with response lost"));
    const committedV1 = await accept("committed-v1-authorization", 1, 1);
    expect(committedV1.status).toBe(500);
    expect((await subscriptionFor(employee.id))?.remainingSubscriptions).toBe(1);
    responseLost.mockRestore();

    // A second device signs into the same employee account with another WeChat identity.
    gateway.exchangeCode.mockResolvedValue({ openId: `second_device_${employee.id}` });
    const switched = await request("identity", { body: { code: "device-b-login-code" } });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({ identityVersion: 2, remainingSubscriptions: 0 });

    // Device A never saved this authorization and retries its old, uncommitted result.
    const stale = await accept("pending-v1-authorization", 1);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("WECHAT_NOTIFICATION_IDENTITY_CHANGED");
    expect((await subscriptionFor(employee.id))?.remainingSubscriptions).toBe(0);
    expect(
      await prisma.employeeSubscriptionRequest.count({
        where: { identity: { userId: employee.id } },
      }),
    ).toBe(1);

    // The earlier committed v1 key remains a no-op even without an interceptor receipt.
    const replay = await accept("committed-v1-authorization", 1, 1);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ identityVersion: 2, remainingSubscriptions: 0 });
    const current = await accept("current-v2-authorization", 2);
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ identityVersion: 2, remainingSubscriptions: 1 });

    // A delayed refusal from device A must not remove device B's current authorization.
    const staleRefusal = await request("subscriptions", {
      body: {
        templateId: TEMPLATE,
        status: "reject",
        identityVersion: 1,
        authorizationGeneration: 1,
      },
    });
    expect(staleRefusal.status).toBe(409);
    expect(staleRefusal.body.code).toBe("WECHAT_NOTIFICATION_IDENTITY_CHANGED");
    expect((await subscriptionFor(employee.id))?.remainingSubscriptions).toBe(1);
    expect(
      await prisma.employeeSubscriptionRequest.count({
        where: { identity: { userId: employee.id } },
      }),
    ).toBe(2);
  });

  it.each([undefined, 0, -1, 1.5, "1"])(
    "requires a positive integer identity version, rejecting %j",
    async (identityVersion) => {
      await link();
      const result = await request("subscriptions", {
        body: {
          templateId: TEMPLATE,
          status: "accept",
          authorizationGeneration: 1,
          ...(identityVersion === undefined ? {} : { identityVersion }),
        },
      });
      expect(result.status).toBe(400);
      expect(await subscriptionFor(employee.id)).toBeNull();
      expect(
        await prisma.employeeSubscriptionRequest.count({
          where: { identity: { userId: employee.id } },
        }),
      ).toBe(0);
    },
  );

  it("rejects results from a revoked authorization generation, accepts the current generation and preserves committed replay", async () => {
    const initialConfiguration = await link();
    expect(initialConfiguration.body.authorizationGeneration).toBe(1);
    const responseLost = vi
      .spyOn(IdempotencyService.prototype, "complete")
      .mockRejectedValueOnce(
        new Error("simulated committed generation-1 result with response lost"),
      );
    const committed = await accept("committed-generation-1", 1, 1);
    expect(committed.status).toBe(500);
    responseLost.mockRestore();
    const revoked = await request("subscriptions", {
      body: {
        templateId: TEMPLATE,
        status: "reject",
        identityVersion: 1,
        authorizationGeneration: 1,
      },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({
      identityVersion: 1,
      authorizationGeneration: 2,
      remainingSubscriptions: 0,
    });

    for (const status of ["accept", "reject"] as const) {
      const stale = await request("subscriptions", {
        body: { templateId: TEMPLATE, status, identityVersion: 1, authorizationGeneration: 1 },
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("WECHAT_NOTIFICATION_AUTHORIZATION_CHANGED");
      expect(await subscriptionFor(employee.id)).toMatchObject({
        remainingSubscriptions: 0,
        authorizationGeneration: 2,
        status: "REJECT",
      });
    }
    const current = await accept("current-generation-2", 1, 2);
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ authorizationGeneration: 2, remainingSubscriptions: 1 });
    const replay = await accept("committed-generation-1", 1, 1);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ authorizationGeneration: 2, remainingSubscriptions: 1 });
    expect(
      await prisma.employeeSubscriptionRequest.count({
        where: { identity: { userId: employee.id } },
      }),
    ).toBe(3);
  });

  it.each([undefined, 0, -1, 1.5, "1"])(
    "requires a positive integer authorization generation, rejecting %j",
    async (authorizationGeneration) => {
      await link();
      const result = await request("subscriptions", {
        body: {
          templateId: TEMPLATE,
          status: "accept",
          identityVersion: 1,
          ...(authorizationGeneration === undefined ? {} : { authorizationGeneration }),
        },
      });
      expect(result.status).toBe(400);
      expect(await subscriptionFor(employee.id)).toBeNull();
      expect(
        await prisma.employeeSubscriptionRequest.count({
          where: { identity: { userId: employee.id } },
        }),
      ).toBe(0);
    },
  );

  it.each(["reject", "ban"] as const)(
    "clears all unused consents when the employee returns %s",
    async (status) => {
      await link();
      await accept(`first-consent-${status}`);
      await accept(`second-consent-${status}`);
      expect((await subscriptionFor(employee.id))?.remainingSubscriptions).toBe(2);
      const result = await request("subscriptions", {
        body: { templateId: TEMPLATE, status, identityVersion: 1, authorizationGeneration: 1 },
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        remainingSubscriptions: 0,
        subscriptionStatus: status.toUpperCase(),
        authorizationGeneration: 2,
      });
      expect(await subscriptionFor(employee.id)).toMatchObject({
        remainingSubscriptions: 0,
        status: status.toUpperCase(),
        authorizationGeneration: 2,
      });
    },
  );

  it("refuses a stale template, missing identity, invalid status or absent idempotency key without granting consents", async () => {
    const missingIdentity = await accept("before-wechat-linking");
    expect(missingIdentity.status).toBe(409);
    await link();
    const mismatch = await request("subscriptions", {
      body: {
        templateId: "outdated-template",
        status: "accept",
        identityVersion: 1,
        authorizationGeneration: 1,
      },
    });
    const invalidStatus = await request("subscriptions", {
      body: {
        templateId: TEMPLATE,
        status: "ACCEPT",
        identityVersion: 1,
        authorizationGeneration: 1,
      },
    });
    const missingKey = await request("subscriptions", {
      idempotencyKey: null,
      body: {
        templateId: TEMPLATE,
        status: "accept",
        identityVersion: 1,
        authorizationGeneration: 1,
      },
    });
    expect(mismatch.status).toBe(409);
    expect(invalidStatus.status).toBe(400);
    expect(missingKey.status).toBe(400);
    expect(await subscriptionFor(employee.id)).toBeNull();
    expect(
      await prisma.employeeSubscriptionRequest.count({
        where: { identity: { userId: employee.id } },
      }),
    ).toBe(0);
  });

  it("clears old identity consents and advances versions when the employee switches WeChat identity", async () => {
    await link();
    await accept("switch-old-identity-consent");
    const oldIdentity = await identityFor(employee.id, APP_A);
    const oldSubscription = await subscriptionFor(employee.id);
    gateway.exchangeCode.mockResolvedValue({ openId: `switched_${employee.id}` });
    const switched = await request("identity", { body: { code: "switched-wx-code" } });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({
      identityLinked: true,
      identityVersion: 2,
      authorizationGeneration: 2,
      remainingSubscriptions: 0,
      subscriptionStatus: "NONE",
    });
    const identity = await identityFor(employee.id, APP_A);
    const subscription = await subscriptionFor(employee.id);
    expect(identity).toMatchObject({
      id: oldIdentity?.id,
      openId: `switched_${employee.id}`,
      version: 2,
      unionId: null,
    });
    expect(subscription).toMatchObject({
      id: oldSubscription?.id,
      remainingSubscriptions: 0,
      status: "NONE",
      version: 3,
      authorizationGeneration: 2,
      lastAuthorizedAt: null,
    });
    await accept("switch-new-identity-consent");
    expect((await subscriptionFor(employee.id))?.remainingSubscriptions).toBe(1);
  });

  it("isolates per-app configuration and consents for one employee", async () => {
    await link();
    await accept("app-a-consent");
    configuredAppId = APP_B;
    const unlinked = await request("configuration");
    expect(unlinked.body).toMatchObject({
      appId: APP_B,
      identityLinked: false,
      identityVersion: null,
      authorizationGeneration: null,
      remainingSubscriptions: 0,
    });
    await link();
    await accept("app-b-consent");
    await accept("app-b-second-consent");
    expect((await request("configuration")).body.remainingSubscriptions).toBe(2);
    configuredAppId = APP_A;
    expect((await request("configuration")).body.remainingSubscriptions).toBe(1);
    expect(await prisma.wechatMiniappIdentity.count({ where: { userId: employee.id } })).toBe(2);
  });

  it("denies admin tokens, unauthenticated calls and employees without an active membership", async () => {
    const noMembership = await createEmployee(false);
    const disabled = await createEmployee();
    await prisma.globalUser.update({ where: { id: disabled.id }, data: { status: "DISABLED" } });
    for (const path of ["configuration", "identity", "subscriptions"] as const) {
      const body =
        path === "identity"
          ? { code: "guard-fixture-code" }
          : path === "subscriptions"
            ? {
                templateId: TEMPLATE,
                status: "accept",
                identityVersion: 1,
                authorizationGeneration: 1,
              }
            : undefined;
      const admin = await request(path, { token: tokens.issueAdminAccessToken(employee.id), body });
      const unauthenticated = await request(path, { token: null, body });
      const inactive = await request(path, { token: noMembership.token, body });
      const disabledEmployee = await request(path, { token: disabled.token, body });
      expect(admin.status).toBe(401);
      expect(unauthenticated.status).toBe(401);
      expect(inactive.status).toBe(403);
      expect(disabledEmployee.status).toBe(401);
    }
    expect(gateway.exchangeCode).not.toHaveBeenCalled();
    expect(gateway.sendSubscription).not.toHaveBeenCalled();
  });

  async function createEmployee(withMembership = true): Promise<EmployeeFixture> {
    const digits = (BigInt(`0x${randomBytes(6).toString("hex")}`) % 100_000_000n)
      .toString()
      .padStart(8, "0");
    const user = await prisma.globalUser.create({
      data: { phone: `199${digits}`, phoneVerifiedAt: new Date() },
    });
    userIds.push(user.id);
    if (!user.phone) throw new Error("Expected a phone in the employee test fixture");
    if (withMembership)
      await prisma.enterpriseMembership.create({
        data: {
          tenantId,
          enterpriseId,
          globalUserId: user.id,
          name: `${marker}-employee`,
          phone: user.phone,
          status: "ACTIVE",
          seatStatus: "ENABLED",
          boundAt: new Date(),
          seatEnabledAt: new Date(),
        },
      });
    return {
      id: user.id,
      token: tokens.issueEmployeeAccessToken(user.id),
      openId: `openid_${user.id}`,
    };
  }

  async function link() {
    const result = await request("identity", { body: { code: "fixture-wx-login-code" } });
    expect(result.status).toBe(200);
    return result;
  }

  async function accept(
    idempotencyKey: string,
    identityVersion?: number,
    authorizationGeneration?: number,
  ) {
    const version =
      identityVersion ?? (await identityFor(employee.id, configuredAppId))?.version ?? 1;
    const generation =
      authorizationGeneration ?? (await subscriptionFor(employee.id))?.authorizationGeneration ?? 1;
    return request("subscriptions", {
      idempotencyKey,
      body: {
        templateId: TEMPLATE,
        status: "accept",
        identityVersion: version,
        authorizationGeneration: generation,
      },
    });
  }

  function identityFor(userId: string, appId: string) {
    return prisma.wechatMiniappIdentity.findUnique({ where: { userId_appId: { userId, appId } } });
  }

  function subscriptionFor(userId: string) {
    return prisma.employeeNotificationSubscription.findFirst({
      where: { identity: { userId, appId: configuredAppId }, templateId: TEMPLATE },
    });
  }

  async function request(
    path: string,
    options: {
      token?: string | null;
      body?: Record<string, unknown>;
      idempotencyKey?: string | null;
    } = {},
  ): Promise<HttpResult> {
    const method = options.body ? "POST" : "GET";
    const headers = new Headers({ "Content-Type": "application/json" });
    const accessToken = options.token === undefined ? employee.token : options.token;
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    if (method === "POST" && options.idempotencyKey !== null)
      headers.set("Idempotency-Key", options.idempotencyKey ?? randomUUID());
    const result = await fetch(`${baseUrl}/employee/notifications/${path}`, {
      method,
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return {
      status: result.status,
      headers: result.headers,
      body: (await result.json()) as Record<string, unknown>,
    };
  }
});

function assertDevelopmentDatabase(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required for employee notification tests");
  const url = new URL(raw);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/dev_xhs_agentic"
  ) {
    throw new Error("Employee notification tests require the local dev_xhs_agentic database.");
  }
}
