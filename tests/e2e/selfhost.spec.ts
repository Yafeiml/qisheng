import { expect, type Locator, type Page, test } from "@playwright/test";

const profile = {
  userId: "admin",
  username: "test_admin",
  phone: null,
  name: "测试管理员",
  features: {},
  scopes: [
    {
      scopeType: "PLATFORM",
      scopeId: "platform",
      role: { name: "系统管理员", code: "PLATFORM_ADMIN" },
      permissions: ["platform.monitor.read", "platform.settings.manage", "platform.tenant.read"],
    },
    {
      scopeType: "ENTERPRISE",
      scopeId: "enterprise",
      role: { name: "企业管理员", code: "ENTERPRISE_ADMIN" },
      tenant: { id: "tenant", name: "测试团队" },
      enterprise: { id: "enterprise", name: "测试品牌", tenantId: "tenant" },
      permissions: [
        "campaign.read",
        "campaign.manage",
        "material.read",
        "enterprise.membership.manage",
      ],
    },
  ],
};

const task = {
  id: "task",
  status: "AVAILABLE",
  campaign: { id: "campaign", title: "品牌日常分享" },
  enterprise: { id: "enterprise", name: "测试品牌" },
  contentVisible: true,
  contentRevision: 1,
  factsConfirmationRequired: true,
  factsConfirmed: false,
  factsReturned: false,
  visibleAt: "2026-01-01T00:00:00Z",
  expiresAt: "2030-01-01T00:00:00Z",
  content: {
    title: "今天记录一件小事",
    body: "这是我参与团队活动的真实记录。",
    hashtags: ["团队日常"],
    images: [],
  },
};

async function fixture(page: Page, loggedIn = false) {
  if (loggedIn)
    await page.addInitScript(() =>
      localStorage.setItem(
        "xhs-agentic:mvp-session:v1",
        JSON.stringify({
          mode: "FORMAL",
          tenantId: "tenant",
          enterpriseId: "enterprise",
          adminToken: "old-token",
          platformToken: "old-token",
        }),
      ),
    );
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/u, "");
    if (["POST", "PATCH"].includes(request.method()))
      writes.push({ path, body: request.postDataJSON() ?? {} });
    let json: unknown = {};
    if (
      ["/auth/admin/password-login", "/auth/admin/register", "/auth/admin/refresh"].includes(path)
    )
      json = { accessToken: "fixture-token", expiresInSeconds: 3600 };
    else if (path === "/auth/admin/session") json = profile;
    else if (path === "/auth/admin/account")
      json = {
        userId: "admin",
        username: "test_admin",
        name: "测试管理员",
        phone: null,
        email: null,
        emailVerifiedAt: null,
        status: "ACTIVE",
        scopes: [],
      };
    else if (path === "/auth/admin/account/email/status") json = { retryAfterSeconds: 0 };
    else if (path === "/auth/captcha/password-challenge") json = { required: false };
    else if (path === "/platform/access/admins") json = request.method() === "GET" ? [] : {};
    else if (path === "/auth/employee/web-bind" || path === "/auth/employee/web-session")
      json = { accessToken: "employee-token", expiresInSeconds: 3600 };
    else if (path === "/employee/tasks") json = [task];
    else if (path === "/employee/tasks/task/view") json = task;
    else if (path === "/employee/tasks/task/facts") json = { ...task, factsConfirmed: true };
    else if (path === "/employee/tasks/task/submissions") json = { status: "PENDING" };
    else if (path.endsWith("/generation-status"))
      json = { affectedEnterpriseCount: 0, notices: [] };
    else if (path === "/platform/settings") {
      const setting = (key: string, label: string, valueType: string, value: unknown) => ({
        key,
        label,
        valueType,
        value,
        configured: key.includes("secret"),
        secret: key.includes("secret"),
        maskedValue: key.includes("secret") ? "已配置（不回显）" : null,
        source: "DEFAULT",
        nullable: true,
        options: [],
        step: 1,
        group: "security",
        description: "",
        store: "PLATFORM_SETTING",
      });
      json = {
        groups: [
          {
            slug: "security",
            group: "security",
            label: "安全设置",
            description: "登录安全",
            configuredCount: 1,
            totalCount: 3,
            settings: [
              setting("security.cap_enabled", "启用 Cap 验证", "BOOLEAN", false),
              setting("security.cap_endpoint", "Cap 验证服务 Endpoint", "URL", ""),
              setting("security.cap_secret", "Cap 验证服务 Secret Key", "SECRET", null),
            ],
          },
        ],
      };
    }
    await route.fulfill({ json });
  });
  return writes;
}

async function separatedControls(controls: Locator, minimumGap = 8) {
  const rectangles = await controls.evaluateAll((elements) =>
    elements.map((element) => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { left, right, top, bottom };
    }),
  );
  for (let index = 1; index < rectangles.length; index++) {
    const previous = rectangles[index - 1];
    const current = rectangles[index];
    if (!previous || !current) throw new Error("Expected adjacent controls");
    expect(
      Math.max(
        current.left - previous.right,
        previous.left - current.right,
        current.top - previous.bottom,
        previous.top - current.bottom,
      ),
    ).toBeGreaterThanOrEqual(minimumGap - 0.5);
  }
}

async function expectEmployeePanelSpacing(page: Page, width: number, notice?: Locator) {
  const rail = page.getByRole("heading", { name: "任务列表", exact: true }).locator("..");
  const detail = rail.locator("..").locator(":scope > section.panel");
  await expect(rail).toBeVisible();
  await expect(detail).toBeVisible();
  const [left, right] = await Promise.all([rail.boundingBox(), detail.boundingBox()]);
  if (!left || !right) throw new Error("Employee task panels did not render");
  if (width > 700) {
    expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(right.x - left.x - left.width - 24)).toBeLessThanOrEqual(1);
  } else {
    expect(Math.abs(right.y - left.y - left.height - 16)).toBeLessThanOrEqual(1);
  }
  if (notice) {
    const above = await notice.boundingBox();
    if (!above) throw new Error("Employee team notice did not render");
    expect(Math.min(left.y, right.y) - above.y - above.height).toBeGreaterThanOrEqual(
      (width > 700 ? 24 : 16) - 0.5,
    );
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
}

for (const width of [1440, 390]) {
  test(`enterprise overview shows three operational metrics at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await fixture(page, true);
    await page.route("**/enterprises/enterprise/workspace", (route) =>
      route.fulfill({
        json: {
          enterprise: { id: "enterprise", name: "测试品牌" },
          campaignReady: true,
          steps: [],
          counts: { enabledSeats: 2, memberProfiles: 2 },
          generation: { succeeded: 1, failed: 0, successRate: 1 },
          campaigns: {
            total: 0,
            generating: 0,
            generationFailed: 0,
            reviewPending: 0,
            approved: 0,
          },
          nextAction: {
            href: "/console/campaigns/new",
            title: "创建活动",
            description: "员工和授权素材已准备好。",
          },
        },
      }),
    );
    await page.route("**/enterprises/enterprise/campaigns", (route) =>
      route.fulfill({ json: { items: [], pageInfo: { hasNextPage: false, nextCursor: null } } }),
    );
    await page.goto("/console");
    const metrics = page.locator(".metricGrid");
    await expect(metrics.locator(".metricCard")).toHaveCount(3);
    await expect(metrics).toContainText("任务参与员工2");
    await expect(metrics).toContainText("员工内容生成成功率100%");
    await expect(metrics).toContainText("需要跟进的活动0");
    await expect(page.locator(".appSidebar")).not.toContainText(/点数|钱包/u);
    await expect(page.locator(".appWorkspace")).not.toContainText(/点数|钱包|余额/u);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    const cards = await metrics.locator(".metricCard").evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width } = element.getBoundingClientRect();
        return { x, y, width };
      }),
    );
    if (width === 1440) {
      expect(new Set(cards.map(({ y }) => y)).size).toBe(1);
      expect(new Set(cards.map(({ width }) => Math.round(width))).size).toBeLessThanOrEqual(2);
    } else expect(new Set(cards.map(({ x }) => x)).size).toBe(1);
    await page.screenshot({
      path: testInfo.outputPath(`enterprise-overview-${width}.png`),
      fullPage: true,
    });
  });
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 1440, height: 500 },
  { width: 1041, height: 600 },
  { width: 1040, height: 600 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 768, height: 500 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test(`shared shell spacing ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await fixture(page, true);
    const enterpriseScope = profile.scopes[1];
    await page.route("**/api/auth/admin/session", (route) =>
      route.fulfill({
        json: {
          ...profile,
          name: "开源版集团与企业共同管理的长姓名测试管理员",
          scopes: [
            profile.scopes[0],
            {
              ...enterpriseScope,
              tenant: { id: "tenant", name: "负责多个品牌与地区公司的示例集团" },
              enterprise: {
                id: "enterprise",
                name: "示例集团第一家长名称企业",
                tenantId: "tenant",
              },
            },
            {
              ...enterpriseScope,
              scopeId: "second-enterprise",
              tenant: { id: "tenant", name: "负责多个品牌与地区公司的示例集团" },
              enterprise: { id: "second-enterprise", name: "第二家企业", tenantId: "tenant" },
            },
          ],
        },
      }),
    );

    for (const mode of ["console", "platform"]) {
      await page.goto(`/${mode}/account`);
      await expect(page.locator(".appWorkspace .appHeader h1")).toBeVisible();
      await expect(page.getByRole("button", { name: "保存个人资料", exact: true })).toBeEnabled();
      const sidebar = page.locator(".appSidebar");
      const bottom = sidebar.locator(".appSidebarBottom");
      if (viewport.width > 1040) {
        await expect(bottom).toBeVisible();
        const entry = bottom.getByRole("combobox", { name: "切换入口", exact: true });
        await expect(entry).toBeVisible();
        await entry.focus();
        await expect(entry).toBeFocused();
        const blockRectangles = await bottom.evaluate((element) => {
          const entry = element.querySelector(".entrySwitcher");
          const account = element.querySelector(".sidebarAccountCard");
          const scope = element.querySelector(".scopeCard");
          const foot = element.querySelector(".appSidebarFoot");
          if (!account || !scope || !foot || !entry) throw new Error("Missing sidebar controls");
          const rectangle = (node: Element) => {
            const { top, bottom, left, right } = node.getBoundingClientRect();
            return { top, bottom, left, right };
          };
          return {
            lastAction: rectangle(entry),
            account: rectangle(account),
            scope: rectangle(scope),
            foot: rectangle(foot),
            parent: rectangle(element),
          };
        });
        expect(
          blockRectangles.account.top - blockRectangles.lastAction.bottom,
        ).toBeGreaterThanOrEqual(8);
        expect(blockRectangles.scope.top - blockRectangles.account.bottom).toBeGreaterThanOrEqual(
          8,
        );
        expect(blockRectangles.foot.top - blockRectangles.scope.bottom).toBeGreaterThanOrEqual(8);
        for (const rectangle of [
          blockRectangles.account,
          blockRectangles.scope,
          blockRectangles.foot,
        ]) {
          expect(rectangle.left).toBeGreaterThanOrEqual(blockRectangles.parent.left - 1);
          expect(rectangle.right).toBeLessThanOrEqual(blockRectangles.parent.right + 1);
        }
        const account = bottom.locator(".sidebarAccountCard");
        await account.focus();
        await expect(account).toBeFocused();
        await account.scrollIntoViewIfNeeded();
        await expect(account).toBeInViewport({ ratio: 0.99 });
        const exit = bottom.getByRole("button", { name: "退出登录", exact: true });
        await exit.scrollIntoViewIfNeeded();
        await expect(exit).toBeInViewport({ ratio: 0.99 });
        await separatedControls(bottom.locator(".appSidebarFoot > *"));
        if (mode === "console") {
          await bottom.getByRole("combobox", { name: "切换当前企业" }).scrollIntoViewIfNeeded();
          await expect(bottom.getByRole("combobox", { name: "切换当前企业" })).toBeInViewport({
            ratio: 0.99,
          });
        }
      } else {
        await expect(bottom).toBeHidden();
        const account = page.locator(".mobileAccountLink");
        await account.focus();
        await expect(account).toBeFocused();
        await expect(account).toBeInViewport({ ratio: 0.99 });
        if (mode === "console") {
          await expect(page.locator(".mobileScopeControl")).toBeVisible();
          await separatedControls(
            page.locator(
              ".appWorkspaceColumn > .mobileAccountLink, .appWorkspaceColumn > .mobileScopeControl, .appWorkspaceColumn > .appWorkspace > .appHeader > div:first-child",
            ),
          );
        }
        if (mode === "platform") {
          const settings = sidebar.locator(".appNavSectionToggle").filter({ hasText: "参数设置" });
          await settings.click();
          await expect(settings).toHaveAttribute("aria-expanded", "true");
          const nav = sidebar.locator(".appNavScroll");
          const navigation = await nav.boundingBox();
          expect(navigation?.height).toBeLessThanOrEqual(Math.min(240, viewport.height * 0.4) + 1);
          const security = sidebar.getByRole("link", { name: "安全设置", exact: true });
          await security.click();
          await expect(page).toHaveURL(/\/platform\/settings\/security$/u);
          await expect(page.locator(".mobileAccountLink")).toBeInViewport({ ratio: 0.99 });
        }
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      if (viewport.width === 1440 && viewport.height === 1000)
        await bottom.screenshot({ path: testInfo.outputPath(`${mode}-sidebar-footer.png`) });
    }

    await page.goto("/employee");
    await expect(page.getByRole("heading", { name: "我的内容任务", exact: true })).toBeVisible();
    const refresh = page.getByRole("button", { name: "刷新", exact: true });
    const exit = page.getByRole("button", { name: "退出登录", exact: true });
    await expect(refresh).toBeEnabled();
    const [refreshBox, exitBox] = await Promise.all([refresh.boundingBox(), exit.boundingBox()]);
    if (!refreshBox || !exitBox) throw new Error("Employee header actions did not render");
    expect(Math.abs(refreshBox.y - exitBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(refreshBox.height - exitBox.height)).toBeLessThanOrEqual(1);
    await separatedControls(page.locator("header button"));
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await exit.focus();
    await expect(exit).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    expect(errors).toEqual([]);
    if (viewport.width === 390)
      await page.screenshot({ path: testInfo.outputPath("employee-header.png") });
  });
}

for (const width of [1440, 390]) {
  test(`employee panels keep their spacing without a publishing team at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixture(page, true);
    await page.route("**/auth/employee/web-session", (route) =>
      route.fulfill({ status: 403, json: { message: "尚未加入发布团队" } }),
    );
    const denied = page.waitForResponse(
      (response) =>
        response.url().endsWith("/auth/employee/web-session") && response.status() === 403,
    );
    await page.goto("/employee");
    await denied;
    const notice = page
      .getByRole("heading", { name: "尚未加入发布团队", exact: true })
      .locator("..");
    await expect(notice).toBeVisible();
    await expectEmployeePanelSpacing(page, width, notice);
    const retry = page.waitForResponse(
      (response) =>
        response.url().endsWith("/auth/employee/web-session") && response.status() === 403,
    );
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await retry;
    await expect(notice).toBeVisible();
    await expectEmployeePanelSpacing(page, width, notice);
    await page.screenshot({
      path: testInfo.outputPath(`employee-no-team-${width}.png`),
      fullPage: true,
    });
  });

  test(`employee empty task panels stay aligned at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixture(page, true);
    await page.route("**/employee/tasks", (route) => route.fulfill({ json: [] }));
    await page.goto("/employee");
    await expect(
      page.getByText("暂无任务，团队开放内容后会显示在这里。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "尚未加入发布团队", exact: true })).toHaveCount(
      0,
    );
    await expectEmployeePanelSpacing(page, width);
    await page.screenshot({
      path: testInfo.outputPath(`employee-empty-tasks-${width}.png`),
      fullPage: true,
    });
  });
}

test("a delayed obsolete employee session cannot clear the renewed task list", async ({ page }) => {
  await page.clock.install();
  await fixture(page, true);
  let refreshes = 0;
  let sessions = 0;
  let releaseOld = () => {};
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: `renewed-${++refreshes}`, expiresInSeconds: 62 } }),
  );
  await page.route("**/auth/employee/web-session", async (route) => {
    if (++sessions === 1) {
      await oldGate;
      return route.fulfill({ status: 503, json: { message: "obsolete session failed" } });
    }
    return route.fulfill({ json: { accessToken: "new-employee-token", expiresInSeconds: 3600 } });
  });
  await page.goto("/employee");
  await expect.poll(() => sessions).toBe(1);
  await page.clock.fastForward(3000);
  await expect(page.getByRole("button", { name: /品牌日常分享/u })).toBeVisible();
  const oldResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/auth/employee/web-session") && response.status() === 503,
  );
  releaseOld();
  await oldResponse;
  await expect(page.getByRole("button", { name: /品牌日常分享/u })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "obsolete session failed" })).toHaveCount(
    0,
  );
});

test("an existing account consumes its employee invitation once", async ({ page }) => {
  await fixture(page, true);
  let bindings = 0;
  await page.route("**/auth/employee/web-bind", async (route) => {
    bindings++;
    await route.fulfill({ json: { accessToken: "bound-employee-token", expiresInSeconds: 3600 } });
  });
  await page.goto("/employee?invite=once-only-token");
  await expect(page.getByRole("button", { name: /品牌日常分享/u })).toBeVisible();
  await expect(page).toHaveURL(/\/employee$/u);
  expect(bindings).toBe(1);
});

for (const width of [1440, 390]) {
  test.describe(`${width}px 自托管`, () => {
    test.use({ viewport: { width, height: 1000 } });
    test("密码登录无需短信并进入工作空间", async ({ page }) => {
      const writes = await fixture(page);
      await page.goto("/login");
      await page.getByLabel("账号", { exact: true }).fill("test_admin");
      await page.getByLabel("密码", { exact: true }).fill("TestPassword123");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(page).toHaveURL(/\/console$/u);
      expect(
        writes.some(
          (write) =>
            write.path === "/auth/admin/password-login" && write.body.username === "test_admin",
        ),
      ).toBe(true);
      expect(writes.some((write) => write.path.includes("request-code"))).toBe(false);
    });
    test("旧注册入口只显示登录，不再创建账号", async ({ page }) => {
      const writes = await fixture(page);
      await page.goto(
        `/register?returnTo=${encodeURIComponent("/employee?invite=one-time-token")}`,
      );
      await expect(page).toHaveURL(/\/login$/u);
      await expect(page.getByRole("heading", { name: "账号密码登录" })).toBeVisible();
      await expect(page.getByRole("link", { name: /注册/u })).toHaveCount(0);
      expect(writes.some((write) => write.path === "/auth/admin/register")).toBe(false);
    });

    test("CAP可选配置，Secret不回显", async ({ page }, testInfo) => {
      const writes = await fixture(page, true);
      await page.goto("/platform/settings/security");
      await expect(page.locator('input[aria-label="Cap 验证服务 Secret Key"]')).toHaveValue("");
      await page
        .getByRole("group", { name: "启用 Cap 验证" })
        .getByRole("button", { name: "启用", exact: true })
        .click();
      await page
        .locator('input[aria-label="Cap 验证服务 Endpoint"]')
        .fill("https://cap.example.test/site/");
      await page.locator('input[aria-label="Cap 验证服务 Secret Key"]').fill("fixture-only-secret");
      await page.getByPlaceholder("例如：调整安全设置配置").fill("开启登录验证");
      await page.screenshot({ path: testInfo.outputPath(`cap-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: /保存.*更改/u }).click();
      await expect
        .poll(() => writes.filter((write) => write.path.startsWith("/platform/settings/")).length)
        .toBe(3);
      const changes = writes.filter((write) => write.path.startsWith("/platform/settings/"));
      expect(changes.at(-1)?.path).toContain("security.cap_enabled");
    });
    test("员工确认真实后才可复制和回填", async ({ page }, testInfo) => {
      const writes = await fixture(page, true);
      await page.goto("/employee");
      await page.getByRole("button", { name: /品牌日常分享/u }).click();
      await expectEmployeePanelSpacing(page, width);
      await expect(page.getByRole("button", { name: "复制文案" })).toBeDisabled();
      const checkbox = page.getByRole("checkbox");
      await expect(checkbox).toHaveCSS("width", "16px");
      await expect(checkbox).toHaveCSS("height", "16px");
      await checkbox.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(checkbox).toBeFocused();
      await expect(checkbox).toHaveCSS("outline-style", "solid");
      await page.getByRole("checkbox").check();
      await expect(checkbox).toBeChecked();
      await expect
        .poll(() => checkbox.evaluate((element) => getComputedStyle(element, "::after").opacity))
        .toBe("1");
      await expect(page.getByRole("button", { name: "复制文案" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "确认真实", exact: true })).toHaveCSS(
        "min-height",
        "44px",
      );
      await page.getByRole("button", { name: "确认真实", exact: true }).click();
      await expect(page.getByRole("button", { name: "复制文案" })).toBeEnabled();
      expect(writes.filter((write) => write.path === "/employee/tasks/task/facts")).toEqual([
        { path: "/employee/tasks/task/facts", body: { revision: 1, confirmed: true } },
      ]);
      await page.screenshot({
        path: testInfo.outputPath(`employee-ready-${width}.png`),
        fullPage: true,
      });
      await page.getByLabel("发布后回填链接").fill("https://www.xiaohongshu.com/explore/fixture");
      await page.getByRole("button", { name: "提交发布链接", exact: true }).click();
      await expect
        .poll(() => writes.some((write) => write.path === "/employee/tasks/task/submissions"))
        .toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
    test("通用活动确认失败时不能复制或回填", async ({ page }) => {
      await fixture(page, true);
      await page.goto("/employee");
      await page.getByRole("button", { name: /品牌日常分享/u }).click();
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "确认真实", exact: true }).click();
      await expect(page.getByRole("button", { name: "复制文案" })).toBeEnabled();
      await page.route("**/employee/tasks/task/facts", (route) =>
        route.fulfill({
          status: 409,
          json: { message: "内容已更新，请刷新后确认最新版本。" },
        }),
      );
      await page.getByRole("button", { name: "确认真实", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "内容已更新" })).toBeVisible();
      await expect(page.getByRole("checkbox")).not.toBeChecked();
      await expect(page.getByRole("button", { name: "复制文案" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "提交发布链接", exact: true })).toBeDisabled();
      await expect(page.getByLabel("发布后回填链接")).toBeDisabled();
    });
    test("系统管理员按已注册账号授予角色", async ({ page }) => {
      const writes = await fixture(page, true);
      await page.goto("/platform/access");
      await page.getByLabel("姓名", { exact: true }).fill("团队管理员");
      await page.getByLabel("管理员登录账号").fill("registered_admin");
      await page.getByRole("button", { name: "添加平台后台用户", exact: true }).click();
      await expect
        .poll(() => writes.some((write) => write.path === "/platform/access/admins"))
        .toBe(true);
      const grant = writes.find((write) => write.path === "/platform/access/admins");
      expect(grant?.body.username).toBe("registered_admin");
      expect(grant?.body.phone).toBeUndefined();
      expect(grant?.body.email).toBeUndefined();
    });
  });
}
