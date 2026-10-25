import { expect, test } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });
test("enabled Cap is solved before password login", async ({ page }) => {
  let login: Record<string, unknown> | null = null;
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/auth/captcha/password-challenge", (route) =>
    route.fulfill({
      json: {
        required: true,
        token: "fixture-token",
        challenge: { c: 2, s: 16, d: 1 },
        expires: Date.now() + 300000,
      },
    }),
  );
  await page.route("**/auth/admin/password-login", (route) => {
    login = route.request().postDataJSON();
    return route.fulfill({ status: 401, json: { message: "账号或密码不正确" } });
  });
  await page.goto("/login");
  await page.getByLabel("账号", { exact: true }).fill("cap_user");
  await page.getByLabel("密码", { exact: true }).fill("CapTestPassword123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect.poll(() => login).not.toBeNull();
  expect(login).toMatchObject({
    username: "cap_user",
    captcha: { token: "fixture-token", solutions: [expect.any(Number), expect.any(Number)] },
  });
});

test("failed Cap prevents login and permits retry", async ({ page }) => {
  let logins = 0;
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/auth/captcha/password-challenge", (route) =>
    route.fulfill({ status: 503, json: { message: "安全验证服务暂不可用" } }),
  );
  await page.route("**/auth/admin/password-login", (route) => {
    logins++;
    return route.fulfill({ json: {} });
  });
  await page.goto("/login");
  await page.getByLabel("账号", { exact: true }).fill("cap_user");
  await page.getByLabel("密码", { exact: true }).fill("CapTestPassword123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "安全验证服务暂不可用" })).toBeVisible();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeEnabled();
  expect(logins).toBe(0);
});
