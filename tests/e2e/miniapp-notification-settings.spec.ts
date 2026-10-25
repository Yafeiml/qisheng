import { expect, type Page, test } from "@playwright/test";

const templateId = "F2Vwz548apm3jIVCeJDwsaMr3q9h1vKXtwCBT8oPP6c";
const templateFields = {
  thing4: "TASK_TITLE",
  time5: "EXPIRES_AT",
  thing12: "TASK_TYPE",
  thing11: "REMARK",
  thing13: "TASK_PLATFORM",
};

async function mockNotificationSettings(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
    ),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "mock-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/session", (route) =>
    route.fulfill({
      json: {
        userId: "admin",
        phone: "13800000000",
        features: {},
        scopes: [
          {
            scopeType: "PLATFORM",
            role: { code: "PLATFORM_ADMIN", name: "平台管理员" },
            permissions: ["platform.settings.manage"],
          },
        ],
      },
    }),
  );
  const values: Record<string, string | number | boolean | null> = {
    "miniapp.wechat_app_id": "wx1111111111111111",
    "miniapp.wechat_app_secret": null,
    "miniapp.debug_code_enabled": false,
    "miniapp.debug_code_phones": "",
    "miniapp.debug_code_ips": "",
    "miniapp.debug_code_until": "",
    "notification.enabled": false,
    "notification.channel": "WECHAT_TEMPLATE",
    "notification.wechat_template_id": "",
    "notification.wechat_template_fields": "{}",
    "notification.wechat_environment": "formal",
    "notification.sms_template_code": "",
    "notification.sms_daily_limit": 3,
    "notification.retry_limit": 3,
    "notification.quiet_hours_start": "22:00",
    "notification.quiet_hours_end": "08:00",
  };
  const labels: Record<string, string> = {
    "miniapp.wechat_app_id": "微信小程序 AppID",
    "miniapp.wechat_app_secret": "微信小程序 AppSecret",
    "miniapp.debug_code_enabled": "启用临时调试验证码",
    "miniapp.debug_code_phones": "测试员工手机号",
    "miniapp.debug_code_ips": "允许来源 IP",
    "miniapp.debug_code_until": "调试通道截止时间",
    "notification.enabled": "素材开放通知总开关",
    "notification.channel": "默认通知渠道",
    "notification.wechat_template_id": "新任务通知模板 ID",
    "notification.wechat_template_fields": "订阅模板字段映射",
    "notification.wechat_environment": "消息跳转小程序版本",
    "notification.sms_template_code": "素材开放短信模板代码",
    "notification.sms_daily_limit": "每位员工每日短信上限",
    "notification.retry_limit": "通知重试次数",
    "notification.quiet_hours_start": "免打扰开始时间",
    "notification.quiet_hours_end": "免打扰结束时间",
  };
  const options: Record<string, { label: string; value: string }[]> = {
    "notification.channel": [
      { label: "微信小程序订阅消息", value: "WECHAT_TEMPLATE" },
      { label: "阿里云短信", value: "ALIYUN_SMS" },
      { label: "不发送通知", value: "NONE" },
    ],
    "notification.wechat_environment": [
      { label: "正式版", value: "formal" },
      { label: "体验版", value: "trial" },
      { label: "开发版", value: "developer" },
    ],
  };
  const settingsResponse = () => ({
    groups: [
      {
        group: "MINIAPP",
        slug: "miniapp",
        label: "小程序设置",
        mark: "微",
        description: "微信身份、员工素材开放通知及临时调试验证码配置",
        configuredCount: Object.keys(values).length,
        totalCount: Object.keys(values).length,
        settings: Object.entries(values).map(([key, value]) => ({
          key,
          value,
          label: labels[key],
          group: "MINIAPP",
          description:
            key === "notification.enabled"
              ? "素材开放通知总开关，关闭后所有渠道停止发送。"
              : "平台管理员配置，保存后生效。",
          configured: true,
          maskedValue: key === "miniapp.wechat_app_secret" ? "已加密保存" : null,
          max: key === "notification.sms_daily_limit" ? 50 : null,
          min: key === "notification.sms_daily_limit" ? 1 : null,
          maxLength: 2048,
          minLength: null,
          nullable: value === null,
          options: options[key] ?? [],
          restartRequired: false,
          secret: key === "miniapp.wechat_app_secret",
          source: "DATABASE",
          step: 1,
          store: "PLATFORM_SETTING",
          unit: null,
          updatedAt: null,
          updatedBy: null,
          valueType:
            key === "miniapp.wechat_app_secret"
              ? "SECRET"
              : options[key]
                ? "ENUM"
                : typeof value === "boolean"
                  ? "BOOLEAN"
                  : typeof value === "number"
                    ? "INTEGER"
                    : "STRING",
          version: 1,
        })),
      },
    ],
  });
  await page.route("**/platform/settings", (route) => route.fulfill({ json: settingsResponse() }));
  const saves: { key: string; value: unknown; reason: string }[] = [];
  const debugSaves: unknown[] = [];
  await page.route("**/platform/settings/*", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const key = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? "");
    const body = route.request().postDataJSON();
    if (key === "miniapp-debug") {
      debugSaves.push(body);
      return route.fulfill({ json: {} });
    }
    saves.push({ key, ...body });
    // Secret values must never be returned by the settings API.
    if (key !== "miniapp.wechat_app_secret") values[key] = body.value;
    return route.fulfill({ json: {} });
  });
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  return { saves, debugSaves, consoleErrors };
}

test("WeChat material notification settings save configuration before enabling without changing debug settings", async ({
  page,
}, testInfo) => {
  const { saves, debugSaves, consoleErrors } = await mockNotificationSettings(page);
  await page.goto("/platform/settings/miniapp");
  const preset = page.getByRole("button", { name: "填入新任务通知模板" });
  await preset.click();
  await expect(page.getByRole("textbox", { name: "新任务通知模板 ID" })).toHaveValue(templateId);
  const fields = page.getByRole("textbox", { name: "订阅模板字段映射" });
  expect(JSON.parse(await fields.inputValue())).toEqual(templateFields);
  await expect(fields).toHaveJSProperty("tagName", "TEXTAREA");
  const secret = page
    .getByRole("article", { name: "微信小程序 AppSecret", exact: true })
    .locator("input");
  await expect(secret).toHaveAttribute("type", "password");
  await expect(secret).toHaveValue("");
  await expect(secret).toHaveAttribute("placeholder", "已加密保存");
  await page.getByRole("combobox", { name: "消息跳转小程序版本" }).selectOption("trial");
  await page
    .getByRole("group", { name: "素材开放通知总开关", exact: true })
    .getByRole("button", { name: "启用", exact: true })
    .click();
  await page.getByLabel("本次变更原因").fill("接入新任务订阅提醒");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await preset.scrollIntoViewIfNeeded();
    await expect(preset).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: testInfo.outputPath(`notification-header-${width}.png`) });
    await fields.scrollIntoViewIfNeeded();
    await fields.focus();
    await expect(fields).toBeFocused();
    const toggle = page.getByRole("group", { name: "素材开放通知总开关", exact: true });
    const enabled = toggle.getByRole("button", { name: "启用", exact: true });
    await expect(enabled).toHaveAttribute("aria-pressed", "true");
    const buttonBox = await enabled.boundingBox();
    expect(buttonBox?.height).toBeGreaterThanOrEqual(36);
    expect(buttonBox?.width).toBeLessThan(160);
    await page.screenshot({ path: testInfo.outputPath(`notification-controls-${width}.png`) });
  }
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(
    page.getByRole("status").getByText("4 项参数已保存到数据库并写入审计记录"),
  ).toBeVisible();
  expect(saves).toEqual([
    { key: "notification.wechat_template_id", value: templateId, reason: "接入新任务订阅提醒" },
    {
      key: "notification.wechat_template_fields",
      value: JSON.stringify(templateFields),
      reason: "接入新任务订阅提醒",
    },
    { key: "notification.wechat_environment", value: "trial", reason: "接入新任务订阅提醒" },
    { key: "notification.enabled", value: true, reason: "接入新任务订阅提醒" },
  ]);
  expect(debugSaves).toEqual([]);
  await expect(secret).toHaveValue("");
  await expect(page.getByRole("button", { name: "保存更改", exact: true })).toBeDisabled();
  // Disabling must happen before editing dependent configuration.
  await page
    .getByRole("group", { name: "素材开放通知总开关", exact: true })
    .getByRole("button", { name: "禁用", exact: true })
    .click();
  await page.getByRole("combobox", { name: "消息跳转小程序版本" }).selectOption("developer");
  await page.getByLabel("本次变更原因").fill("暂停通知进行联调");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(
    page.getByRole("status").getByText("2 项参数已保存到数据库并写入审计记录"),
  ).toBeVisible();
  expect(saves.slice(4)).toEqual([
    { key: "notification.enabled", value: false, reason: "暂停通知进行联调" },
    { key: "notification.wechat_environment", value: "developer", reason: "暂停通知进行联调" },
  ]);
  expect(debugSaves).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("SMS material notification settings use an independent template and save the master switch last", async ({
  page,
}, testInfo) => {
  const { saves, debugSaves, consoleErrors } = await mockNotificationSettings(page);
  await page.goto("/platform/settings/miniapp");
  const channel = page.getByRole("combobox", { name: "默认通知渠道" });
  await expect(page.getByRole("textbox", { name: "素材开放短信模板代码" })).toHaveCount(0);
  await channel.selectOption("ALIYUN_SMS");
  await expect(page.getByRole("textbox", { name: "新任务通知模板 ID" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "订阅模板字段映射" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "填入新任务通知模板" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "安全设置中的短信通道" })).toHaveAttribute(
    "href",
    "/platform/settings/security",
  );
  await expect(page.getByText(/不使用验证码模板或验证码字段/u)).toBeVisible();
  const template = page.getByRole("textbox", { name: "素材开放短信模板代码" });
  const dailyLimit = page.getByRole("spinbutton", { name: "每位员工每日短信上限" });
  await expect(dailyLimit).toHaveValue("3");
  await template.fill("SMS_987654321");
  await dailyLimit.fill("5");
  const toggle = page.getByRole("group", { name: "素材开放通知总开关", exact: true });
  const enabled = toggle.getByRole("button", { name: "启用", exact: true });
  const save = page.getByRole("button", { name: "保存更改", exact: true });
  await enabled.click();
  await page.getByLabel("本次变更原因").fill("启用素材开放短信通知");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await toggle.scrollIntoViewIfNeeded();
    await expect(enabled).toHaveAttribute("aria-pressed", "true");
    await enabled.focus();
    await expect(enabled).toBeFocused();
    const buttonBox = await enabled.boundingBox();
    expect(buttonBox?.height).toBeGreaterThanOrEqual(36);
    expect(buttonBox?.width).toBeLessThan(160);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: testInfo.outputPath(`sms-switch-${width}.png`) });
    await channel.scrollIntoViewIfNeeded();
    await channel.focus();
    await expect(channel).toBeFocused();
    expect((await channel.boundingBox())?.height).toBeGreaterThanOrEqual(38);
    await template.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`sms-template-${width}.png`) });
    await save.scrollIntoViewIfNeeded();
    await save.focus();
    await expect(save).toBeFocused();
    const saveBox = await save.boundingBox();
    expect(saveBox?.height).toBeGreaterThanOrEqual(40);
    expect(saveBox?.width).toBeLessThan(width === 1440 ? 200 : width);
  }
  await save.click();
  await expect(
    page.getByRole("status").getByText("4 项参数已保存到数据库并写入审计记录"),
  ).toBeVisible();
  expect(saves).toEqual([
    {
      key: "notification.sms_template_code",
      value: "SMS_987654321",
      reason: "启用素材开放短信通知",
    },
    { key: "notification.sms_daily_limit", value: 5, reason: "启用素材开放短信通知" },
    { key: "notification.channel", value: "ALIYUN_SMS", reason: "启用素材开放短信通知" },
    { key: "notification.enabled", value: true, reason: "启用素材开放短信通知" },
  ]);
  await expect(save).toBeDisabled();
  await toggle.getByRole("button", { name: "禁用", exact: true }).click();
  await template.fill("SMS_123456789");
  await page.getByLabel("本次变更原因").fill("暂停素材通知并更换模板");
  await save.click();
  await expect(
    page.getByRole("status").getByText("2 项参数已保存到数据库并写入审计记录"),
  ).toBeVisible();
  expect(saves.slice(4)).toEqual([
    { key: "notification.enabled", value: false, reason: "暂停素材通知并更换模板" },
    {
      key: "notification.sms_template_code",
      value: "SMS_123456789",
      reason: "暂停素材通知并更换模板",
    },
  ]);
  expect(debugSaves).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
