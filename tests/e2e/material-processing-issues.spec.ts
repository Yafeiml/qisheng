import { expect, type Page, test } from "@playwright/test";

function administrator(permissions = ["platform.monitor.read", "platform.monitor.manage"]) {
  return {
    userId: "issue-admin",
    phone: "13800000000",
    features: {},
    scopes: [
      {
        scopeType: "PLATFORM",
        role: { code: "PLATFORM_ADMIN", name: "平台管理员" },
        permissions,
      },
    ],
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("xhs-agentic:mvp-session:v1", JSON.stringify({ mode: "FORMAL" })),
  );
  await page.route(/:3100\//u, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked processing issue fixture" } }),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "issue-fixture-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/session", (route) => route.fulfill({ json: administrator() }));
});

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-failed",
    source: "MATERIAL",
    resourceId: "material-failed",
    resourceTitle: "全飞秒专家资料",
    occurredAt: "2026-10-06T01:01:00.000Z",
    tenant: { id: "tenant", name: "眼科集团" },
    enterprise: { id: "enterprise", name: "上海眼科门诊" },
    actor: { id: "user", name: "张医生", phoneMasked: "138****1234" },
    status: "NEEDS_ADMIN",
    errorCode: "MATERIAL_ANALYSIS_AUTH_FAILED",
    stage: "ANALYSIS",
    reason: "资料理解服务认证失败：模型供应商拒绝了认证。",
    suggestedActions: [
      "检查模型供应商 API 密钥是否有效。",
      "确认所选模型的调用权限，修复配置后重新处理。",
    ],
    attemptCount: 5,
    maxAttempts: 5,
    canRetry: true,
    settingsPath: "/platform/models",
    ...overrides,
  };
}

async function mockIssues(page: Page, rows: Record<string, unknown>[]) {
  await page.route(/:3100\/platform\/processing-issues(?:\?.*)?$/u, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const status = query.get("status");
    const search = query.get("search") ?? query.get("q") ?? "";
    return route.fulfill({
      json: {
        items: rows.filter(
          (row) =>
            (!status || status === "ALL" || row.status === status) &&
            (!search || JSON.stringify(row).includes(search)),
        ),
        pageInfo: { hasNextPage: false, nextCursor: null },
      },
    });
  });
}

test("administrators see the affected user and enterprise, cause and repair advice at both widths", async ({
  page,
}, testInfo) => {
  await mockIssues(page, [issue()]);
  await page.goto("/platform/processing-issues");
  await expect(page.getByRole("heading", { name: "处理异常", exact: true })).toBeVisible();
  const card = page.getByTestId("processing-issue");
  await expect(card).toContainText("全飞秒专家资料");
  await expect(card).toContainText("上海眼科门诊");
  await expect(card).toContainText("张医生");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await card.getByRole("button", { name: "查看处理建议", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "异常处理详情" });
    await expect(drawer).toContainText("138****1234");
    await expect(drawer).toContainText("眼科集团");
    await expect(drawer).toContainText("上海眼科门诊");
    await expect(drawer).toContainText("资料理解服务认证失败");
    await expect(drawer).toContainText("检查模型供应商 API 密钥是否有效。");
    await expect(drawer).toContainText("MATERIAL_ANALYSIS_AUTH_FAILED");
    const retry = drawer.getByRole("button", { name: "修复后重新处理", exact: true });
    await expect(retry).toBeEnabled();
    await retry.focus();
    await expect(retry).toBeFocused();
    const dimensions = await retry.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, right: rect.right };
    });
    expect(dimensions.width).toBeGreaterThan(90);
    expect(dimensions.width).toBeLessThan(width - 30);
    expect(dimensions.height).toBeGreaterThanOrEqual(30);
    expect(dimensions.height).toBeLessThan(65);
    expect(dimensions.right).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`processing-issue-${width}.png`),
      fullPage: true,
    });
    await drawer.getByRole("button", { name: "关闭异常处理详情", exact: true }).click();
    await expect(drawer).toHaveCount(0);
  }
});

test("status and search filters distinguish administrator, user and automatic recovery tasks", async ({
  page,
}) => {
  await mockIssues(page, [
    issue(),
    issue({
      id: "job-file",
      resourceId: "material-file",
      resourceTitle: "待修正扫描件",
      status: "NEEDS_USER",
      errorCode: "EMPTY_EXTRACTED_TEXT",
      reason: "未读取到可用文字。",
      suggestedActions: ["请用户识别扫描件文字，或直接粘贴正文后重新提交。"],
      canRetry: false,
      settingsPath: null,
      actor: null,
      enterprise: null,
    }),
    issue({
      id: "job-retrying",
      resourceId: "material-retrying",
      resourceTitle: "自动恢复中的照片",
      status: "AUTO_RETRYING",
      attemptCount: 1,
      canRetry: false,
    }),
  ]);
  await page.goto("/platform/processing-issues");
  const status = page.getByLabel("异常状态", { exact: true });
  await status.selectOption("NEEDS_USER");
  await expect(page.getByTestId("processing-issue")).toHaveCount(1);
  await expect(page.getByTestId("processing-issue")).toContainText("待修正扫描件");
  await page.getByRole("button", { name: "查看处理建议", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "异常处理详情" });
  await expect(drawer).toContainText("请用户识别扫描件文字");
  await expect(drawer.getByRole("button", { name: "修复后重新处理", exact: true })).toHaveCount(0);
  await drawer.getByRole("button", { name: "关闭异常处理详情", exact: true }).click();
  await status.selectOption("AUTO_RETRYING");
  await expect(page.getByTestId("processing-issue")).toHaveCount(1);
  await expect(page.getByTestId("processing-issue")).toContainText("自动恢复中的照片");
  await status.selectOption("ALL");
  await page.getByLabel("搜索用户、企业或资料", { exact: true }).fill("张医生");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByTestId("processing-issue")).toHaveCount(2);
  await page.getByLabel("搜索用户、企业或资料", { exact: true }).fill("全飞秒专家资料");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByTestId("processing-issue")).toHaveCount(1);
  await expect(page.getByTestId("processing-issue")).toContainText("全飞秒专家资料");
});

for (const width of [1440, 390]) {
  test(`administrator recovery disables repeated requests and refreshes the recorded status at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    let rows = [issue()];
    await page.route(/:3100\/platform\/processing-issues(?:\?.*)?$/u, (route) =>
      route.fulfill({ json: { items: rows, pageInfo: { hasNextPage: false, nextCursor: null } } }),
    );
    let finishRetry: (() => void) | undefined;
    let requests = 0;
    await page.route(
      "**/platform/processing-issues/materials/material-failed/retry",
      async (route) => {
        expect(route.request().method()).toBe("POST");
        expect(route.request().postDataJSON()).toEqual({
          ingestionJobId: "job-failed",
          reason: "已更新供应商密钥并验证模型可用。",
        });
        requests++;
        await new Promise<void>((resolve) => {
          finishRetry = resolve;
        });
        rows = [issue({ status: "AUTO_RETRYING", attemptCount: 0, canRetry: false })];
        await route.fulfill({ json: { materialId: "material-failed", job: { id: "job-retry" } } });
      },
    );
    await page.goto("/platform/processing-issues");
    await page.getByLabel("异常状态", { exact: true }).selectOption("ALL");
    await page.getByRole("button", { name: "查看处理建议", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "异常处理详情" });
    const retry = drawer.getByRole("button", { name: "修复后重新处理", exact: true });
    await retry.click();
    const confirmation = page.getByRole("dialog", { name: "重新处理这条资料？", exact: true });
    await confirmation
      .getByRole("textbox", { name: /^处理说明/u })
      .fill("已更新供应商密钥并验证模型可用。");
    await page.screenshot({
      path: testInfo.outputPath(`processing-issue-confirmation-${width}.png`),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await confirmation.getByRole("button", { name: "确认重新处理", exact: true }).click();
    await expect.poll(() => requests).toBe(1);
    await expect(
      confirmation.getByRole("button", { name: "正在处理…", exact: true }),
    ).toBeDisabled();
    await expect(retry).toBeDisabled();
    await expect(page.getByLabel("异常状态", { exact: true })).toBeDisabled();
    finishRetry?.();
    await expect(confirmation).toHaveCount(0);
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId("processing-issue")).toContainText("正在重新处理");
    expect(requests).toBe(1);
  });
}

test("a monitor with read permission can inspect issues without a recovery action", async ({
  page,
}) => {
  await page.route("**/auth/admin/session", (route) =>
    route.fulfill({ json: administrator(["platform.monitor.read"]) }),
  );
  await mockIssues(page, [issue()]);
  await page.goto("/platform/processing-issues");
  await page.getByRole("button", { name: "查看处理建议", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "异常处理详情" });
  await expect(drawer).toContainText("检查模型供应商 API 密钥是否有效。");
  await expect(drawer.getByRole("button", { name: "修复后重新处理", exact: true })).toHaveCount(0);
});

test("automatic refresh closes obsolete advice and recovery controls after an external resolution", async ({
  page,
}) => {
  await page.clock.install();
  let externallyResolved = false;
  let requests = 0;
  await page.route(/:3100\/platform\/processing-issues(?:\?.*)?$/u, (route) => {
    requests++;
    return route.fulfill({
      json: {
        items: externallyResolved ? [] : [issue()],
        pageInfo: { hasNextPage: false, nextCursor: null },
      },
    });
  });
  await page.goto("/platform/processing-issues");
  await page.getByRole("button", { name: "查看处理建议", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "异常处理详情" });
  await expect(drawer.getByRole("button", { name: "修复后重新处理", exact: true })).toBeVisible();
  externallyResolved = true;
  await page.clock.fastForward(31_000);
  await expect.poll(() => requests).toBeGreaterThanOrEqual(2);
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "修复后重新处理", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("processing-issue")).toHaveCount(0);
  await expect(page.getByText("当前没有符合条件的异常", { exact: true })).toBeVisible();
});

test("notification settings link to processing issues with a usable action at both widths", async ({
  page,
}, testInfo) => {
  await page.route("**/auth/admin/session", (route) =>
    route.fulfill({
      json: administrator(["platform.settings.manage", "platform.monitor.read"]),
    }),
  );
  await page.route("**/platform/settings", (route) =>
    route.fulfill({
      json: {
        groups: [
          {
            group: "NOTIFICATION",
            slug: "notification",
            label: "通知设置",
            mark: "通",
            description: "注册申请通知与处理异常跟进",
            configuredCount: 0,
            totalCount: 0,
            settings: [],
          },
        ],
      },
    }),
  );
  await mockIssues(page, [issue()]);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/platform/settings/notification");
    const entry = page.locator(".processingIssuesEntry");
    await expect(entry).toContainText("用户、企业、失败原因及处理建议");
    const action = entry.getByRole("link", { name: "查看处理异常", exact: true });
    await expect(action).toHaveAttribute("href", "/platform/processing-issues");
    await action.focus();
    await expect(action).toBeFocused();
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width).toBeGreaterThan(90);
    expect(box?.height).toBeGreaterThanOrEqual(32);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`processing-issue-entry-${width}.png`),
      fullPage: true,
    });
    await action.click();
    await expect(page).toHaveURL(/\/platform\/processing-issues$/u);
    await expect(page.getByRole("heading", { name: "处理异常", exact: true })).toBeVisible();
  }
});
