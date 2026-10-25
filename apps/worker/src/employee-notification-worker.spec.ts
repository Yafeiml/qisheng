import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ModelCredentialCipher } from "@xhs-agentic/ai-gateway";
import { AliyunSmsError } from "@xhs-agentic/sms";
import { WechatMiniappError } from "@xhs-agentic/wechat-miniapp";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type EmployeeNotificationConfiguration,
  EmployeeNotificationProcessor,
  type EmployeeSmsNotificationConfiguration,
  notificationQuietHoursEnd,
} from "./employee-notification-worker";

describe("employee notification quiet hours", () => {
  it("uses Shanghai time and handles windows crossing midnight", () => {
    expect(notificationQuietHoursEnd(new Date("2026-10-06T15:30:00Z"), "22:00", "08:00")).toEqual(
      new Date("2026-10-07T00:00:00Z"),
    );
    expect(notificationQuietHoursEnd(new Date("2026-10-06T23:30:00Z"), "22:00", "08:00")).toEqual(
      new Date("2026-10-07T00:00:00Z"),
    );
    expect(
      notificationQuietHoursEnd(new Date("2026-10-07T00:00:00Z"), "22:00", "08:00"),
    ).toBeNull();
  });

  it("handles daytime windows and equal endpoints without deferral", () => {
    expect(notificationQuietHoursEnd(new Date("2026-10-06T03:59:30Z"), "10:00", "12:00")).toEqual(
      new Date("2026-10-06T04:00:00Z"),
    );
    expect(
      notificationQuietHoursEnd(new Date("2026-10-06T02:00:00Z"), "10:00", "10:00"),
    ).toBeNull();
    expect(() => notificationQuietHoursEnd(new Date(), "24:00", "08:00")).toThrow(
      "NOTIFICATION_QUIET_HOURS_INVALID",
    );
  });
});

// Test only a private temporary schema, never the application's tables or data.
const databaseUrl = process.env.DATABASE_URL;
const localDatabase =
  databaseUrl && ["localhost", "127.0.0.1", "::1"].includes(new URL(databaseUrl).hostname);
describe.skipIf(!localDatabase)(
  "durable employee notification processor",
  { concurrent: false },
  () => {
    const schema = `employee_notification_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    const database = new Pool({
      connectionString: databaseUrl,
      max: 4,
      options: `-c search_path=${schema},public -c timezone=UTC`,
    });
    const sendSubscription = vi.fn();
    const sendSms = vi.fn();
    const querySms = vi.fn();
    let now: Date;
    let configuration: EmployeeNotificationConfiguration | null;
    let smsConfiguration: EmployeeSmsNotificationConfiguration | null;

    beforeAll(async () => {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await database.query(`
      CREATE TABLE tenants (id text PRIMARY KEY, status text NOT NULL);
      CREATE TABLE platform_settings (key text PRIMARY KEY, value jsonb, updated_at timestamp(3) NOT NULL,
        authentication_tag bytea, ciphertext bytea, initialization_vector bytea, key_version text);
      CREATE TABLE enterprises (id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL, status text NOT NULL);
      CREATE TABLE global_users (id text PRIMARY KEY, status text NOT NULL, phone text, phone_verified_at timestamp(3));
      CREATE TABLE enterprise_memberships (id text PRIMARY KEY, global_user_id text, status text NOT NULL, seat_status text NOT NULL,
        phone text NOT NULL, updated_at timestamp(3) NOT NULL DEFAULT NOW());
      CREATE TABLE membership_participations (membership_id text PRIMARY KEY, status text NOT NULL);
      CREATE TABLE campaigns (id text PRIMARY KEY, tenant_id text NOT NULL, title text NOT NULL, status text NOT NULL);
      CREATE TABLE distribution_tasks (id text PRIMARY KEY, tenant_id text NOT NULL, enterprise_id text NOT NULL,
        campaign_id text NOT NULL, membership_id text NOT NULL, status text NOT NULL, visible_at timestamp(3) NOT NULL, expires_at timestamp(3) NOT NULL);
      CREATE TABLE wechat_miniapp_identities (id text PRIMARY KEY, user_id text NOT NULL, app_id text NOT NULL,
        open_id text NOT NULL, version integer NOT NULL DEFAULT 1, UNIQUE (user_id, app_id));
      CREATE TABLE employee_notification_subscriptions (id text PRIMARY KEY, identity_id text NOT NULL,
        template_id text NOT NULL, status text NOT NULL, remaining_subscriptions integer NOT NULL CHECK (remaining_subscriptions >= 0),
        version integer NOT NULL DEFAULT 1, authorization_generation integer NOT NULL DEFAULT 1,
        updated_at timestamp(3) NOT NULL DEFAULT NOW(), UNIQUE (identity_id, template_id));
      CREATE TABLE employee_task_notifications (id text PRIMARY KEY, task_id text NOT NULL, event text NOT NULL,
        user_id text NOT NULL, app_id text NOT NULL, template_id text NOT NULL, identity_id text, subscription_id text,
        identity_version integer NOT NULL, status text NOT NULL, attempts integer NOT NULL, next_attempt_at timestamp(3) NOT NULL,
        lease_token text, lease_until timestamp(3), error_code text, sent_at timestamp(3), subscription_reserved boolean NOT NULL DEFAULT false,
        subscription_authorization_generation integer,
        created_at timestamp(3) NOT NULL, updated_at timestamp(3) NOT NULL, UNIQUE (task_id, event));
    `);
      const migration =
        readFileSync(
          "prisma/migrations/20261013010000_employee_sms_notifications/migration.sql",
          "utf8",
        ) +
        readFileSync(
          "prisma/migrations/20261013020000_employee_sms_delivery/migration.sql",
          "utf8",
        );
      const transaction = await database.connect();
      try {
        await transaction.query("BEGIN");
        await transaction.query(migration);
        await transaction.query("ROLLBACK");
        expect(
          (
            await transaction.query(
              "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'employee_task_notifications' AND column_name = 'channel'",
              [schema],
            )
          ).rowCount,
        ).toBe(0);
        await transaction.query("BEGIN");
        await transaction.query(migration);
        await transaction.query("COMMIT");
      } finally {
        transaction.release();
      }
    });

    afterAll(async () => {
      await database.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });

    beforeEach(async () => {
      sendSubscription.mockReset().mockResolvedValue(undefined);
      sendSms.mockReset().mockResolvedValue({
        messageId: "mock-biz-id",
        requestId: "mock-request-id",
        provider: "ALIYUN",
      });
      querySms.mockReset().mockResolvedValue(null);
      now = new Date("2026-10-06T02:00:00Z");
      configuration = {
        appId: "wx1111111111111111",
        appSecret: "mock-secret-never-sent-to-wechat",
        enabledAt: new Date("2026-10-06T00:00:00Z"),
        environment: "trial",
        mapping: { thing1: "TASK_TITLE", thing2: "ENTERPRISE_NAME", time3: "EXPIRES_AT" },
        quietHoursStart: "22:00",
        quietHoursEnd: "08:00",
        retryLimit: 2,
        templateId: "mock-template",
      };
      smsConfiguration = {
        channel: "ALIYUN_SMS",
        enabledAt: configuration.enabledAt,
        accessKeyId: "mock-access-key-id",
        accessKeySecret: "mock-access-key-secret",
        signName: "企声共创",
        templateCode: "SMS_123456",
        dailyLimit: 3,
        quietHoursStart: "22:00",
        quietHoursEnd: "08:00",
        retryLimit: 2,
      };
      await database.query(`TRUNCATE platform_settings, employee_task_notifications, employee_notification_subscriptions, wechat_miniapp_identities,
      distribution_tasks, campaigns, membership_participations, enterprise_memberships, global_users, enterprises, tenants`);
      await database.query(`
      INSERT INTO tenants VALUES ('tenant', 'ACTIVE');
      INSERT INTO enterprises VALUES ('enterprise', 'tenant', '测试医院', 'ACTIVE');
      INSERT INTO global_users VALUES ('user', 'ACTIVE', '13800000000', '2026-10-05 00:00:00');
      INSERT INTO enterprise_memberships (id, global_user_id, status, seat_status, phone)
        VALUES ('member', 'user', 'ACTIVE', 'ENABLED', '13800000000');
      INSERT INTO membership_participations VALUES ('member', 'PARTICIPATING');
      INSERT INTO campaigns VALUES ('campaign', 'tenant', '员工专属内容开放', 'ACTIVE');
      INSERT INTO wechat_miniapp_identities VALUES ('identity', 'user', 'wx1111111111111111', 'mock-open-id', 1);
      INSERT INTO employee_notification_subscriptions (id, identity_id, template_id, status, remaining_subscriptions)
        VALUES ('subscription', 'identity', 'mock-template', 'ACCEPT', 1);
    `);
      await createTask("task");
    });

    function processor() {
      return new EmployeeNotificationProcessor(
        database,
        { sendSubscription },
        {
          now: () => now,
          configuration: async () => configuration,
        },
      );
    }

    function smsProcessor() {
      return new EmployeeNotificationProcessor(
        database,
        { sendSubscription },
        {
          now: () => now,
          configuration: async () => smsConfiguration,
          smsSender: sendSms,
          smsQuery: querySms,
          smsQueryConfiguration: async () => ({
            accessKeyId: "query-id",
            accessKeySecret: "query-secret",
            signName: "企声共创",
          }),
        },
      );
    }

    async function storedSmsConfiguration() {
      for (const [key, value] of Object.entries({
        "notification.enabled": true,
        "notification.channel": "ALIYUN_SMS",
        "notification.sms_template_code": "SMS_123456",
        "security.admin_sms_sign_name": "企声共创",
        "security.admin_sms_mode": "DEVELOPMENT",
        "security.admin_sms_template_code": "SMS_999999",
      })) {
        await database.query(
          "INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2, '2026-10-06 00:00:00')",
          [key, JSON.stringify(value)],
        );
      }
      const cipher = ModelCredentialCipher.fromEnvironment();
      for (const [key, value] of Object.entries({
        "security.admin_sms_access_key_id": "mock-access-key-id",
        "security.admin_sms_access_key_secret": "mock-access-key-secret",
      })) {
        const encrypted = cipher.encrypt(value, `xhs-agentic:platform-setting:${key}`);
        await database.query(
          "INSERT INTO platform_settings (key, updated_at, authentication_tag, ciphertext, initialization_vector, key_version) VALUES ($1, '2026-10-06 00:00:00', $2, $3, $4, $5)",
          [
            key,
            encrypted.authenticationTag,
            encrypted.ciphertext,
            encrypted.initializationVector,
            encrypted.keyVersion,
          ],
        );
      }
    }

    async function createTask(
      id: string,
      visibleAt = new Date("2026-10-06T01:00:00Z"),
      expiresAt = new Date("2026-10-07T01:00:00Z"),
    ) {
      await database.query(
        "INSERT INTO distribution_tasks VALUES ($1, 'tenant', 'enterprise', 'campaign', 'member', 'AVAILABLE', $2, $3)",
        [id, visibleAt.toISOString(), expiresAt.toISOString()],
      );
    }

    async function notification(id = "task") {
      return (
        await database.query(
          "SELECT *, next_attempt_at AT TIME ZONE 'UTC' AS next_attempt_at FROM employee_task_notifications WHERE task_id = $1",
          [id],
        )
      ).rows[0];
    }

    async function remainingSubscriptions() {
      return (
        await database.query(
          "SELECT remaining_subscriptions FROM employee_notification_subscriptions WHERE id = 'subscription'",
        )
      ).rows[0]?.remaining_subscriptions;
    }

    it("notifies a task already unlocked by API exactly once and excludes the pre-enable backlog", async () => {
      await createTask("old-task", new Date("2026-10-05T23:59:00Z"));
      const worker = processor();
      expect(await worker.run()).toMatchObject({ enqueued: 1, sent: 1 });
      expect(await worker.run()).toMatchObject({ enqueued: 0, sent: 0 });
      expect(sendSubscription).toHaveBeenCalledOnce();
      expect(sendSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          openId: "mock-open-id",
          environment: "trial",
          page: "pages/task-detail/task-detail?taskId=task",
          data: {
            thing1: { value: "员工专属内容开放" },
            thing2: { value: "测试医院" },
            time3: { value: "2026-10-07 09:00:00" },
          },
        }),
      );
      expect(await notification()).toMatchObject({
        status: "SENT",
        subscription_reserved: true,
        attempts: 1,
      });
      expect(await notification("old-task")).toBeUndefined();
      expect(await remainingSubscriptions()).toBe(0);
    });

    it("formats the approved task template and identifies the enterprise within the remark limit", async () => {
      if (configuration)
        configuration = {
          ...configuration,
          mapping: {
            thing4: "TASK_TITLE",
            time5: "EXPIRES_AT",
            thing12: "TASK_TYPE",
            thing11: "REMARK",
            thing13: "TASK_PLATFORM",
          },
        };
      await database.query("UPDATE enterprises SET name = '示例测试眼科医院专属内容工作组'");
      await processor().run();
      expect(sendSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            thing4: { value: "员工专属内容开放" },
            time5: { value: "2026-10-07 09:00:00" },
            thing12: { value: "图文发布" },
            thing11: { value: "示例测试眼科医院｜打开小程序领取图文" },
            thing13: { value: "小红书" },
          },
        }),
      );
      expect(
        Array.from(sendSubscription.mock.calls[0]?.[0].data.thing11.value).length,
      ).toBeLessThanOrEqual(20);
    });

    it("atomically reserves the only grant across concurrent processors and tasks", async () => {
      await createTask("task-2");
      await Promise.all([processor().run(), processor().run()]);
      expect(sendSubscription).toHaveBeenCalledOnce();
      expect(await remainingSubscriptions()).toBe(0);
      const rows = (
        await database.query("SELECT status FROM employee_task_notifications ORDER BY task_id")
      ).rows;
      expect(rows.map((row) => row.status).sort()).toEqual(["SENT", "SKIPPED"]);
    });

    it("records a missing identity as skipped without sending", async () => {
      await database.query("DELETE FROM employee_notification_subscriptions");
      await database.query("DELETE FROM wechat_miniapp_identities");
      expect(await processor().run()).toMatchObject({ enqueued: 1, skipped: 1 });
      expect(await notification()).toMatchObject({
        status: "SKIPPED",
        error_code: "WECHAT_IDENTITY_MISSING",
      });
      expect(sendSubscription).not.toHaveBeenCalled();
    });

    it("keeps a reserved grant through known temporary failures and retries without a second debit", async () => {
      sendSubscription.mockRejectedValueOnce(new WechatMiniappError("-1", "RETRYABLE"));
      const worker = processor();
      await worker.run();
      expect(await notification()).toMatchObject({
        status: "PENDING",
        subscription_reserved: true,
        attempts: 1,
      });
      expect(await remainingSubscriptions()).toBe(0);
      now = new Date(now.getTime() + 60_000);
      await worker.run();
      expect(await notification()).toMatchObject({ status: "SENT", attempts: 2 });
      expect(sendSubscription).toHaveBeenCalledTimes(2);
      expect(await remainingSubscriptions()).toBe(0);
    });

    it("refunds a structured permanent rejection and does not retry it", async () => {
      sendSubscription.mockRejectedValue(new WechatMiniappError("47003", "PERMANENT"));
      await processor().run();
      expect(await notification()).toMatchObject({
        status: "FAILED",
        error_code: "47003",
        subscription_reserved: false,
      });
      expect(await remainingSubscriptions()).toBe(1);
      await processor().run();
      expect(sendSubscription).toHaveBeenCalledOnce();
    });

    it("honors a reduced retry limit without another provider call", async () => {
      sendSubscription.mockRejectedValue(new WechatMiniappError("-1", "RETRYABLE"));
      const worker = processor();
      await worker.run();
      if (configuration) configuration = { ...configuration, retryLimit: 0 };
      now = new Date(now.getTime() + 60_000);
      await worker.run();
      expect(await notification()).toMatchObject({
        status: "FAILED",
        error_code: "RETRY_LIMIT_EXHAUSTED",
      });
      expect(await remainingSubscriptions()).toBe(1);
      expect(sendSubscription).toHaveBeenCalledOnce();
    });

    it("does not send old pending tasks after notifications are re-enabled", async () => {
      sendSubscription.mockRejectedValueOnce(new WechatMiniappError("-1", "RETRYABLE"));
      const worker = processor();
      await worker.run();
      now = new Date(now.getTime() + 60_000);
      if (configuration) configuration = { ...configuration, enabledAt: now };
      await worker.run();
      expect(await notification()).toMatchObject({
        status: "SKIPPED",
        error_code: "NOTIFICATION_ENABLED_AFTER_TASK",
      });
      expect(await remainingSubscriptions()).toBe(1);
      expect(sendSubscription).toHaveBeenCalledOnce();
    });

    it("clears grants when WeChat reports a revoked subscription", async () => {
      await database.query(
        "UPDATE employee_notification_subscriptions SET remaining_subscriptions = 3",
      );
      sendSubscription.mockRejectedValue(new WechatMiniappError("43101", "UNAUTHORIZED"));
      await processor().run();
      expect(await notification()).toMatchObject({
        status: "FAILED",
        subscription_reserved: false,
      });
      expect(await remainingSubscriptions()).toBe(0);
      expect(
        (await database.query("SELECT status FROM employee_notification_subscriptions")).rows[0]
          ?.status,
      ).toBe("REJECT");
    });

    it("preserves a newer authorization arriving during a rejected send", async () => {
      sendSubscription.mockImplementationOnce(async () => {
        await database.query(
          "UPDATE employee_notification_subscriptions SET remaining_subscriptions = 1, version = version + 1",
        );
        throw new WechatMiniappError("43101", "UNAUTHORIZED");
      });
      await processor().run();
      expect(await remainingSubscriptions()).toBe(1);
      expect(
        (await database.query("SELECT status FROM employee_notification_subscriptions")).rows[0]
          ?.status,
      ).toBe("ACCEPT");
    });

    async function revokeAndAuthorizeAgain() {
      await database.query(`UPDATE employee_notification_subscriptions
        SET status = 'REJECT', remaining_subscriptions = 0, version = version + 1,
            authorization_generation = authorization_generation + 1`);
      await database.query(`UPDATE employee_notification_subscriptions
        SET status = 'ACCEPT', remaining_subscriptions = 1, version = version + 1`);
    }

    it("does not spend a new authorization on a pending reservation from before revocation", async () => {
      sendSubscription.mockRejectedValueOnce(new WechatMiniappError("-1", "RETRYABLE"));
      const worker = processor();
      await worker.run();
      expect(await notification()).toMatchObject({
        status: "PENDING",
        subscription_authorization_generation: 1,
      });
      await revokeAndAuthorizeAgain();
      now = new Date(now.getTime() + 60_000);
      await worker.run();
      expect(await notification()).toMatchObject({
        status: "SKIPPED",
        error_code: "SUBSCRIPTION_AUTHORIZATION_CHANGED",
        subscription_reserved: false,
      });
      expect(await remainingSubscriptions()).toBe(1);
      expect(sendSubscription).toHaveBeenCalledOnce();
    });

    it("does not refund an old failed send into the replacement authorization", async () => {
      sendSubscription.mockImplementationOnce(async () => {
        await revokeAndAuthorizeAgain();
        throw new WechatMiniappError("47003", "PERMANENT");
      });
      await processor().run();
      expect(await notification()).toMatchObject({
        status: "FAILED",
        subscription_reserved: false,
      });
      expect(await remainingSubscriptions()).toBe(1);
      expect(
        (
          await database.query(
            "SELECT authorization_generation FROM employee_notification_subscriptions",
          )
        ).rows[0]?.authorization_generation,
      ).toBe(2);
    });

    it("does not let a concurrent reservation and refund hide a 43101 rejection", async () => {
      await createTask("task-2");
      await database.query(
        "UPDATE employee_notification_subscriptions SET remaining_subscriptions = 3",
      );
      let firstStarted: (() => void) | undefined;
      let rejectFirst: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      sendSubscription
        .mockImplementationOnce(async () => {
          firstStarted?.();
          await new Promise<void>((resolve) => {
            rejectFirst = resolve;
          });
          throw new WechatMiniappError("43101", "UNAUTHORIZED");
        })
        .mockRejectedValueOnce(new WechatMiniappError("47003", "PERMANENT"));
      const first = processor().run();
      await started;
      await processor().run();
      expect(
        (await database.query("SELECT version FROM employee_notification_subscriptions")).rows[0]
          ?.version,
      ).toBe(1);
      rejectFirst?.();
      await first;
      expect(await remainingSubscriptions()).toBe(0);
      expect(
        (
          await database.query(
            "SELECT status, version, authorization_generation FROM employee_notification_subscriptions",
          )
        ).rows[0],
      ).toMatchObject({ status: "REJECT", version: 2, authorization_generation: 2 });
      expect(sendSubscription).toHaveBeenCalledTimes(2);
    });

    it("records an uncertain send without refund or blind resend", async () => {
      sendSubscription.mockRejectedValue(new WechatMiniappError("WECHAT_TIMEOUT", "UNCERTAIN"));
      const worker = processor();
      await worker.run();
      expect(await notification()).toMatchObject({
        status: "UNKNOWN",
        subscription_reserved: true,
      });
      expect(await remainingSubscriptions()).toBe(0);
      now = new Date(now.getTime() + 180_000);
      await worker.run();
      expect(sendSubscription).toHaveBeenCalledOnce();
    });

    it("recovers a crashed send as UNKNOWN even when notifications are now disabled", async () => {
      sendSubscription.mockRejectedValueOnce(new WechatMiniappError("-1", "RETRYABLE"));
      await processor().run();
      await database.query(
        "UPDATE employee_task_notifications SET status = 'SENDING', lease_until = $1, lease_token = 'crashed'",
        [new Date(now.getTime() - 1).toISOString()],
      );
      configuration = null;
      expect(await processor().run()).toMatchObject({ unknown: 1 });
      expect(await notification()).toMatchObject({
        status: "UNKNOWN",
        subscription_reserved: true,
        error_code: "SEND_LEASE_EXPIRED",
      });
      expect(await remainingSubscriptions()).toBe(0);
      expect(sendSubscription).toHaveBeenCalledOnce();
    });

    it("rechecks task cancellation before a retry and releases its reservation", async () => {
      sendSubscription.mockRejectedValueOnce(new WechatMiniappError("-1", "RETRYABLE"));
      const worker = processor();
      await worker.run();
      await database.query("UPDATE distribution_tasks SET status = 'CANCELLED'");
      now = new Date(now.getTime() + 60_000);
      await worker.run();
      expect(await notification()).toMatchObject({
        status: "SKIPPED",
        error_code: "TASK_NO_LONGER_ELIGIBLE",
      });
      expect(await remainingSubscriptions()).toBe(1);
      expect(sendSubscription).toHaveBeenCalledOnce();
    });

    it("never sends or restores an old identity's reservation after its version changes", async () => {
      sendSubscription.mockRejectedValueOnce(new WechatMiniappError("-1", "RETRYABLE"));
      const worker = processor();
      await worker.run();
      await database.query(
        "UPDATE wechat_miniapp_identities SET version = version + 1, open_id = 'replacement'",
      );
      now = new Date(now.getTime() + 60_000);
      await worker.run();
      expect(await notification()).toMatchObject({
        status: "SKIPPED",
        error_code: "WECHAT_IDENTITY_CHANGED",
      });
      expect(await remainingSubscriptions()).toBe(0);
      expect(sendSubscription).toHaveBeenCalledOnce();
    });

    it("defers during quiet hours without consuming a grant and skips tasks expiring before morning", async () => {
      now = new Date("2026-10-06T15:00:00Z");
      await createTask(
        "expires-tonight",
        new Date("2026-10-06T14:00:00Z"),
        new Date("2026-10-06T23:00:00Z"),
      );
      await processor().run();
      expect(sendSubscription).not.toHaveBeenCalled();
      expect(await notification()).toMatchObject({
        status: "PENDING",
        attempts: 0,
        next_attempt_at: new Date("2026-10-07T00:00:00Z"),
      });
      expect(await notification("expires-tonight")).toMatchObject({
        status: "SKIPPED",
        error_code: "TASK_EXPIRES_DURING_QUIET_HOURS",
      });
      expect(await remainingSubscriptions()).toBe(1);
    });

    it("sends the independent fixed SMS template to a verified employee without a WeChat grant", async () => {
      await database.query("DELETE FROM employee_notification_subscriptions");
      await database.query("DELETE FROM wechat_miniapp_identities");
      await createTask("pre-enable", new Date("2026-10-05T23:59:00Z"));
      const worker = smsProcessor();
      expect(await worker.run()).toMatchObject({ enqueued: 1, sent: 1 });
      expect(await worker.run()).toMatchObject({ enqueued: 0, sent: 0 });
      expect(sendSms).toHaveBeenCalledExactlyOnceWith(smsConfiguration, {
        phone: "13800000000",
        requestId: (await notification()).id,
        templateCode: "SMS_123456",
        templateParams: {},
      });
      expect(await notification()).toMatchObject({
        channel: "ALIYUN_SMS",
        status: "SENT",
        subscription_reserved: false,
      });
      expect(await notification("pre-enable")).toBeUndefined();
      expect(sendSubscription).not.toHaveBeenCalled();
    });

    it("loads shared encrypted Aliyun credentials and a separate notification template without enabling real verification SMS", async () => {
      await storedSmsConfiguration();
      const worker = new EmployeeNotificationProcessor(
        database,
        { sendSubscription },
        { now: () => now, smsSender: sendSms },
      );
      expect(await worker.run()).toMatchObject({ sent: 1 });
      expect(sendSms).toHaveBeenCalledWith(
        expect.objectContaining({
          accessKeyId: "mock-access-key-id",
          accessKeySecret: "mock-access-key-secret",
          signName: "企声共创",
          dailyLimit: 3,
        }),
        expect.objectContaining({ templateCode: "SMS_123456", templateParams: {} }),
      );
      expect(sendSubscription).not.toHaveBeenCalled();
    });

    it("fails closed on corrupt stored SMS secrets before sending", async () => {
      await storedSmsConfiguration();
      await database.query(
        "UPDATE platform_settings SET authentication_tag = NULL WHERE key = 'security.admin_sms_access_key_secret'",
      );
      const worker = new EmployeeNotificationProcessor(
        database,
        { sendSubscription },
        { now: () => now, smsSender: sendSms },
      );
      await expect(worker.run()).rejects.toThrow("NOTIFICATION_CONFIGURATION_INVALID");
      expect(sendSms).not.toHaveBeenCalled();
    });

    it.each([null, "2026-10-05 00:00:00"])(
      "skips an unverified or invalid SMS phone (verified=%s)",
      async (verifiedAt) => {
        await database.query("UPDATE global_users SET phone = $1, phone_verified_at = $2", [
          verifiedAt ? "bad-number" : "13800000000",
          verifiedAt,
        ]);
        expect(await smsProcessor().run()).toMatchObject({ enqueued: 1, skipped: 1 });
        expect(await notification()).toMatchObject({
          status: "SKIPPED",
          error_code: "VERIFIED_PHONE_MISSING",
        });
        expect(sendSms).not.toHaveBeenCalled();
      },
    );

    it("serializes a shared daily SMS allowance across workers and resumes deferred tasks next morning", async () => {
      await database.query("UPDATE distribution_tasks SET expires_at = '2026-10-09 01:00:00'");
      for (let index = 2; index <= 5; index++)
        await createTask(`task-${index}`, undefined, new Date("2026-10-09T01:00:00Z"));
      await Promise.all([smsProcessor().run(), smsProcessor().run()]);
      expect(sendSms).toHaveBeenCalledTimes(3);
      expect(
        (
          await database.query(
            "SELECT status, attempts, next_attempt_at AT TIME ZONE 'UTC' AS next_attempt_at FROM employee_task_notifications WHERE status = 'PENDING'",
          )
        ).rows,
      ).toEqual([
        { status: "PENDING", attempts: 0, next_attempt_at: new Date("2026-10-07T00:00:00Z") },
        { status: "PENDING", attempts: 0, next_attempt_at: new Date("2026-10-07T00:00:00Z") },
      ]);
      now = new Date("2026-10-07T00:00:00Z");
      expect(await smsProcessor().run()).toMatchObject({ sent: 2 });
      expect(sendSms).toHaveBeenCalledTimes(5);
      expect(await remainingSubscriptions()).toBe(1);
    });

    it("counts uncertain SMS sends against the daily limit and never blindly resends them", async () => {
      for (let index = 2; index <= 4; index++) await createTask(`task-${index}`);
      sendSms.mockRejectedValueOnce(new AliyunSmsError("ETIMEDOUT", true, false));
      expect(await smsProcessor().run()).toMatchObject({ unknown: 1, sent: 2 });
      now = new Date(now.getTime() + 180_000);
      await smsProcessor().run();
      expect(sendSms).toHaveBeenCalledTimes(3);
      expect(
        (
          await database.query(
            "SELECT COUNT(*)::int AS count FROM employee_task_notifications WHERE status = 'UNKNOWN'",
          )
        ).rows[0]?.count,
      ).toBe(1);
    });

    it("retries only explicit temporary SMS rejections with the same event request ID", async () => {
      sendSms.mockRejectedValueOnce(new AliyunSmsError("isv.BUSINESS_LIMIT_CONTROL", false, true));
      const worker = smsProcessor();
      await worker.run();
      expect(await notification()).toMatchObject({ status: "PENDING", attempts: 1 });
      now = new Date(now.getTime() + 60_000);
      await worker.run();
      expect(await notification()).toMatchObject({ status: "SENT", attempts: 2 });
      expect(sendSms).toHaveBeenCalledTimes(2);
      expect(sendSms.mock.calls[0]?.[1].requestId).toBe(sendSms.mock.calls[1]?.[1].requestId);
      expect(await remainingSubscriptions()).toBe(1);
    });

    it("does not retry a permanent SMS template rejection", async () => {
      sendSms.mockRejectedValue(new AliyunSmsError("isv.SMS_TEMPLATE_ILLEGAL", false, false));
      const worker = smsProcessor();
      await worker.run();
      now = new Date(now.getTime() + 60_000);
      await worker.run();
      expect(await notification()).toMatchObject({
        status: "FAILED",
        error_code: "isv.SMS_TEMPLATE_ILLEGAL",
      });
      expect(sendSms).toHaveBeenCalledOnce();
    });

    it.each(["phone", "phone_verified_at"])(
      "invalidates an old SMS recipient when %s changes",
      async (field) => {
        sendSms.mockRejectedValueOnce(new AliyunSmsError("SYSTEM_ERROR", false, true));
        const worker = smsProcessor();
        await worker.run();
        await database.query(
          field === "phone"
            ? "UPDATE global_users SET phone = '13900000000'"
            : "UPDATE global_users SET phone_verified_at = '2026-10-06 00:00:00'",
        );
        now = new Date(now.getTime() + 60_000);
        await worker.run();
        expect(await notification()).toMatchObject({
          status: "SKIPPED",
          error_code: "SMS_RECIPIENT_CHANGED",
        });
        expect(sendSms).toHaveBeenCalledOnce();
      },
    );

    it.each([
      "UPDATE global_users SET status = 'DISABLED'",
      "UPDATE enterprise_memberships SET global_user_id = NULL",
      "UPDATE enterprise_memberships SET seat_status = 'NOT_ENABLED'",
      "UPDATE membership_participations SET status = 'PAUSED'",
      "UPDATE distribution_tasks SET status = 'CANCELLED'",
    ])("rechecks employee and task access before retrying SMS: %s", async (change) => {
      sendSms.mockRejectedValueOnce(new AliyunSmsError("SYSTEM_ERROR", false, true));
      const worker = smsProcessor();
      await worker.run();
      await database.query(change);
      now = new Date(now.getTime() + 60_000);
      await worker.run();
      expect(await notification()).toMatchObject({ status: "SKIPPED" });
      expect(sendSms).toHaveBeenCalledOnce();
    });

    it("does not reinterpret an existing WeChat retry as SMS or duplicate a sent event after a channel switch", async () => {
      sendSubscription.mockRejectedValueOnce(new WechatMiniappError("-1", "RETRYABLE"));
      await processor().run();
      now = new Date(now.getTime() + 60_000);
      await smsProcessor().run();
      expect(await notification()).toMatchObject({ channel: "WECHAT_TEMPLATE", status: "SKIPPED" });
      expect(sendSms).not.toHaveBeenCalled();
      expect(await remainingSubscriptions()).toBe(1);
      await createTask("task-2");
      await processor().run();
      await smsProcessor().run();
      expect(await notification("task-2")).toMatchObject({
        channel: "WECHAT_TEMPLATE",
        status: "SENT",
      });
      expect(sendSms).not.toHaveBeenCalled();
    });

    it("stops SMS immediately when the global switch is disabled during a batch", async () => {
      await createTask("task-2");
      sendSms.mockImplementationOnce(async () => {
        smsConfiguration = null;
        return { messageId: "mock-biz-id", requestId: "mock-request-id", provider: "ALIYUN" };
      });
      expect(await smsProcessor().run()).toMatchObject({ sent: 1 });
      expect(sendSms).toHaveBeenCalledOnce();
      expect(
        (
          await database.query(
            "SELECT COUNT(*)::int AS count FROM employee_task_notifications WHERE status = 'PENDING'",
          )
        ).rows[0]?.count,
      ).toBe(1);
    });

    it("rechecks the global switch again after claiming and before dispatching SMS", async () => {
      const readConfiguration = vi
        .fn()
        .mockResolvedValueOnce(smsConfiguration)
        .mockResolvedValueOnce(smsConfiguration)
        .mockResolvedValue(null);
      const worker = new EmployeeNotificationProcessor(
        database,
        { sendSubscription },
        { now: () => now, configuration: readConfiguration, smsSender: sendSms },
      );
      expect(await worker.run()).toMatchObject({ skipped: 1, sent: 0 });
      expect(sendSms).not.toHaveBeenCalled();
      expect(await notification()).toMatchObject({
        status: "SKIPPED",
        error_code: "SMS_SEND_NO_LONGER_ALLOWED",
      });
    });

    it("defers SMS through quiet hours and excludes tasks expiring before morning", async () => {
      now = new Date("2026-10-06T15:00:00Z");
      await createTask(
        "expires-tonight",
        new Date("2026-10-06T14:00:00Z"),
        new Date("2026-10-06T23:00:00Z"),
      );
      await smsProcessor().run();
      expect(sendSms).not.toHaveBeenCalled();
      expect(await notification()).toMatchObject({
        status: "PENDING",
        attempts: 0,
        next_attempt_at: new Date("2026-10-07T00:00:00Z"),
      });
      expect(await notification("expires-tonight")).toMatchObject({
        status: "SKIPPED",
        error_code: "TASK_EXPIRES_DURING_QUIET_HOURS",
      });
    });

    async function numberStatus(id = "member") {
      return (
        await database.query(
          "SELECT sms_notification_status AS status, sms_notification_phone_version AS version FROM enterprise_memberships WHERE id = $1",
          [id],
        )
      ).rows[0];
    }

    it("stores provider identifiers and only marks the number normal after matching delivery, even with the master switch off", async () => {
      const worker = smsProcessor();
      await worker.run();
      expect(await notification()).toMatchObject({
        sms_biz_id: "mock-biz-id",
        sms_provider_request_id: "mock-request-id",
        sms_delivery_status: "PENDING",
        sms_query_attempts: 0,
        recipient_phone_version: 1,
      });
      expect(await numberStatus()).toMatchObject({ status: "PENDING_VERIFICATION" });
      smsConfiguration = null;
      querySms.mockResolvedValue({
        status: "DELIVERED",
        code: "DELIVERED",
        deliveredAt: new Date(now.getTime() + 30_000),
      });
      now = new Date(now.getTime() + 120_000);
      await worker.run();
      expect(querySms).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ accessKeyId: "query-id" }),
        {
          phone: "13800000000",
          bizId: "mock-biz-id",
          requestId: (await notification()).id,
          templateCode: "SMS_123456",
          sentAt: new Date("2026-10-06T02:00:00Z"),
        },
      );
      expect(await numberStatus()).toMatchObject({ status: "NORMAL" });
      expect(await notification()).toMatchObject({
        sms_delivery_status: "DELIVERED",
        sms_next_query_at: null,
      });
      await worker.run();
      expect(querySms).toHaveBeenCalledOnce();
      expect(sendSms).toHaveBeenCalledOnce();
    });

    it.each([
      "INVALID_NUMBER",
      "MOBILE_NOT_ON_SERVICE",
      "PORT_NOT_REGISTERED",
      "NO_ROUTE",
      "SP_UNKNOWN_ERROR",
    ])(
      "keeps ambiguous or platform delivery failures away from number-review status: %s",
      async (code) => {
        const worker = smsProcessor();
        await worker.run();
        querySms.mockResolvedValue({ status: "FAILED", code, deliveredAt: null });
        now = new Date(now.getTime() + 120_000);
        await worker.run();
        expect(await numberStatus()).toMatchObject({ status: null });
        expect(await notification()).toMatchObject({
          status: "SENT",
          sms_delivery_status: "FAILED",
          sms_delivery_code: code,
        });
        expect(sendSms).toHaveBeenCalledOnce();
      },
    );

    it("does not erase a known normal phone after a channel failure or a query timeout", async () => {
      await database.query("UPDATE enterprise_memberships SET sms_notification_status = 'NORMAL'");
      const worker = smsProcessor();
      await worker.run();
      now = new Date(now.getTime() + 120_000);
      querySms.mockRejectedValueOnce(new AliyunSmsError("ReadTimeout", true, false));
      await worker.run();
      expect(await numberStatus()).toMatchObject({ status: "NORMAL" });
      querySms.mockResolvedValue({
        status: "FAILED",
        code: "PORT_NOT_REGISTERED",
        deliveredAt: null,
      });
      now = new Date("2026-10-06T02:10:00Z");
      await worker.run();
      expect(await numberStatus()).toMatchObject({ status: "NORMAL" });
    });

    it("marks only this enterprise's confirmed invalid phone and skips new notifications without removing employee task access", async () => {
      await database.query(
        "INSERT INTO enterprise_memberships (id, global_user_id, phone, status, seat_status) VALUES ('other-enterprise-member', 'user', '13800000000', 'ACTIVE', 'ENABLED')",
      );
      const worker = smsProcessor();
      await worker.run();
      querySms.mockResolvedValue({ status: "FAILED", code: "MK:0001", deliveredAt: null });
      now = new Date(now.getTime() + 120_000);
      await worker.run();
      expect(await numberStatus()).toMatchObject({ status: "NEEDS_REVIEW" });
      expect(await numberStatus("other-enterprise-member")).toMatchObject({
        status: "PENDING_VERIFICATION",
      });
      await createTask("task-2");
      await worker.run();
      expect(await notification("task-2")).toMatchObject({
        status: "SKIPPED",
        error_code: "SMS_NUMBER_NEEDS_REVIEW",
      });
      expect(
        (
          await database.query(
            "SELECT status FROM membership_participations WHERE membership_id = 'member'",
          )
        ).rows[0]?.status,
      ).toBe("PARTICIPATING");
      await database.query(
        "UPDATE enterprise_memberships SET sms_notification_status = 'PENDING_VERIFICATION', sms_notification_phone_version = 2, sms_notification_status_at = NULL WHERE id = 'member'",
      );
      await worker.run();
      expect(sendSms).toHaveBeenCalledOnce();
    });

    it("marks an explicit illegal-number send rejection but not template failures", async () => {
      sendSms.mockRejectedValue(new AliyunSmsError("isv.MOBILE_NUMBER_ILLEGAL", false, false));
      await smsProcessor().run();
      expect(await numberStatus()).toMatchObject({ status: "NEEDS_REVIEW" });
      expect(await notification()).toMatchObject({
        status: "FAILED",
        sms_delivery_status: "FAILED",
      });
      expect(querySms).not.toHaveBeenCalled();
    });

    it("records an old receipt without contaminating a changed phone generation", async () => {
      const worker = smsProcessor();
      await worker.run();
      await database.query(
        "UPDATE enterprise_memberships SET phone = '13900000000', sms_notification_phone_version = 2, sms_notification_status = 'PENDING_VERIFICATION', sms_notification_status_at = NULL WHERE id = 'member'",
      );
      querySms.mockResolvedValue({ status: "FAILED", code: "MK:0001", deliveredAt: null });
      now = new Date(now.getTime() + 120_000);
      await worker.run();
      expect(await numberStatus()).toMatchObject({ status: "PENDING_VERIFICATION", version: 2 });
      expect(await notification()).toMatchObject({ sms_delivery_status: "FAILED" });
    });

    it("does not overwrite a newer successful notification with a late older invalid-number result", async () => {
      const worker = smsProcessor();
      await worker.run();
      await database.query(
        "UPDATE employee_task_notifications SET sms_next_query_at = '2026-10-06 02:10:00'",
      );
      now = new Date(now.getTime() + 60_000);
      await createTask("task-2");
      await worker.run();
      const secondId = (await notification("task-2")).id;
      querySms.mockImplementation(async (_credentials, input) => ({
        status: input.requestId === secondId ? "DELIVERED" : "FAILED",
        code: input.requestId === secondId ? "DELIVERED" : "MK:0001",
        deliveredAt: null,
      }));
      now = new Date("2026-10-06T02:03:00Z");
      await worker.run();
      expect(await numberStatus()).toMatchObject({ status: "NORMAL" });
      now = new Date("2026-10-06T02:10:00Z");
      await worker.run();
      expect(await numberStatus()).toMatchObject({ status: "NORMAL" });
      expect(await notification()).toMatchObject({ sms_delivery_status: "FAILED" });
    });

    it("allows an older successful receipt to establish normal status after a later channel failure", async () => {
      const worker = smsProcessor();
      await worker.run();
      await database.query(
        "UPDATE employee_task_notifications SET sms_next_query_at = '2026-10-06 02:10:00'",
      );
      now = new Date(now.getTime() + 60_000);
      await createTask("task-2");
      await worker.run();
      const secondId = (await notification("task-2")).id;
      querySms.mockImplementation(async (_credentials, input) => ({
        status: input.requestId === secondId ? "FAILED" : "DELIVERED",
        code: input.requestId === secondId ? "PORT_NOT_REGISTERED" : "DELIVERED",
        deliveredAt: null,
      }));
      now = new Date("2026-10-06T02:03:00Z");
      await worker.run();
      expect(await numberStatus()).toMatchObject({ status: null });
      now = new Date("2026-10-06T02:10:00Z");
      await worker.run();
      expect(await numberStatus()).toMatchObject({ status: "NORMAL" });
    });

    it("bounds waiting receipt queries to four scheduled attempts and never resends unknown delivery", async () => {
      const worker = smsProcessor();
      await worker.run();
      smsConfiguration = null;
      for (const offset of [120_000, 600_000, 3_600_000, 86_400_000]) {
        now = new Date(new Date("2026-10-06T02:00:00Z").getTime() + offset);
        await worker.run();
      }
      expect(querySms).toHaveBeenCalledTimes(4);
      expect(await notification()).toMatchObject({
        sms_delivery_status: "UNKNOWN",
        sms_query_attempts: 4,
        sms_next_query_at: null,
      });
      expect(await numberStatus()).toMatchObject({ status: "PENDING_VERIFICATION" });
      now = new Date(now.getTime() + 86_400_000);
      await worker.run();
      expect(sendSms).toHaveBeenCalledOnce();
      expect(querySms).toHaveBeenCalledTimes(4);
    });

    it("leases the same delivery query once across concurrent workers", async () => {
      await smsProcessor().run();
      now = new Date(now.getTime() + 120_000);
      querySms.mockResolvedValue({ status: "DELIVERED", code: "DELIVERED", deliveredAt: null });
      await Promise.all([smsProcessor().run(), smsProcessor().run()]);
      expect(querySms).toHaveBeenCalledOnce();
      expect(await numberStatus()).toMatchObject({ status: "NORMAL" });
    });

    it("loads query credentials independently of the disabled notification switch", async () => {
      await storedSmsConfiguration();
      const worker = new EmployeeNotificationProcessor(
        database,
        { sendSubscription },
        {
          now: () => now,
          smsSender: sendSms,
          smsQuery: querySms,
        },
      );
      await worker.run();
      await database.query(
        "UPDATE platform_settings SET value = 'false' WHERE key = 'notification.enabled'",
      );
      now = new Date(now.getTime() + 120_000);
      querySms.mockResolvedValue({ status: "DELIVERED", code: "DELIVERED", deliveredAt: null });
      await worker.run();
      expect(querySms).toHaveBeenCalledWith(
        expect.objectContaining({
          accessKeyId: "mock-access-key-id",
          accessKeySecret: "mock-access-key-secret",
        }),
        expect.anything(),
      );
      expect(await numberStatus()).toMatchObject({ status: "NORMAL" });
      expect(sendSms).toHaveBeenCalledOnce();
    });

    it("rolls back rejection persistence together with phone status when the phone-status write fails", async () => {
      await database.query(`CREATE FUNCTION reject_phone_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'test phone status failure'; END $$;
        CREATE TRIGGER reject_phone_status BEFORE UPDATE ON enterprise_memberships
        FOR EACH ROW EXECUTE FUNCTION reject_phone_status();`);
      try {
        sendSms.mockRejectedValueOnce(
          new AliyunSmsError("isv.MOBILE_NUMBER_ILLEGAL", false, false),
        );
        await expect(smsProcessor().run()).rejects.toThrow("test phone status failure");
        expect(await notification()).toMatchObject({
          status: "SENDING",
          sms_delivery_status: null,
        });
        expect(await numberStatus()).toMatchObject({ status: "PENDING_VERIFICATION" });
      } finally {
        await database.query(
          "DROP TRIGGER reject_phone_status ON enterprise_memberships; DROP FUNCTION reject_phone_status()",
        );
      }
    });

    it("shares one in-flight tick and waits for confirmation before closing", async () => {
      let finishSend: (() => void) | undefined;
      let notifyStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      sendSubscription.mockImplementationOnce(() => {
        notifyStarted?.();
        return new Promise<void>((resolve) => {
          finishSend = resolve;
        });
      });
      const worker = processor();
      const first = worker.run();
      expect(worker.run()).toBe(first);
      await started;
      const closing = worker.close();
      finishSend?.();
      await closing;
      expect(await notification()).toMatchObject({ status: "SENT" });
      expect(sendSubscription).toHaveBeenCalledOnce();
      expect(await worker.run()).toEqual({
        enqueued: 0,
        sent: 0,
        skipped: 0,
        failed: 0,
        unknown: 0,
      });
    });
  },
);
