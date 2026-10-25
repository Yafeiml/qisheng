import { expect, test } from "@playwright/test";

test.describe("anonymous visitor", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("landing link opens login and stays within the narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const login = page.getByRole("link", { name: "已有账号？登录后台" });
    await expect(login).toHaveAttribute("href", "/login");
    expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
    await login.click();
    await expect(page).toHaveURL(/\/login$/u);
  });

  test("expired stored sessions never offer a shortcut into the console", async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem("xhs-agentic:mvp-session:v1", JSON.stringify({ mode: "FORMAL" })),
    );
    await page.route("**/auth/admin/refresh", (route) =>
      route.fulfill({ status: 401, json: { message: "Session expired" } }),
    );
    await page.goto("/");
    await expect(page.getByRole("link", { name: "已有账号？登录后台" })).toHaveAttribute(
      "href",
      "/login",
    );
    await expect(page.getByRole("link", { name: "进入控制台" })).toHaveCount(0);
  });
});

test("platform session enters the platform and its logo stays in the platform", async ({
  page,
}) => {
  await page.goto("/");
  const entry = page.getByRole("link", { name: "进入控制台" });
  await expect(entry).toHaveAttribute("href", "/platform");
  await entry.click();
  await expect(page).toHaveURL(/\/platform$/u);
  await page.goto("/platform/account");
  await page.locator(".appBrand").click();
  await expect(page).toHaveURL(/\/platform$/u);
  await page.goto("/console/account");
  await page.locator(".appBrand").click();
  await expect(page).toHaveURL(/\/console$/u);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "进入控制台" })).toHaveAttribute("href", "/platform");
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
});

test.describe("enterprise administrator", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("landing link targets the enterprise console after a valid session refresh", async ({
    page,
  }) => {
    const profile = {
      userId: "enterprise-admin",
      phone: "13800000001",
      features: {},
      scopes: [
        {
          scopeType: "ENTERPRISE",
          role: { code: "ENTERPRISE_ADMIN", name: "企业管理员" },
          tenant: { id: "tenant", name: "测试集团" },
          enterprise: { id: "enterprise", name: "测试企业", tenantId: "tenant" },
          permissions: ["campaign.read"],
        },
      ],
    };
    await page.addInitScript((access) => {
      localStorage.setItem(
        "xhs-agentic:mvp-session:v1",
        JSON.stringify({
          accessTokenExpiresAt: null,
          adminAccess: access,
          adminPhone: access.phone,
          adminToken: "mock-token",
          employeePhone: "",
          employeeToken: "",
          enterpriseId: "enterprise",
          enterpriseName: "测试企业",
          mode: "FORMAL",
          platformAccess: access,
          platformToken: "mock-token",
          tenantId: "tenant",
          tenantName: "测试集团",
        }),
      );
    }, profile);
    await page.route("**/auth/admin/refresh", (route) =>
      route.fulfill({ json: { accessToken: "mock-token", expiresInSeconds: 3600 } }),
    );
    await page.route("**/auth/admin/session", (route) => route.fulfill({ json: profile }));
    await page.goto("/");
    const entry = page.getByRole("link", { name: "进入控制台" });
    await expect(entry).toHaveAttribute("href", "/console");
    await entry.click();
    await expect(page).toHaveURL(/\/console$/u);
    await expect(page.locator(".appBrand")).toHaveAttribute("href", "/console");
  });
});
