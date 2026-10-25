import { expect, test } from "@playwright/test";

test("miniapp debug settings save as one request and remain usable on desktop and narrow screens", async ({
  page,
}, testInfo) => {
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
  const values: Record<string, string | boolean> = {
    "miniapp.debug_code_enabled": false,
    "miniapp.debug_code_phones": "",
    "miniapp.debug_code_ips": "",
    "miniapp.debug_code_until": "",
  };
  const labels: Record<string, string> = {
    "miniapp.debug_code_enabled": "启用临时调试验证码",
    "miniapp.debug_code_phones": "测试员工手机号",
    "miniapp.debug_code_ips": "允许来源 IP",
    "miniapp.debug_code_until": "调试通道截止时间",
  };
  await page.route("**/platform/settings", (route) =>
    route.fulfill({
      json: {
        groups: [
          {
            group: "MINIAPP",
            slug: "miniapp",
            label: "小程序设置",
            mark: "微",
            description: "员工小程序调试配置",
            configuredCount: 4,
            totalCount: 4,
            settings: Object.entries(values).map(([key, value]) => ({
              key,
              value,
              label: labels[key],
              group: "MINIAPP",
              description: "平台管理员配置",
              configured: true,
              maskedValue: null,
              max: null,
              min: null,
              maxLength: 199,
              minLength: null,
              nullable: false,
              options: [],
              restartRequired: false,
              secret: false,
              source: "DATABASE",
              step: 1,
              store: "PLATFORM_SETTING",
              unit: null,
              updatedAt: null,
              updatedBy: null,
              valueType: typeof value === "boolean" ? "BOOLEAN" : "STRING",
              version: 1,
            })),
          },
        ],
      },
    }),
  );
  const saves: unknown[] = [];
  await page.route("**/platform/settings/miniapp-debug", (route) => {
    const body = route.request().postDataJSON();
    saves.push(body);
    Object.assign(values, {
      "miniapp.debug_code_enabled": body.enabled,
      "miniapp.debug_code_phones": body.phones,
      "miniapp.debug_code_ips": body.ips,
      "miniapp.debug_code_until": body.until,
    });
    return route.fulfill({ json: { groups: [] } });
  });
  await page.goto("/platform/settings/miniapp");
  await page
    .getByRole("group", { name: "启用临时调试验证码" })
    .getByRole("button", { name: "启用" })
    .click();
  await page.getByRole("textbox", { name: "测试员工手机号" }).fill("13800000099");
  await page.getByRole("textbox", { name: "允许来源 IP" }).fill("*");
  await page.getByRole("textbox", { name: "调试通道截止时间" }).fill("never");
  await page.getByLabel("变更原因").fill("验证小程序调试配置");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const save = page.getByRole("button", { name: "保存更改" });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: testInfo.outputPath(`miniapp-${width}.png`) });
  }
  await page.getByRole("button", { name: "保存更改" }).click();
  await expect(
    page.getByRole("status").getByText("4 项参数已保存到数据库并写入审计记录"),
  ).toBeVisible();
  expect(saves).toEqual([
    {
      enabled: true,
      phones: "13800000099",
      ips: "*",
      until: "never",
      reason: "验证小程序调试配置",
    },
  ]);
  await page
    .getByRole("group", { name: "启用临时调试验证码" })
    .getByRole("button", { name: "禁用" })
    .click();
  await page.getByLabel("变更原因").fill("联调结束关闭通道");
  await page.getByRole("button", { name: "保存更改" }).click();
  await expect(
    page.getByRole("status").getByText("1 项参数已保存到数据库并写入审计记录"),
  ).toBeVisible();
  expect(saves).toHaveLength(2);
  expect(saves[1]).toMatchObject({ enabled: false, phones: "13800000099" });
});
