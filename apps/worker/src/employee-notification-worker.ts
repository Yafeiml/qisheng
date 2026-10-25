import { randomUUID } from "node:crypto";
import { ModelCredentialCipher } from "@xhs-agentic/ai-gateway";
import {
  type AliyunSmsConfiguration,
  type AliyunSmsDeliveryResult,
  AliyunSmsError,
  isInvalidAliyunSmsNumber,
  queryAliyunSmsDelivery,
  sendAliyunSms,
} from "@xhs-agentic/sms";
import {
  formatSubscriptionData,
  parseSubscriptionTemplateMapping,
  type SubscriptionTemplateMapping,
  WechatMiniappClient,
  WechatMiniappError,
} from "@xhs-agentic/wechat-miniapp";
import type { Pool, PoolClient } from "pg";

const SETTING_KEYS = [
  "miniapp.wechat_app_id",
  "miniapp.wechat_app_secret",
  "notification.enabled",
  "notification.channel",
  "notification.wechat_template_id",
  "notification.wechat_template_fields",
  "notification.wechat_environment",
  "notification.retry_limit",
  "notification.quiet_hours_start",
  "notification.quiet_hours_end",
  "notification.sms_template_code",
  "notification.sms_daily_limit",
  "security.admin_sms_access_key_id",
  "security.admin_sms_access_key_secret",
  "security.admin_sms_sign_name",
];
const LEASE_MS = 120_000;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const SMS_QUERY_OFFSETS_MS = [120_000, 600_000, 3_600_000, 86_400_000];

type CommonNotificationConfiguration = Readonly<{
  enabledAt: Date;
  quietHoursStart: string;
  quietHoursEnd: string;
  retryLimit: number;
}>;

export type EmployeeNotificationConfiguration = CommonNotificationConfiguration &
  Readonly<{
    channel?: "WECHAT_TEMPLATE";
    appId: string;
    appSecret: string;
    environment: "developer" | "trial" | "formal";
    mapping: SubscriptionTemplateMapping;
    templateId: string;
  }>;

export type EmployeeSmsNotificationConfiguration = CommonNotificationConfiguration &
  Readonly<{
    channel: "ALIYUN_SMS";
    accessKeyId: string;
    accessKeySecret: string;
    signName: string;
    templateCode: string;
    dailyLimit: number;
  }>;
type Configuration = EmployeeNotificationConfiguration | EmployeeSmsNotificationConfiguration;

type NotificationResult = Record<"enqueued" | "sent" | "skipped" | "failed" | "unknown", number>;
type Sender = Pick<WechatMiniappClient, "sendSubscription">;
type NotificationRow = {
  id: string;
  task_id: string;
  user_id: string;
  app_id: string;
  template_id: string;
  identity_id: string | null;
  identity_version: number;
  subscription_id: string | null;
  subscription_reserved: boolean;
  subscription_authorization_generation: number | null;
  attempts: number;
  channel: string;
  recipient_phone: string | null;
  recipient_phone_verified_at: Date | null;
  recipient_phone_version: number | null;
};
type SmsDeliveryRow = NotificationRow & {
  sms_biz_id: string;
  sent_at: Date;
  sms_query_attempts: number;
};
type TaskRow = {
  eligible: boolean;
  user_id: string;
  title: string;
  enterprise_name: string;
  visible_at: Date;
  expires_at: Date;
};
type Claim = {
  row: NotificationRow;
  token: string;
  openId: string;
  task: TaskRow;
  subscriptionVersion: number;
  phone?: string;
};

// An AVAILABLE scan repairs notifications even when an API read unlocked the task
// before the lifecycle Worker. The unique task/event key makes every scan idempotent.
export class EmployeeNotificationProcessor {
  private inFlight?: Promise<NotificationResult>;
  private stopped = false;
  private readonly batchSize: number;
  private readonly clock: () => Date;
  private readonly configuration: () => Promise<Configuration | null>;
  private readonly smsSender: typeof sendAliyunSms;
  private readonly smsQuery: typeof queryAliyunSmsDelivery;
  private readonly smsQueryConfiguration: () => Promise<AliyunSmsConfiguration | null>;

  constructor(
    private readonly database: Pool,
    private readonly sender: Sender = new WechatMiniappClient(),
    options: Readonly<{
      batchSize?: number;
      now?: () => Date;
      configuration?: () => Promise<Configuration | null>;
      smsSender?: typeof sendAliyunSms;
      smsQuery?: typeof queryAliyunSmsDelivery;
      smsQueryConfiguration?: () => Promise<AliyunSmsConfiguration | null>;
    }> = {},
  ) {
    this.batchSize = Math.min(100, Math.max(1, Math.trunc(options.batchSize ?? 20)));
    this.clock = options.now ?? (() => new Date());
    this.configuration = options.configuration ?? (() => loadConfiguration(database));
    this.smsSender = options.smsSender ?? sendAliyunSms;
    this.smsQuery = options.smsQuery ?? queryAliyunSmsDelivery;
    this.smsQueryConfiguration =
      options.smsQueryConfiguration ?? (() => loadSmsCredentials(database));
  }

  run(): Promise<NotificationResult> {
    if (this.stopped) return Promise.resolve(emptyResult());
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.process().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.inFlight;
  }

  private async process(): Promise<NotificationResult> {
    const result = emptyResult();
    // A crashed send may have reached the provider. Never resend it after lease expiry.
    const recovered = await this.database.query(
      `UPDATE employee_task_notifications
       SET status = 'UNKNOWN', error_code = 'SEND_LEASE_EXPIRED',
           lease_token = NULL, lease_until = NULL, updated_at = $1
       WHERE status = 'SENDING' AND lease_until <= $1`,
      [this.clock().toISOString()],
    );
    result.unknown += recovered.rowCount ?? 0;
    await this.querySmsDeliveries();
    const configuration = await this.configuration();
    if (!configuration) return result;
    const enqueued = await this.enqueue(configuration);
    result.enqueued += enqueued.total;
    result.skipped += enqueued.skipped;
    const due = await this.database.query<{ id: string }>(
      `SELECT id FROM employee_task_notifications
       WHERE status = 'PENDING' AND next_attempt_at <= $1
       ORDER BY next_attempt_at, id LIMIT $2`,
      [this.clock().toISOString(), this.batchSize],
    );
    for (const { id } of due.rows) {
      if (this.stopped) break;
      const currentConfiguration = await this.configuration();
      if (!currentConfiguration) break;
      const claim = await this.claim(id, currentConfiguration);
      if (claim === "SKIPPED") {
        result.skipped++;
        continue;
      }
      if (claim === "FAILED") {
        result.failed++;
        continue;
      }
      if (!claim) continue;
      const outcome = await this.send(claim, currentConfiguration);
      if (outcome) result[outcome]++;
    }
    return result;
  }

  private async enqueue(configuration: Configuration) {
    const sms = configuration.channel === "ALIYUN_SMS";
    const { rows } = await this.database.query<{ status: string }>(
      `INSERT INTO employee_task_notifications (
         id, task_id, event, user_id, app_id, template_id, identity_id,
         subscription_id, identity_version, status, attempts, next_attempt_at,
         error_code, subscription_reserved, created_at, updated_at,
         channel, recipient_phone, recipient_phone_verified_at, recipient_phone_version
       )
       SELECT gen_random_uuid()::text, task.id, 'NEW_TASK', membership.global_user_id,
              $1, $2, identity.id, subscription.id, COALESCE(identity.version, 0),
              CASE WHEN $6 = 'ALIYUN_SMS' THEN
                        CASE WHEN employee.phone_verified_at IS NOT NULL AND employee.phone ~ '^1[3-9][0-9]{9}$'
                               AND membership.phone = employee.phone
                               AND membership.sms_notification_status IS DISTINCT FROM 'NEEDS_REVIEW'
                             THEN 'PENDING' ELSE 'SKIPPED' END
                   WHEN identity.id IS NULL OR subscription.id IS NULL OR
                             subscription.status <> 'ACCEPT' OR subscription.remaining_subscriptions <= 0
                   THEN 'SKIPPED' ELSE 'PENDING' END,
              0, $3,
              CASE WHEN $6 = 'ALIYUN_SMS' THEN
                        CASE WHEN membership.sms_notification_status = 'NEEDS_REVIEW' THEN 'SMS_NUMBER_NEEDS_REVIEW'
                             WHEN employee.phone_verified_at IS NULL OR employee.phone !~ '^1[3-9][0-9]{9}$' THEN 'VERIFIED_PHONE_MISSING'
                             WHEN membership.phone <> employee.phone THEN 'SMS_RECIPIENT_CHANGED'
                             WHEN employee.phone_verified_at IS NOT NULL AND employee.phone ~ '^1[3-9][0-9]{9}$'
                             THEN NULL ELSE 'VERIFIED_PHONE_MISSING' END
                   WHEN identity.id IS NULL THEN 'WECHAT_IDENTITY_MISSING'
                   WHEN subscription.id IS NULL OR subscription.status <> 'ACCEPT' OR
                        subscription.remaining_subscriptions <= 0 THEN 'SUBSCRIPTION_UNAVAILABLE'
                   ELSE NULL END,
              false, $3, $3, $6,
              CASE WHEN $6 = 'ALIYUN_SMS' THEN employee.phone ELSE NULL END,
              CASE WHEN $6 = 'ALIYUN_SMS' THEN employee.phone_verified_at ELSE NULL END,
              CASE WHEN $6 = 'ALIYUN_SMS' THEN membership.sms_notification_phone_version ELSE NULL END
       FROM distribution_tasks task
       JOIN campaigns campaign ON campaign.id = task.campaign_id AND campaign.tenant_id = task.tenant_id
       JOIN enterprise_memberships membership ON membership.id = task.membership_id
       JOIN global_users employee ON employee.id = membership.global_user_id
       JOIN enterprises enterprise ON enterprise.id = task.enterprise_id AND enterprise.tenant_id = task.tenant_id
       JOIN tenants tenant ON tenant.id = task.tenant_id
       JOIN membership_participations participation ON participation.membership_id = membership.id
       LEFT JOIN wechat_miniapp_identities identity ON identity.user_id = employee.id AND identity.app_id = $1
       LEFT JOIN employee_notification_subscriptions subscription
         ON subscription.identity_id = identity.id AND subscription.template_id = $2
       WHERE task.status = 'AVAILABLE' AND task.visible_at <= $3 AND task.expires_at > $3
         AND task.visible_at >= $4 AND campaign.status IN ('APPROVED', 'ACTIVE')
         AND employee.status = 'ACTIVE' AND membership.status = 'ACTIVE' AND membership.seat_status = 'ENABLED'
         AND enterprise.status = 'ACTIVE' AND tenant.status = 'ACTIVE'
         AND participation.status = 'PARTICIPATING'
         AND NOT EXISTS (SELECT 1 FROM employee_task_notifications existing
                         WHERE existing.task_id = task.id AND existing.event = 'NEW_TASK')
       ORDER BY task.visible_at, task.id LIMIT $5
       ON CONFLICT (task_id, event) DO NOTHING RETURNING status`,
      [
        sms ? "" : configuration.appId,
        sms ? configuration.templateCode : configuration.templateId,
        this.clock().toISOString(),
        configuration.enabledAt.toISOString(),
        this.batchSize,
        sms ? "ALIYUN_SMS" : "WECHAT_TEMPLATE",
      ],
    );
    return {
      total: rows.length,
      skipped: rows.filter(({ status }) => status === "SKIPPED").length,
    };
  }

  private async claim(
    id: string,
    configuration: Configuration,
  ): Promise<Claim | "SKIPPED" | "FAILED" | null> {
    const transaction = await this.database.connect();
    try {
      await transaction.query("BEGIN");
      const now = this.clock();
      const found = await transaction.query<NotificationRow>(
        `SELECT *, recipient_phone_verified_at AT TIME ZONE 'UTC' AS recipient_phone_verified_at
         FROM employee_task_notifications
         WHERE id = $1 AND status = 'PENDING' AND next_attempt_at <= $2
         FOR UPDATE SKIP LOCKED`,
        [id, now.toISOString()],
      );
      const row = found.rows[0];
      if (!row) {
        await transaction.query("COMMIT");
        return null;
      }
      const task = (
        await transaction.query<TaskRow>(
          `SELECT membership.global_user_id AS user_id, campaign.title,
                enterprise.name AS enterprise_name,
                task.visible_at AT TIME ZONE 'UTC' AS visible_at,
                task.expires_at AT TIME ZONE 'UTC' AS expires_at,
                (task.status = 'AVAILABLE' AND task.visible_at <= $2 AND task.expires_at > $2
                 AND campaign.status IN ('APPROVED', 'ACTIVE') AND employee.status = 'ACTIVE'
                 AND membership.status = 'ACTIVE' AND membership.seat_status = 'ENABLED'
                 AND enterprise.status = 'ACTIVE' AND tenant.status = 'ACTIVE'
                 AND participation.status = 'PARTICIPATING') AS eligible
         FROM distribution_tasks task
         JOIN campaigns campaign ON campaign.id = task.campaign_id AND campaign.tenant_id = task.tenant_id
         JOIN enterprise_memberships membership ON membership.id = task.membership_id
         JOIN global_users employee ON employee.id = membership.global_user_id
         JOIN enterprises enterprise ON enterprise.id = task.enterprise_id AND enterprise.tenant_id = task.tenant_id
         JOIN tenants tenant ON tenant.id = task.tenant_id
         LEFT JOIN membership_participations participation ON participation.membership_id = membership.id
         WHERE task.id = $1`,
          [row.task_id, now.toISOString()],
        )
      ).rows[0];
      if (configuration.channel === "ALIYUN_SMS")
        return await this.claimSms(transaction, row, task, configuration, now);
      const identity = (
        await transaction.query<{ open_id: string; version: number }>(
          `SELECT open_id, version FROM wechat_miniapp_identities
         WHERE id = $1 AND user_id = $2 AND app_id = $3 FOR UPDATE`,
          [row.identity_id, row.user_id, row.app_id],
        )
      ).rows[0];
      let invalid =
        !task?.eligible || task.user_id !== row.user_id ? "TASK_NO_LONGER_ELIGIBLE" : null;
      if (
        row.channel !== "WECHAT_TEMPLATE" ||
        row.app_id !== configuration.appId ||
        row.template_id !== configuration.templateId
      )
        invalid = "NOTIFICATION_CONFIGURATION_CHANGED";
      if (!identity || identity.version !== row.identity_version)
        invalid = "WECHAT_IDENTITY_CHANGED";
      if (!invalid && task && task.visible_at < configuration.enabledAt)
        invalid = "NOTIFICATION_ENABLED_AFTER_TASK";
      if (invalid) {
        await releaseReservation(transaction, row, now);
        await skipNotification(transaction, row.id, invalid, now);
        await transaction.query("COMMIT");
        return "SKIPPED";
      }
      const subscription = (
        await transaction.query<{
          status: string;
          remaining_subscriptions: number;
          version: number;
          authorization_generation: number;
        }>(
          `SELECT status, remaining_subscriptions, version, authorization_generation FROM employee_notification_subscriptions
         WHERE id = $1 AND identity_id = $2 AND template_id = $3 FOR UPDATE`,
          [row.subscription_id, row.identity_id, row.template_id],
        )
      ).rows[0];
      if (
        row.subscription_reserved &&
        row.subscription_authorization_generation !== subscription?.authorization_generation
      ) {
        // A revocation invalidates old reservations even if the same identity
        // subsequently accepts again. Its new grants belong to another generation.
        await skipNotification(transaction, id, "SUBSCRIPTION_AUTHORIZATION_CHANGED", now);
        await transaction.query("COMMIT");
        return "SKIPPED";
      }
      if (
        subscription?.status !== "ACCEPT" ||
        (!row.subscription_reserved && subscription.remaining_subscriptions <= 0)
      ) {
        // A rejected/banned grant must never be resurrected by refunding it.
        await releaseReservation(transaction, row, now);
        await skipNotification(transaction, id, "SUBSCRIPTION_UNAVAILABLE", now);
        await transaction.query("COMMIT");
        return "SKIPPED";
      }
      if (row.attempts > configuration.retryLimit) {
        await releaseReservation(transaction, row, now);
        await transaction.query(
          `UPDATE employee_task_notifications
           SET status = 'FAILED', error_code = 'RETRY_LIMIT_EXHAUSTED',
               subscription_reserved = false, updated_at = $2 WHERE id = $1`,
          [id, now.toISOString()],
        );
        await transaction.query("COMMIT");
        return "FAILED";
      }
      if (!task || !identity) throw new Error("NOTIFICATION_CLAIM_INVALID");
      const deferredUntil = notificationQuietHoursEnd(
        now,
        configuration.quietHoursStart,
        configuration.quietHoursEnd,
      );
      if (deferredUntil) {
        if (task.expires_at <= deferredUntil) {
          await releaseReservation(transaction, row, now);
          await skipNotification(transaction, id, "TASK_EXPIRES_DURING_QUIET_HOURS", now);
          await transaction.query("COMMIT");
          return "SKIPPED";
        }
        await transaction.query(
          "UPDATE employee_task_notifications SET next_attempt_at = $2, updated_at = $3 WHERE id = $1",
          [id, deferredUntil.toISOString(), now.toISOString()],
        );
        await transaction.query("COMMIT");
        return null;
      }
      if (!row.subscription_reserved) {
        await transaction.query(
          `UPDATE employee_notification_subscriptions
           SET remaining_subscriptions = remaining_subscriptions - 1, updated_at = $2
           WHERE id = $1`,
          [row.subscription_id, now.toISOString()],
        );
      }
      const token = randomUUID();
      await transaction.query(
        `UPDATE employee_task_notifications
         SET status = 'SENDING', lease_token = $2, lease_until = $3,
             subscription_reserved = true, subscription_authorization_generation = $5,
             attempts = attempts + 1, updated_at = $4
         WHERE id = $1`,
        [
          id,
          token,
          new Date(now.getTime() + LEASE_MS).toISOString(),
          now.toISOString(),
          subscription.authorization_generation,
        ],
      );
      await transaction.query("COMMIT");
      return {
        row: {
          ...row,
          subscription_reserved: true,
          subscription_authorization_generation: subscription.authorization_generation,
          attempts: row.attempts + 1,
        },
        token,
        openId: identity.open_id,
        task,
        subscriptionVersion: subscription.version,
      };
    } catch (error) {
      await transaction.query("ROLLBACK");
      throw error;
    } finally {
      transaction.release();
    }
  }

  private async claimSms(
    transaction: PoolClient,
    row: NotificationRow,
    task: TaskRow | undefined,
    configuration: EmployeeSmsNotificationConfiguration,
    now: Date,
  ): Promise<Claim | "SKIPPED" | "FAILED" | null> {
    // The employee lock serializes the daily allowance across concurrent workers/tasks.
    const employee = (
      await transaction.query<{ phone: string; phone_verified_at: Date | null; status: string }>(
        `SELECT phone, phone_verified_at AT TIME ZONE 'UTC' AS phone_verified_at, status
         FROM global_users WHERE id = $1 FOR UPDATE`,
        [row.user_id],
      )
    ).rows[0];
    const membership = (
      await transaction.query<{
        phone: string;
        sms_notification_phone_version: number;
        sms_notification_status: string | null;
      }>(
        `SELECT membership.phone, membership.sms_notification_phone_version, membership.sms_notification_status
        FROM enterprise_memberships membership JOIN distribution_tasks task ON task.membership_id = membership.id
        WHERE task.id = $1 FOR UPDATE OF membership`,
        [row.task_id],
      )
    ).rows[0];
    let invalid =
      !task?.eligible || task.user_id !== row.user_id || employee?.status !== "ACTIVE"
        ? "TASK_NO_LONGER_ELIGIBLE"
        : null;
    if (row.channel !== "ALIYUN_SMS" || row.template_id !== configuration.templateCode)
      invalid = "NOTIFICATION_CONFIGURATION_CHANGED";
    if (
      !employee?.phone_verified_at ||
      !/^1[3-9]\d{9}$/u.test(employee.phone) ||
      employee.phone !== row.recipient_phone ||
      employee.phone_verified_at.getTime() !== row.recipient_phone_verified_at?.getTime() ||
      membership?.phone !== row.recipient_phone ||
      membership?.sms_notification_phone_version !== row.recipient_phone_version
    )
      invalid = "SMS_RECIPIENT_CHANGED";
    if (membership?.sms_notification_status === "NEEDS_REVIEW") invalid = "SMS_NUMBER_NEEDS_REVIEW";
    if (!invalid && task && task.visible_at < configuration.enabledAt)
      invalid = "NOTIFICATION_ENABLED_AFTER_TASK";
    if (invalid) {
      await releaseReservation(transaction, row, now);
      await skipNotification(transaction, row.id, invalid, now);
      await transaction.query("COMMIT");
      return "SKIPPED";
    }
    if (row.attempts > configuration.retryLimit) {
      await transaction.query(
        `UPDATE employee_task_notifications SET status = 'FAILED', error_code = 'RETRY_LIMIT_EXHAUSTED',
         updated_at = $2 WHERE id = $1`,
        [row.id, now.toISOString()],
      );
      await transaction.query("COMMIT");
      return "FAILED";
    }
    if (!task || !employee) throw new Error("NOTIFICATION_CLAIM_INVALID");
    let deferredUntil = notificationQuietHoursEnd(
      now,
      configuration.quietHoursStart,
      configuration.quietHoursEnd,
    );
    let deferralCode = "TASK_EXPIRES_DURING_QUIET_HOURS";
    if (!deferredUntil) {
      const dayStart = shanghaiDayStart(now);
      const used = await transaction.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM employee_task_notifications
         WHERE user_id = $1 AND channel = 'ALIYUN_SMS'
           AND status IN ('SENT', 'SENDING', 'UNKNOWN') AND last_attempt_at >= $2`,
        [row.user_id, dayStart.toISOString()],
      );
      if (Number(used.rows[0]?.count ?? 0) >= configuration.dailyLimit) {
        const tomorrow = new Date(dayStart.getTime() + 86_400_000);
        deferredUntil =
          notificationQuietHoursEnd(
            tomorrow,
            configuration.quietHoursStart,
            configuration.quietHoursEnd,
          ) ?? tomorrow;
        deferralCode = "TASK_EXPIRES_BEFORE_SMS_ALLOWANCE";
      }
    }
    if (deferredUntil) {
      if (task.expires_at <= deferredUntil) {
        await skipNotification(transaction, row.id, deferralCode, now);
        await transaction.query("COMMIT");
        return "SKIPPED";
      }
      await transaction.query(
        "UPDATE employee_task_notifications SET next_attempt_at = $2, updated_at = $3 WHERE id = $1",
        [row.id, deferredUntil.toISOString(), now.toISOString()],
      );
      await transaction.query("COMMIT");
      return null;
    }
    const token = randomUUID();
    await transaction.query(
      `UPDATE employee_task_notifications SET status = 'SENDING', lease_token = $2, lease_until = $3,
       attempts = attempts + 1, last_attempt_at = $4, updated_at = $4 WHERE id = $1`,
      [row.id, token, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString()],
    );
    await transaction.query("COMMIT");
    return {
      row: { ...row, attempts: row.attempts + 1 },
      token,
      phone: employee.phone,
      openId: "",
      task,
      subscriptionVersion: 0,
    };
  }

  private async send(
    claim: Claim,
    configuration: Configuration,
  ): Promise<"sent" | "skipped" | "failed" | "unknown" | null> {
    if (configuration.channel === "ALIYUN_SMS") return this.sendSms(claim);
    let failure: unknown;
    let failed = false;
    try {
      await this.sender.sendSubscription({
        appId: configuration.appId,
        appSecret: configuration.appSecret,
        openId: claim.openId,
        templateId: configuration.templateId,
        page: `pages/task-detail/task-detail?taskId=${encodeURIComponent(claim.row.task_id)}`,
        environment: configuration.environment,
        data: formatSubscriptionData(configuration.mapping, {
          title: claim.task.title,
          enterpriseName: claim.task.enterprise_name,
          visibleAt: claim.task.visible_at,
          expiresAt: claim.task.expires_at,
          remark: `${Array.from(claim.task.enterprise_name).slice(0, 8).join("")}｜打开小程序领取图文`,
          taskType: "图文发布",
          taskPlatform: "小红书",
          taskStatus: "待处理",
        }),
      });
    } catch (error) {
      failed = true;
      failure = error;
    }
    // Confirmation persistence failures remain SENDING and later become UNKNOWN;
    // they must not be interpreted as a provider rejection and refunded.
    if (!failed) {
      const confirmed = await this.database.query(
        `UPDATE employee_task_notifications
         SET status = 'SENT', sent_at = $3, error_code = NULL,
             lease_token = NULL, lease_until = NULL, updated_at = $3
         WHERE id = $1 AND status = 'SENDING' AND lease_token = $2`,
        [claim.row.id, claim.token, this.clock().toISOString()],
      );
      return confirmed.rowCount === 1 ? "sent" : null;
    }
    const providerError = failure instanceof WechatMiniappError ? failure : null;
    const uncertain = !providerError || providerError.disposition === "UNCERTAIN";
    const retry =
      providerError?.disposition === "RETRYABLE" && claim.row.attempts <= configuration.retryLimit;
    const status = uncertain ? "UNKNOWN" : retry ? "PENDING" : "FAILED";
    const code = providerError?.code ?? "SEND_RESULT_UNCERTAIN";
    const now = this.clock();
    const transaction = await this.database.connect();
    try {
      await transaction.query("BEGIN");
      const current = await transaction.query(
        `SELECT id FROM employee_task_notifications
         WHERE id = $1 AND status = 'SENDING' AND lease_token = $2 FOR UPDATE`,
        [claim.row.id, claim.token],
      );
      if (current.rowCount !== 1) {
        await transaction.query("COMMIT");
        return null;
      }
      if (code === "43101") {
        await transaction.query(
          `UPDATE employee_notification_subscriptions
           SET status = 'REJECT', remaining_subscriptions = 0, version = version + 1,
               authorization_generation = authorization_generation + 1, updated_at = $2
           WHERE id = $1 AND version = $3 AND authorization_generation = $4`,
          [
            claim.row.subscription_id,
            now.toISOString(),
            claim.subscriptionVersion,
            claim.row.subscription_authorization_generation,
          ],
        );
      } else if (!uncertain && !retry) {
        await releaseReservation(transaction, claim.row, now);
      }
      await transaction.query(
        `UPDATE employee_task_notifications
         SET status = $3, error_code = $4, next_attempt_at = $5,
             subscription_reserved = $6, lease_token = NULL, lease_until = NULL, updated_at = $7
         WHERE id = $1 AND lease_token = $2`,
        [
          claim.row.id,
          claim.token,
          status,
          code,
          new Date(
            now.getTime() + Math.min(60_000 * 2 ** Math.min(claim.row.attempts - 1, 5), 1_800_000),
          ).toISOString(),
          uncertain || retry,
          now.toISOString(),
        ],
      );
      await transaction.query("COMMIT");
    } catch (error) {
      await transaction.query("ROLLBACK");
      throw error;
    } finally {
      transaction.release();
    }
    return status === "UNKNOWN" ? "unknown" : status === "FAILED" ? "failed" : null;
  }

  private async sendSms(claim: Claim): Promise<"sent" | "skipped" | "failed" | "unknown" | null> {
    const phone = claim.phone;
    const eligible = await this.database.query(
      `SELECT task.id FROM distribution_tasks task
       JOIN campaigns campaign ON campaign.id = task.campaign_id AND campaign.tenant_id = task.tenant_id
       JOIN enterprise_memberships membership ON membership.id = task.membership_id
       JOIN global_users employee ON employee.id = membership.global_user_id
       JOIN enterprises enterprise ON enterprise.id = task.enterprise_id AND enterprise.tenant_id = task.tenant_id
       JOIN tenants tenant ON tenant.id = task.tenant_id
       JOIN membership_participations participation ON participation.membership_id = membership.id
       WHERE task.id = $1 AND task.status = 'AVAILABLE' AND task.visible_at <= $2 AND task.expires_at > $2
         AND campaign.status IN ('APPROVED', 'ACTIVE') AND employee.id = $3 AND employee.status = 'ACTIVE'
         AND employee.phone = $4 AND employee.phone_verified_at = $5
         AND membership.phone = $4 AND membership.sms_notification_phone_version = $6
         AND membership.sms_notification_status IS DISTINCT FROM 'NEEDS_REVIEW'
         AND membership.status = 'ACTIVE' AND membership.seat_status = 'ENABLED'
         AND enterprise.status = 'ACTIVE' AND tenant.status = 'ACTIVE' AND participation.status = 'PARTICIPATING'`,
      [
        claim.row.task_id,
        this.clock().toISOString(),
        claim.row.user_id,
        claim.phone,
        claim.row.recipient_phone_verified_at?.toISOString(),
        claim.row.recipient_phone_version,
      ],
    );
    const configuration = await this.configuration();
    if (
      this.stopped ||
      !phone ||
      !configuration ||
      configuration.channel !== "ALIYUN_SMS" ||
      configuration.templateCode !== claim.row.template_id ||
      configuration.enabledAt > claim.task.visible_at ||
      eligible.rowCount !== 1
    ) {
      const skipped = await this.database.query(
        `UPDATE employee_task_notifications SET status = 'SKIPPED', error_code = 'SMS_SEND_NO_LONGER_ALLOWED',
         lease_token = NULL, lease_until = NULL, updated_at = $3
         WHERE id = $1 AND status = 'SENDING' AND lease_token = $2`,
        [claim.row.id, claim.token, this.clock().toISOString()],
      );
      return skipped.rowCount === 1 ? "skipped" : null;
    }
    let failure: unknown;
    let failed = false;
    let receipt: Awaited<ReturnType<typeof sendAliyunSms>> | undefined;
    const dispatchedAt = this.clock();
    try {
      receipt = await this.smsSender(configuration, {
        phone,
        requestId: claim.row.id,
        templateCode: configuration.templateCode,
        templateParams: {},
      });
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (!failed && receipt) {
      const now = this.clock();
      const confirmed = await this.database.query(
        `UPDATE employee_task_notifications SET status = 'SENT', sent_at = $3, error_code = NULL,
         sms_biz_id = $4, sms_provider_request_id = $5, sms_delivery_status = 'PENDING',
         sms_next_query_at = $6, sms_query_attempts = 0,
         lease_token = NULL, lease_until = NULL, updated_at = $7
         WHERE id = $1 AND status = 'SENDING' AND lease_token = $2`,
        [
          claim.row.id,
          claim.token,
          dispatchedAt.toISOString(),
          receipt.messageId,
          receipt.requestId,
          new Date(now.getTime() + (SMS_QUERY_OFFSETS_MS[0] ?? 120_000)).toISOString(),
          now.toISOString(),
        ],
      );
      return confirmed.rowCount === 1 ? "sent" : null;
    }
    const providerError = failure instanceof AliyunSmsError ? failure : null;
    const uncertain = !providerError || providerError.uncertain;
    const retry =
      !uncertain && providerError?.retryable && claim.row.attempts <= configuration.retryLimit;
    const status = uncertain ? "UNKNOWN" : retry ? "PENDING" : "FAILED";
    const now = this.clock();
    const transaction = await this.database.connect();
    try {
      await transaction.query("BEGIN");
      const updated = await transaction.query(
        `UPDATE employee_task_notifications SET status = $3, error_code = $4, next_attempt_at = $5,
       sms_delivery_status = $7, sms_delivery_code = $8,
       lease_token = NULL, lease_until = NULL, updated_at = $6
       WHERE id = $1 AND status = 'SENDING' AND lease_token = $2`,
        [
          claim.row.id,
          claim.token,
          status,
          providerError?.providerCode ?? "SEND_RESULT_UNCERTAIN",
          new Date(
            now.getTime() + Math.min(60_000 * 2 ** Math.min(claim.row.attempts - 1, 5), 1_800_000),
          ).toISOString(),
          now.toISOString(),
          status === "FAILED" ? "FAILED" : null,
          status === "FAILED" ? (providerError?.providerCode ?? "SEND_RESULT_UNCERTAIN") : null,
        ],
      );
      if (updated.rowCount === 1 && status === "FAILED") {
        await updateSmsNumberStatus(
          transaction,
          claim.row,
          dispatchedAt,
          isInvalidAliyunSmsNumber(providerError?.providerCode) ? "NEEDS_REVIEW" : null,
          now,
        );
      }
      await transaction.query("COMMIT");
      return updated.rowCount !== 1
        ? null
        : status === "UNKNOWN"
          ? "unknown"
          : status === "FAILED"
            ? "failed"
            : null;
    } catch (error) {
      await transaction.query("ROLLBACK");
      throw error;
    } finally {
      transaction.release();
    }
  }

  private async querySmsDeliveries(): Promise<void> {
    const now = this.clock();
    const due = await this.database.query<{ id: string }>(
      `SELECT id FROM employee_task_notifications
      WHERE channel = 'ALIYUN_SMS' AND status = 'SENT' AND sms_delivery_status = 'PENDING'
        AND sms_biz_id IS NOT NULL AND sent_at IS NOT NULL AND sms_next_query_at <= $1
        AND (lease_until IS NULL OR lease_until <= $1)
      ORDER BY sms_next_query_at, id LIMIT $2`,
      [now.toISOString(), this.batchSize],
    );
    if (!due.rowCount) return;
    const credentials = await this.smsQueryConfiguration();
    if (!credentials) return;
    for (const { id } of due.rows) {
      if (this.stopped) break;
      const token = randomUUID();
      const claimed = await this.database.query<SmsDeliveryRow>(
        `UPDATE employee_task_notifications
        SET lease_token = $2, lease_until = $3, sms_query_attempts = sms_query_attempts + 1
        WHERE id = $1 AND sms_delivery_status = 'PENDING' AND sms_query_attempts < 4
          AND sms_next_query_at <= $4 AND (lease_until IS NULL OR lease_until <= $4)
        RETURNING *, sent_at AT TIME ZONE 'UTC' AS sent_at`,
        [
          id,
          token,
          new Date(this.clock().getTime() + LEASE_MS).toISOString(),
          this.clock().toISOString(),
        ],
      );
      const row = claimed.rows[0];
      if (!row) {
        await this.database.query(
          `UPDATE employee_task_notifications SET sms_delivery_status = 'UNKNOWN',
          sms_next_query_at = NULL, lease_token = NULL, lease_until = NULL, updated_at = $2
          WHERE id = $1 AND sms_delivery_status = 'PENDING' AND sms_query_attempts >= 4
            AND (lease_until IS NULL OR lease_until <= $2)`,
          [id, this.clock().toISOString()],
        );
        continue;
      }
      let delivery: AliyunSmsDeliveryResult | null = null;
      let queryError: string | null = null;
      try {
        if (row.recipient_phone)
          delivery = await this.smsQuery(credentials, {
            phone: row.recipient_phone,
            bizId: row.sms_biz_id,
            requestId: row.id,
            templateCode: row.template_id,
            sentAt: row.sent_at,
          });
      } catch (error) {
        queryError =
          error instanceof AliyunSmsError ? error.providerCode : "QUERY_RESULT_UNCERTAIN";
      }
      const nextOffset = SMS_QUERY_OFFSETS_MS[row.sms_query_attempts];
      const status =
        delivery?.status === "DELIVERED" || delivery?.status === "FAILED"
          ? delivery.status
          : nextOffset
            ? "PENDING"
            : "UNKNOWN";
      const completedAt = this.clock();
      const next =
        status === "PENDING" && nextOffset
          ? new Date(Math.max(row.sent_at.getTime() + nextOffset, completedAt.getTime() + 60_000))
          : null;
      const transaction = await this.database.connect();
      try {
        await transaction.query("BEGIN");
        const updated = await transaction.query(
          `UPDATE employee_task_notifications
          SET sms_delivery_status = $3, sms_delivery_code = $4, sms_delivered_at = $5,
            sms_next_query_at = $6, lease_token = NULL, lease_until = NULL, updated_at = $7
          WHERE id = $1 AND lease_token = $2 AND sms_delivery_status = 'PENDING'`,
          [
            id,
            token,
            status,
            delivery?.code ?? queryError,
            delivery?.deliveredAt?.toISOString() ?? null,
            next?.toISOString() ?? null,
            completedAt.toISOString(),
          ],
        );
        if (updated.rowCount === 1 && delivery?.status === "DELIVERED")
          await updateSmsNumberStatus(transaction, row, row.sent_at, "NORMAL", completedAt);
        else if (updated.rowCount === 1 && delivery?.status === "FAILED")
          await updateSmsNumberStatus(
            transaction,
            row,
            row.sent_at,
            isInvalidAliyunSmsNumber(delivery.code) ? "NEEDS_REVIEW" : null,
            completedAt,
          );
        await transaction.query("COMMIT");
      } catch (error) {
        await transaction.query("ROLLBACK");
        throw error;
      } finally {
        transaction.release();
      }
    }
  }
}

async function updateSmsNumberStatus(
  database: Pool | PoolClient,
  row: NotificationRow,
  sentAt: Date,
  status: "NORMAL" | "NEEDS_REVIEW" | null,
  now: Date,
) {
  await database.query(
    `UPDATE enterprise_memberships membership
    SET sms_notification_status = $4,
      sms_notification_status_at = CASE WHEN $4::text IS NULL THEN membership.sms_notification_status_at ELSE $5 END,
      updated_at = $6
    FROM distribution_tasks task WHERE task.id = $1 AND task.membership_id = membership.id
      AND membership.phone = $2 AND membership.sms_notification_phone_version = $3
      AND (membership.sms_notification_status_at IS NULL OR membership.sms_notification_status_at <= $5)
      AND ($4::text IS NOT NULL OR membership.sms_notification_status = 'PENDING_VERIFICATION')`,
    [
      row.task_id,
      row.recipient_phone,
      row.recipient_phone_version,
      status,
      sentAt.toISOString(),
      now.toISOString(),
    ],
  );
}

function shanghaiDayStart(now: Date): Date {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - SHANGHAI_OFFSET_MS,
  );
}

async function releaseReservation(
  transaction: PoolClient,
  row: NotificationRow,
  now: Date,
): Promise<void> {
  if (!row.subscription_reserved || !row.subscription_id) return;
  await transaction.query(
    `UPDATE employee_notification_subscriptions subscription
     SET remaining_subscriptions = remaining_subscriptions + 1, updated_at = $4
     FROM wechat_miniapp_identities identity
     WHERE subscription.id = $1 AND subscription.identity_id = identity.id AND subscription.status = 'ACCEPT'
       AND identity.id = $2 AND identity.version = $3 AND subscription.authorization_generation = $5`,
    [
      row.subscription_id,
      row.identity_id,
      row.identity_version,
      now.toISOString(),
      row.subscription_authorization_generation,
    ],
  );
}

async function skipNotification(
  transaction: PoolClient,
  id: string,
  code: string,
  now: Date,
): Promise<void> {
  await transaction.query(
    `UPDATE employee_task_notifications
     SET status = 'SKIPPED', error_code = $2, subscription_reserved = false,
         lease_token = NULL, lease_until = NULL, updated_at = $3 WHERE id = $1`,
    [id, code, now.toISOString()],
  );
}

// Asia/Shanghai has a fixed UTC+08 offset. Using an explicit offset avoids the
// container timezone affecting quiet hours, including windows crossing midnight.
export function notificationQuietHoursEnd(now: Date, start: string, end: string): Date | null {
  const startMinute = parseMinute(start);
  const endMinute = parseMinute(end);
  if (startMinute === endMinute) return null;
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const inQuietHours =
    startMinute < endMinute
      ? minute >= startMinute && minute < endMinute
      : minute >= startMinute || minute < endMinute;
  if (!inQuietHours) return null;
  const localEnd = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    0,
    endMinute,
  );
  return new Date(localEnd - SHANGHAI_OFFSET_MS + (minute >= endMinute ? 86_400_000 : 0));
}

function parseMinute(value: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value))
    throw new Error("NOTIFICATION_QUIET_HOURS_INVALID");
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

async function loadSettings(database: Pool) {
  const { rows } = await database.query<{
    key: string;
    value: unknown;
    updated_at: Date;
    authentication_tag: Buffer | null;
    ciphertext: Buffer | null;
    initialization_vector: Buffer | null;
    key_version: string | null;
  }>(
    "SELECT *, updated_at AT TIME ZONE 'UTC' AS updated_at FROM platform_settings WHERE key = ANY($1::text[])",
    [SETTING_KEYS],
  );
  return new Map(rows.map((row) => [row.key, row]));
}

function readSmsCredentials(
  settings: Awaited<ReturnType<typeof loadSettings>>,
): AliyunSmsConfiguration | null {
  const decryptSetting = (key: string, environmentVariable: string): string => {
    const row = settings.get(key);
    if (!row) return process.env[environmentVariable]?.trim() ?? "";
    if (
      !row.authentication_tag ||
      !row.ciphertext ||
      !row.initialization_vector ||
      !row.key_version
    )
      throw new Error("NOTIFICATION_CONFIGURATION_INVALID");
    return ModelCredentialCipher.fromEnvironment()
      .decrypt(
        {
          authenticationTag: row.authentication_tag,
          ciphertext: row.ciphertext,
          initializationVector: row.initialization_vector,
          keyVersion: row.key_version,
        },
        `xhs-agentic:platform-setting:${key}`,
      )
      .trim();
  };
  const accessKeyId = decryptSetting(
    "security.admin_sms_access_key_id",
    "ALIYUN_SMS_ACCESS_KEY_ID",
  );
  const accessKeySecret = decryptSetting(
    "security.admin_sms_access_key_secret",
    "ALIYUN_SMS_ACCESS_KEY_SECRET",
  );
  const signName =
    settings.get("security.admin_sms_sign_name")?.value ?? process.env.ALIYUN_SMS_SIGN_NAME ?? "";
  if (typeof signName !== "string") throw new Error("NOTIFICATION_CONFIGURATION_INVALID");
  return accessKeyId && accessKeySecret
    ? { accessKeyId, accessKeySecret, signName: signName.trim() }
    : null;
}

async function loadSmsCredentials(database: Pool): Promise<AliyunSmsConfiguration | null> {
  return readSmsCredentials(await loadSettings(database));
}

async function loadConfiguration(database: Pool): Promise<Configuration | null> {
  const settings = await loadSettings(database);
  const enabled = settings.get("notification.enabled");
  if (enabled?.value !== true) return null;
  const channel = settings.get("notification.channel")?.value ?? "WECHAT_TEMPLATE";
  if (channel === "NONE") return null;
  if (!["WECHAT_TEMPLATE", "ALIYUN_SMS"].includes(String(channel)))
    throw new Error("NOTIFICATION_CONFIGURATION_INVALID");
  const text = (key: string, fallback = "") => {
    const value = settings.get(key)?.value ?? fallback;
    if (typeof value !== "string") throw new Error("NOTIFICATION_CONFIGURATION_INVALID");
    return value;
  };
  const retryLimit = settings.get("notification.retry_limit")?.value ?? 3;
  if (
    typeof retryLimit !== "number" ||
    !Number.isInteger(retryLimit) ||
    retryLimit < 0 ||
    retryLimit > 20
  )
    throw new Error("NOTIFICATION_CONFIGURATION_INVALID");
  const quietHoursStart = text("notification.quiet_hours_start", "22:00");
  const quietHoursEnd = text("notification.quiet_hours_end", "08:00");
  parseMinute(quietHoursStart);
  parseMinute(quietHoursEnd);
  const common = { enabledAt: enabled.updated_at, quietHoursStart, quietHoursEnd, retryLimit };
  if (channel === "ALIYUN_SMS") {
    const credentials = readSmsCredentials(settings);
    const templateCode = text("notification.sms_template_code").trim();
    const dailyLimit = settings.get("notification.sms_daily_limit")?.value ?? 3;
    if (
      !credentials?.signName ||
      !/^SMS_\d+$/u.test(templateCode) ||
      typeof dailyLimit !== "number" ||
      !Number.isInteger(dailyLimit) ||
      dailyLimit < 1 ||
      dailyLimit > 50
    )
      throw new Error("NOTIFICATION_CONFIGURATION_INVALID");
    return {
      ...common,
      channel: "ALIYUN_SMS",
      ...credentials,
      templateCode,
      dailyLimit,
    };
  }
  const appId = text("miniapp.wechat_app_id");
  const templateId = text("notification.wechat_template_id");
  const environment = text("notification.wechat_environment", "formal");
  const secret = settings.get("miniapp.wechat_app_secret");
  if (
    !/^wx[0-9a-f]{16}$/u.test(appId) ||
    !templateId ||
    !secret?.authentication_tag ||
    !secret.ciphertext ||
    !secret.initialization_vector ||
    !secret.key_version ||
    !["developer", "trial", "formal"].includes(environment)
  )
    throw new Error("NOTIFICATION_CONFIGURATION_INVALID");
  return {
    ...common,
    appId,
    appSecret: ModelCredentialCipher.fromEnvironment().decrypt(
      {
        authenticationTag: secret.authentication_tag,
        ciphertext: secret.ciphertext,
        initializationVector: secret.initialization_vector,
        keyVersion: secret.key_version,
      },
      "xhs-agentic:platform-setting:miniapp.wechat_app_secret",
    ),
    environment: environment as EmployeeNotificationConfiguration["environment"],
    mapping: parseSubscriptionTemplateMapping(text("notification.wechat_template_fields")),
    templateId,
  };
}

function emptyResult(): NotificationResult {
  return { enqueued: 0, sent: 0, skipped: 0, failed: 0, unknown: 0 };
}
