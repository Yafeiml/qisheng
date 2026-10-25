import { expect, type Page, test } from "@playwright/test";

async function fixture(page: Page, configured = false) {
  const state = {
    accessKeyIdConfigured: configured,
    accessKeySecretConfigured: configured,
    accessKeyIdHint: configured ? "••••1234" : (null as string | null),
    signName: configured ? "已保存签名" : "",
    templateCode: configured ? "SMS_123456" : "",
    configured,
    enabled: configured,
  };
  const saves: Record<string, string>[] = [];
  const tests: Record<string, string>[] = [];
  await page.route("**/platform/settings", (route) =>
    route.fulfill({
      json: {
        groups: [
          {
            group: "SECURITY",
            slug: "security",
            label: "安全设置",
            mark: "安",
            description: "管理员登录与会话",
            configuredCount: 0,
            totalCount: 1,
            settings: [
              {
                key: "security.admin_sms_mode",
                label: "管理员验证码通道",
                configured: false,
                value: "DEVELOPMENT",
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route("**/platform/settings/admin-sms", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      saves.push(body);
      Object.assign(state, {
        accessKeyIdConfigured: true,
        accessKeySecretConfigured: true,
        accessKeyIdHint: "••••1234",
        signName: body.signName,
        templateCode: body.templateCode,
        configured: true,
        enabled: true,
      });
    }
    await route.fulfill({ json: state });
  });
  await page.route("**/platform/settings/admin-sms/test", async (route) => {
    tests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        status: "ACCEPTED",
        provider: "ALIYUN",
        phoneMasked: "138****8000",
        requestId: "aliyun-request-id",
        messageId: "aliyun-message-id",
      },
    });
  });
  return { state, saves, tests };
}

test("Aliyun needs four configuration fields and sends tests using the saved settings", async ({
  page,
}) => {
  const { saves, tests } = await fixture(page);
  await page.goto("/platform/settings/security");
  const form = page.getByRole("form", { name: "阿里云短信配置", exact: true });
  await expect(form.locator("input")).toHaveCount(4);
  await expect(page.getByText("管理员验证码通道", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送测试短信", exact: true })).toBeDisabled();
  await page.getByLabel("ACCESS_KEY_ID", { exact: true }).fill("LTAI-test-access-1234");
  await page.getByLabel("ACCESS_KEY_SECRET", { exact: true }).fill("test-only-secret");
  await page.getByLabel("SIGN_NAME（签名名称）", { exact: true }).fill("阿里云测试签名");
  await page.getByLabel("TEMPLATE_CODE（模板 CODE）", { exact: true }).fill("SMS_987654");
  await page.getByRole("button", { name: "保存短信配置", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("配置已保存");
  expect(saves).toEqual([
    {
      accessKeyId: "LTAI-test-access-1234",
      accessKeySecret: "test-only-secret",
      signName: "阿里云测试签名",
      templateCode: "SMS_987654",
    },
  ]);
  await expect(page.getByLabel("ACCESS_KEY_ID", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("ACCESS_KEY_SECRET", { exact: true })).toHaveValue("");
  await page.getByLabel("接收手机号", { exact: true }).fill("13800138000");
  await page.getByRole("button", { name: "发送测试短信", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("阿里云已受理");
  expect(tests).toEqual([{ phone: "13800138000" }]);
  await expect(page.getByRole("button", { name: /秒后可重试/u })).toBeDisabled();
});

test("editing a signature retains saved credentials and requires saving before testing", async ({
  page,
}) => {
  const { saves } = await fixture(page, true);
  await page.goto("/platform/settings/security");
  await page.getByLabel("SIGN_NAME（签名名称）", { exact: true }).fill("新签名");
  await expect(page.getByRole("button", { name: "发送测试短信", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "保存短信配置", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("配置已保存");
  expect(saves).toEqual([{ signName: "新签名", templateCode: "SMS_123456" }]);
  await page.reload();
  await expect(page.getByLabel("SIGN_NAME（签名名称）", { exact: true })).toHaveValue("新签名");
  await expect(page.getByLabel("ACCESS_KEY_SECRET", { exact: true })).toHaveValue("");
});

test("Aliyun rejection is shown without reporting a successful send", async ({ page }) => {
  await fixture(page, true);
  await page.route("**/platform/settings/admin-sms/test", (route) =>
    route.fulfill({
      status: 503,
      json: {
        code: "ADMIN_SMS_UNAVAILABLE",
        providerCode: "isv.SMS_TEMPLATE_ILLEGAL",
        message: "阿里云短信：短信模板不可用，请检查 TEMPLATE_CODE 是否已审核通过",
      },
    }),
  );
  await page.goto("/platform/settings/security");
  await page.getByLabel("接收手机号", { exact: true }).fill("13800138000");
  await page.getByRole("button", { name: "发送测试短信", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "短信模板不可用" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("SMS settings fit narrow screens", async ({ page }) => {
  await fixture(page);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/platform/settings/security");
    await expect(page.getByRole("heading", { name: "管理员短信登录", exact: true })).toBeVisible();
    await expect(page.getByLabel("ACCESS_KEY_ID", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
});
