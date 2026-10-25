import { expect, type Page, test } from "@playwright/test";

async function mockAdmin(page: Page, scopeType: "TENANT" | "ENTERPRISE" | "PLATFORM") {
  const scope = {
    scopeId: "scope",
    scopeType,
    tenant:
      scopeType === "PLATFORM" ? null : { id: "tenant", name: "测试集团", customerType: "GROUP" },
    enterprise: scopeType === "ENTERPRISE" ? { id: "enterprise", name: "测试企业" } : null,
    inheritedEnterprises: scopeType === "TENANT" ? [{ id: "enterprise", name: "测试企业" }] : [],
    permissions: ["tenant.employee.manage"],
    role: { code: `${scopeType}_ADMIN`, name: "测试管理员" },
  };
  let account = {
    id: "admin",
    name: null as string | null,
    email: null as string | null,
    emailVerifiedAt: null as string | null,
    phone: "13800000001",
    status: "ACTIVE",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    lastLoginAt: null,
    activeSessionCount: 1,
    loginMethod: "SMS_CODE",
    scopes: [{ ...scope, roles: [scope.role], department: null, jobTitle: null }],
  };
  let sent = 0;
  let retryUntil = 0;
  await page.addInitScript(() =>
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({
        mode: "FORMAL",
        tenantId: "tenant",
        enterpriseId: "enterprise",
        adminToken: "old-token",
      }),
    ),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "test-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/session", (route) =>
    route.fulfill({
      json: {
        userId: "admin",
        name: account.name,
        phone: account.phone,
        features: {},
        scopes: [scope],
      },
    }),
  );
  await page.route("**/auth/admin/account", (route) => {
    if (route.request().method() === "PATCH") {
      const input = route.request().postDataJSON();
      if (input.email === "used@example.test") {
        return route.fulfill({
          status: 409,
          json: {
            code: "ADMIN_EMAIL_ALREADY_EXISTS",
            message: "该邮箱已被其他后台用户使用",
          },
        });
      }
      account = {
        ...account,
        ...input,
        emailVerifiedAt: input.email === account.email ? account.emailVerifiedAt : null,
      };
    }
    return route.fulfill({ json: account });
  });
  await page.route("**/auth/admin/account/email/challenge", (route) =>
    route.fulfill({
      json: {
        required: true,
        token: "email-proof",
        challenge: { c: 1, s: 16, d: 1 },
        expires: Date.now() + 300000,
      },
    }),
  );
  await page.route("**/auth/admin/account/email/status", (route) =>
    route.fulfill({
      json: { retryAfterSeconds: Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000)) },
    }),
  );
  await page.route("**/auth/admin/account/email/send", (route) => {
    expect(route.request().postDataJSON().captcha).toMatchObject({
      token: "email-proof",
      solutions: [expect.any(Number)],
    });
    if (account.email === "send-failure@example.test") {
      retryUntil = Date.now() + 60000;
      return route.fulfill({
        status: 503,
        json: { message: "邮件服务暂时不可用，请稍后重试", details: { retryAfterSeconds: 60 } },
      });
    }
    sent++;
    retryUntil = Date.now() + 60000;
    return route.fulfill({ json: { sent: true, retryAfterSeconds: 60, expiresInSeconds: 1800 } });
  });
  await page.route("**/auth/admin/email/confirm", (route) => {
    account = { ...account, emailVerifiedAt: "2026-10-09T00:00:00Z" };
    return route.fulfill({ json: { verified: true } });
  });
  return {
    sends: () => sent,
    expireCooldown: () => {
      retryUntil = 0;
    },
  };
}

for (const width of [1440, 390]) {
  test(`email is optional and no completion dialog blocks the workspace at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockAdmin(page, "TENANT");
    await page.goto("/console/account");
    await expect(page.getByRole("dialog", { name: "请完善个人资料" })).toHaveCount(0);
    await page.getByLabel("姓名（必填）").fill("李管理员");
    await expect(page.getByLabel("邮箱（选填）")).not.toHaveAttribute("required");
    await page.getByRole("button", { name: "保存个人资料", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存个人资料", exact: true })).toBeEnabled();
    expect(fixture.sends()).toBe(0);
  });
}

for (const width of [1440, 390]) {
  test(`email feedback expires without moving the form or clearing the invalid field at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    await mockAdmin(page, "TENANT");
    await page.goto("/console/account");
    const form = page.locator(".accountProfileForm");
    const email = page.getByLabel("邮箱（选填）");
    const save = page.getByRole("button", { name: "保存个人资料", exact: true });
    const send = page.locator(".accountEmailInputRow button");
    const toast = page.locator(".feedbackToast");
    await page.getByLabel("姓名（必填）").fill("李管理员");
    await email.fill("used@example.test");
    await expect(send).toHaveText("请先保存资料");
    await expect(send).toBeDisabled();
    await save.scrollIntoViewIfNeeded();
    await page.evaluate(() =>
      document.documentElement.style.setProperty("scroll-behavior", "auto"),
    );
    const geometry = () =>
      form.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top + window.scrollY, height: rect.height };
      });
    const before = await geometry();
    await save.click();
    await expect(toast).toHaveText("保存失败：该邮箱已被其他后台用户使用");
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(email).toBeFocused();
    await expect(page.locator("#account-email-error")).toBeHidden();
    await expect(email).toHaveAttribute("aria-describedby", "account-email-error");
    expect(await geometry()).toEqual(before);
    const toastBox = await toast.boundingBox();
    expect(toastBox?.y).toBeGreaterThanOrEqual(0);
    expect((toastBox?.y ?? 0) + (toastBox?.height ?? 0)).toBeLessThan(900);
    expect(toastBox?.x).toBeGreaterThanOrEqual(0);
    expect((toastBox?.x ?? 0) + (toastBox?.width ?? 0)).toBeLessThanOrEqual(width);
    expect(width - (toastBox?.x ?? 0) - (toastBox?.width ?? 0)).toBeLessThanOrEqual(48);
    const bottomGap = 900 - (toastBox?.y ?? 0) - (toastBox?.height ?? 0);
    expect(bottomGap).toBeGreaterThanOrEqual(12);
    expect(bottomGap).toBeLessThanOrEqual(80);
    await page.screenshot({ path: testInfo.outputPath("email-save-error-toast.png") });
    await page.clock.fastForward(3100);
    await expect(toast).toHaveCount(0);
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(email).toHaveAttribute("aria-describedby", "account-email-error");
    await expect(page.locator("#account-email-error")).toContainText("该邮箱已被其他后台用户使用");
    expect(await geometry()).toEqual(before);
    await page.getByLabel("姓名（必填）").fill("李管理员（修改）");
    await page.clock.fastForward(100);
    await expect(toast).toHaveCount(0);
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await save.click();
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText("该邮箱已被其他后台用户使用");
    await toast.getByRole("button", { name: "关闭提示" }).click();
    await expect(toast).toHaveCount(0);
    await email.fill("send-failure@example.test");
    await expect(email).not.toHaveAttribute("aria-invalid", "true");
    await save.click();
    await expect(toast).toContainText("个人资料已更新");
    await expect(send).toHaveText("发送验证邮件");
    await expect(send).toBeEnabled();
    expect(await geometry()).toEqual(before);
    await page.clock.fastForward(3100);
    await expect(toast).toHaveCount(0);
    await send.click();
    await expect(toast).toContainText("发送失败：邮件服务暂时不可用");
    await expect(send).toBeDisabled();
    await expect(send).toContainText("秒后可重新发送");
    expect(await geometry()).toEqual(before);
    await page.screenshot({ path: testInfo.outputPath("email-send-error-toast.png") });
    await page.clock.fastForward(3100);
    await expect(toast).toHaveCount(0);
    await expect(send).toBeDisabled();
    await expect(send).toContainText("秒后可重新发送");
    await page.reload();
    await expect(page.locator(".accountEmailInputRow button")).toBeDisabled();
    await expect(page.locator(".accountEmailInputRow button")).toContainText("秒后可重新发送");
  });
}

test("system administrators can edit optional profile without a blocking prompt", async ({
  page,
}) => {
  await mockAdmin(page, "PLATFORM");
  await page.goto("/platform/account");
  await expect(page.getByRole("heading", { name: "个人资料" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "请完善个人资料" })).not.toBeVisible();
});

test("email confirmation requires an explicit click and works without login, with expired links explained", async ({
  page,
}) => {
  let confirmations = 0;
  await page.route("**/auth/admin/email/confirm", (route) => {
    confirmations++;
    expect(route.request().postDataJSON()).toEqual({ token: "b".repeat(64) });
    return route.fulfill({
      status: 400,
      json: { message: "验证链接已失效或已使用，请在个人中心重新发送验证邮件" },
    });
  });
  await page.goto(`/verify-email#token=${"b".repeat(64)}`);
  const confirm = page.getByRole("button", { name: "确认验证邮箱" });
  await expect(confirm).toBeVisible();
  expect(confirmations).toBe(0);
  await confirm.click();
  await expect(page.locator('.feedbackToast[data-tone="error"]')).toContainText(
    "验证链接已失效或已使用",
  );
  await expect(page.getByRole("link", { name: "前往登录" })).toBeVisible();
  expect(confirmations).toBe(1);
});

test("server cooldown survives refresh and expires using elapsed time", async ({ page }) => {
  await page.clock.install();
  const fixture = await mockAdmin(page, "TENANT");
  await page.goto("/console/account");
  await page.getByLabel("姓名（必填）").fill("李管理员");
  await page.getByLabel("邮箱（选填）").fill("owner@example.test");
  await page.getByRole("button", { name: "保存个人资料", exact: true }).click();
  const send = page.locator(".accountEmailInputRow button");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(send).toBeDisabled();
  await page.reload();
  await expect(send).toContainText("秒后可重新发送");
  await expect(send).toBeDisabled();
  expect(fixture.sends()).toBe(1);
  fixture.expireCooldown();
  await page.clock.fastForward(61000);
  await expect(send).toHaveText("发送验证邮件");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(send).toBeDisabled();
  expect(fixture.sends()).toBe(2);
});

test("unavailable cooldown keeps its retry action after the toast expires and preserves profile editing", async ({
  page,
}) => {
  await page.clock.install();
  const fixture = await mockAdmin(page, "TENANT");
  let unavailable = true;
  let holdRetry = false;
  let releaseRetry = () => {};
  const retryResponse = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  let challenges = 0;
  let sends = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/auth/admin/account/email/challenge") challenges++;
    if (path === "/auth/admin/account/email/send") sends++;
  });
  await page.route("**/auth/admin/account/email/status", async (route) => {
    if (holdRetry) await retryResponse;
    return route.fulfill(
      unavailable
        ? { status: 503, json: { message: "邮件限流服务暂时不可用，请稍后重试" } }
        : { json: { retryAfterSeconds: 0 } },
    );
  });
  await page.goto("/console/account");
  await expect(page.getByLabel("邮箱（选填）")).toBeEditable();
  await expect(page.locator('.feedbackToast[data-tone="error"]')).toContainText(
    "邮件限流服务暂时不可用",
  );
  const send = page.locator(".accountEmailInputRow button");
  await expect(send).toBeEnabled();
  await expect(send).toHaveText("重新读取发送间隔");
  await page.clock.fastForward(3100);
  await expect(page.locator('.feedbackToast[data-tone="error"]')).toHaveCount(0);
  await expect(send).toBeEnabled();
  await expect(send).toHaveText("重新读取发送间隔");
  await page.getByLabel("姓名（必填）").fill("李管理员");
  await page.getByLabel("邮箱（选填）").fill("owner@example.test");
  await page.getByRole("button", { name: "保存个人资料", exact: true }).click();
  await expect(page.locator('.feedbackToast[data-tone="success"]')).toContainText("个人资料已更新");
  await expect(send).toBeEnabled();
  await expect(send).toHaveText("重新读取发送间隔");
  expect({ challenges, sends }).toEqual({ challenges: 0, sends: 0 });
  unavailable = false;
  holdRetry = true;
  const retryStarted = page.waitForRequest("**/auth/admin/account/email/status");
  await send.click();
  await retryStarted;
  await expect(send).toBeDisabled();
  await expect(send).toHaveText("正在读取发送间隔…");
  expect({ challenges, sends }).toEqual({ challenges: 0, sends: 0 });
  releaseRetry();
  await expect(send).toBeEnabled();
  await expect(send).toHaveText("发送验证邮件");
  expect({ challenges, sends }).toEqual({ challenges: 0, sends: 0 });
  await send.click();
  await expect(send).toBeDisabled();
  await expect(send).toContainText("秒后可重新发送");
  expect({ challenges, sends }).toEqual({ challenges: 1, sends: 1 });
  expect(fixture.sends()).toBe(1);
});

test("an older status response cannot clear a newly issued send cooldown", async ({ page }) => {
  await mockAdmin(page, "TENANT");
  let releaseSend: () => void = () => {};
  let releaseStatus: () => void = () => {};
  const sendFinished = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const statusFinished = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  let holdStatus = false;
  await page.route("**/auth/admin/account/email/status", async (route) => {
    if (holdStatus) await statusFinished;
    await route.fulfill({ json: { retryAfterSeconds: 0 } });
  });
  await page.route("**/auth/admin/account/email/send", async (route) => {
    await sendFinished;
    await route.fulfill({ json: { retryAfterSeconds: 60 } });
  });
  await page.goto("/console/account");
  await page.getByLabel("姓名（必填）").fill("李管理员");
  await page.getByLabel("邮箱（选填）").fill("owner@example.test");
  await page.getByRole("button", { name: "保存个人资料", exact: true }).click();
  const send = page.locator(".accountEmailInputRow button");
  await expect(send).toBeEnabled();
  const sendRequest = page.waitForRequest("**/auth/admin/account/email/send");
  await send.click();
  await sendRequest;
  holdStatus = true;
  const statusRequest = page.waitForRequest("**/auth/admin/account/email/status");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await statusRequest;
  releaseSend();
  await expect(send).toContainText("秒后可重新发送");
  const statusResponse = page.waitForResponse("**/auth/admin/account/email/status");
  releaseStatus();
  await statusResponse;
  await expect(send).toBeDisabled();
  await expect(send).toContainText("秒后可重新发送");
});
