import { afterEach, describe, expect, it, vi } from "vitest";
import { EmployeeNotificationsService } from "../employee-notifications/employee-notifications.service";
import { validateMaterialNotificationConfiguration } from "./material-notification.configuration";
import { platformSettingCatalog, platformSettingDefinition } from "./platform-setting-catalog";
import { validatePlatformSettingValue } from "./platform-setting-values";
import type { ResolvedPlatformSetting } from "./platform-settings.reader";
import { PlatformSettingsService } from "./platform-settings.service";

const smsSettings = {
  "notification.enabled": true,
  "notification.channel": "ALIYUN_SMS",
  "notification.sms_template_code": "SMS_987654",
  "notification.sms_daily_limit": 3,
  "security.admin_sms_access_key_id": "LTAI0123456789",
  "security.admin_sms_access_key_secret": "AliyunRealKey0123456789",
  "security.admin_sms_sign_name": "企声共创",
};

function configured(overrides: Record<string, unknown> = {}) {
  return new Map(
    Object.entries({ ...smsSettings, ...overrides }).map(([key, value]) => [key, { value }]),
  );
}

afterEach(() => vi.unstubAllEnvs());

describe("material notification channel configuration", () => {
  it("uses an independent notification template without requiring login SMS or WeChat settings", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => validateMaterialNotificationConfiguration(configured())).not.toThrow();
    expect(platformSettingDefinition("notification.enabled")?.defaultValue).toBe(false);
    expect(platformSettingDefinition("notification.wechat_template_id")?.defaultValue).toBe("");
    expect(platformSettingDefinition("notification.sms_daily_limit")?.defaultValue).toBe(3);
  });

  it.each([
    ["notification.sms_template_code", ""],
    ["notification.sms_template_code", "LOGIN_TEMPLATE"],
    ["notification.sms_daily_limit", 0],
    ["notification.sms_daily_limit", 51],
    ["notification.sms_daily_limit", 1.5],
    ["security.admin_sms_access_key_id", ""],
    ["security.admin_sms_access_key_secret", ""],
    ["security.admin_sms_sign_name", ""],
    ["security.admin_sms_access_key_secret", "dev-placeholder"],
  ])("rejects incomplete or unsafe SMS setting %s=%j", (key, value) => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() =>
      validateMaterialNotificationConfiguration(configured({ [key as string]: value })),
    ).toThrow();
  });

  it("validates template format and daily limit at the API setting boundary", () => {
    const template = platformSettingDefinition("notification.sms_template_code");
    const limit = platformSettingDefinition("notification.sms_daily_limit");
    if (!template || !limit) throw new Error("SMS setting definitions are missing");
    expect(validatePlatformSettingValue(template, "SMS_123456")).toBe("SMS_123456");
    for (const value of ["123456", "SMS_code", "SMS_123{code}"])
      expect(() => validatePlatformSettingValue(template, value)).toThrow();
    for (const value of [0, 51, 1.5, "3"])
      expect(() => validatePlatformSettingValue(limit, value)).toThrow();
    expect(validatePlatformSettingValue(limit, 50)).toBe(50);
  });

  it("does not prompt SMS recipients to link WeChat or authorize subscription messages", async () => {
    const identity = vi.fn();
    const exchangeCode = vi.fn();
    const resolveMany = vi.fn(async (_keys: readonly string[]) => configured());
    const service = new EmployeeNotificationsService(
      { wechatMiniappIdentity: { findUnique: identity } } as never,
      { requireEmployee: () => ({ userId: "employee" }) } as never,
      { resolveMany } as never,
      { exchangeCode } as never,
    );
    await expect(service.configuration()).resolves.toMatchObject({
      enabled: false,
      appId: null,
      templateId: null,
      remainingSubscriptions: 0,
    });
    await expect(service.linkIdentity({ code: "unused-login-code" })).rejects.toThrow();
    expect(identity).not.toHaveBeenCalled();
    expect(exchangeCode).not.toHaveBeenCalled();
    for (const [keys] of resolveMany.mock.calls)
      expect(keys).toEqual(["notification.enabled", "notification.channel"]);
  });
});

describe("material notification settings updates", () => {
  function fixture(overrides: Record<string, unknown> = {}) {
    const values = new Map<string, ResolvedPlatformSetting>(
      platformSettingCatalog
        .filter(({ store }) => store === "PLATFORM_SETTING")
        .map(({ key, defaultValue }) => [
          key,
          {
            value: defaultValue,
            configured: true,
            source: "DEFAULT",
            lastFour: null,
            updatedAt: null,
            updatedBy: null,
            version: null,
          },
        ]),
    );
    for (const [key, value] of Object.entries({ ...smsSettings, ...overrides })) {
      const before = values.get(key);
      if (before) values.set(key, { ...before, value: value as ResolvedPlatformSetting["value"] });
    }
    const upsert = vi.fn(async ({ where: { key }, create, update }) => {
      const previous = values.get(key);
      if (previous) values.set(key, { ...previous, value: update.value ?? create.value });
      return { secretLastFour: null, updatedAt: new Date(), updatedBy: "admin", version: 1 };
    });
    const transaction = { platformSetting: { upsert }, auditLog: { create: vi.fn() } };
    const service = new PlatformSettingsService(
      {
        $transaction: async (operation: (client: unknown) => Promise<unknown>) =>
          operation(transaction),
        modelDefinition: { findMany: async () => [] },
      } as never,
      { requireSaasAdmin: () => ({ userId: "admin", scope: { type: "PLATFORM" } }) } as never,
      {
        resolve: async (key: string) => values.get(key),
        resolveMany: async (keys: readonly string[]) =>
          new Map(keys.map((key) => [key, values.get(key)])),
      } as never,
      { encrypt: () => ({}) } as never,
      { current: async () => ({ updatedAt: new Date(), updatedBy: "admin" }) } as never,
      {} as never,
    );
    return { service, upsert };
  }

  it("keeps pending SMS configuration editable while the total switch is disabled", async () => {
    const { service } = fixture({
      "notification.enabled": false,
      "notification.sms_template_code": "",
      "security.admin_sms_access_key_id": "",
    });
    await expect(
      service.update("notification.channel", { value: "ALIYUN_SMS", reason: "配置通知渠道" }),
    ).resolves.toMatchObject({ value: "ALIYUN_SMS" });
    await expect(
      service.update("notification.enabled", { value: true, reason: "开启通知" }),
    ).rejects.toMatchObject({ response: { code: "MATERIAL_SMS_SETTINGS_INCOMPLETE" } });
  });

  it.each([
    ["notification.sms_template_code", ""],
    ["security.admin_sms_access_key_secret", ""],
    ["security.admin_sms_sign_name", ""],
    ["notification.channel", "NONE"],
    ["notification.channel", "WECHAT_TEMPLATE"],
  ])("refuses to break an enabled channel through %s", async (key, value) => {
    const { service, upsert } = fixture();
    await expect(service.update(key, { value, reason: "验证通知完整性" })).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("enables complete SMS configuration, snapshots the independent template and can be disabled", async () => {
    const { service, upsert } = fixture({ "notification.enabled": false });
    await expect(
      service.update("notification.enabled", { value: true, reason: "开启通知" }),
    ).resolves.toMatchObject({ value: true });
    expect(
      upsert.mock.calls.some(([input]) => input.where.key === "notification.sms_template_code"),
    ).toBe(true);
    expect(
      upsert.mock.calls.some(([input]) => input.where.key === "security.admin_sms_template_code"),
    ).toBe(false);
    await expect(
      service.update("notification.enabled", { value: false, reason: "关闭通知" }),
    ).resolves.toMatchObject({ value: false });
  });
});
