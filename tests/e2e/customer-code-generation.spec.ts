import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
    ),
  );
  await page.route(/:3100\//u, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked API" } }),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "mock-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/account", (route) =>
    route.fulfill({
      json: {
        name: "客户开通验收管理员",
        email: "customer@example.test",
        emailVerifiedAt: "2026-10-09T00:00:00Z",
      },
    }),
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
            permissions: ["platform.settings.manage", "platform.customer.manage"],
          },
          {
            scopeType: "TENANT",
            role: { code: "TENANT_ADMIN", name: "集团管理员" },
            tenant: { id: "tenant", name: "示例集团" },
            inheritedEnterprises: [{ id: "enterprise", name: "示例企业" }],
            permissions: ["tenant.enterprise.read", "tenant.enterprise.manage"],
          },
        ],
      },
    }),
  );
  await page.route("**/platform/industries", (route) =>
    route.fulfill({ json: [{ id: "health", name: "医疗健康", sortOrder: 1 }] }),
  );
  await page.route("**/console/tenants/tenant/industries", (route) =>
    route.fulfill({ json: [{ id: "health", name: "医疗健康", sortOrder: 1 }] }),
  );
});

test("group enterprise creation omits code and keeps the create action usable", async ({
  page,
}, testInfo) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/console/tenants/tenant/enterprises", (route) => {
    if (route.request().method() === "POST") {
      submitted = route.request().postDataJSON();
      return route.fulfill({
        json: { id: "enterprise-new", tenantId: "tenant", name: "新增院区", code: "ENT_GENERATED" },
      });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/console/enterprises");
  await page.getByRole("button", { name: "创建企业", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "创建集团企业" });
  await expect(drawer.getByLabel("企业代码")).toHaveCount(0);
  await expect(drawer.getByText("企业代码由系统自动生成")).toBeVisible();
  await drawer.getByLabel("企业名称").fill("新增院区");
  await drawer.getByLabel("行业").selectOption("医疗健康");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 850 });
    const submit = drawer.getByRole("button", { name: "创建企业", exact: true });
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: testInfo.outputPath(`enterprise-${width}.png`) });
  }
  await drawer.getByRole("button", { name: "创建企业", exact: true }).click();
  expect(submitted).not.toHaveProperty("code");
  expect(submitted).toMatchObject({ name: "新增院区", industry: "医疗健康" });
});
