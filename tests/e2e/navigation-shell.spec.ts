import { expect, test } from "@playwright/test";

test("localhost admin origin can initialize the idempotent demo workspace", async ({ page }) => {
  await page.goto("http://localhost:3101/console");
  await page.evaluate(() => window.localStorage.removeItem("xhs-agentic:mvp-session:v1"));
  await page.reload();

  await page.getByRole("button", { name: "初始化本机演示数据" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "管理总览" })).toBeVisible({
    timeout: 30_000,
  });
});

test("browser extension attributes do not produce hydration mismatch errors", async ({ page }) => {
  await page.addInitScript(() => {
    const decorate = () => {
      document.documentElement?.setAttribute("fr-init-once", "light");
      document.documentElement?.setAttribute("id", "extension-generated-id");
      for (const element of document.querySelectorAll(
        "h1, strong, .appEyebrow, .sessionRestoreEyebrow",
      )) {
        element.setAttribute("ultimate-bold-correct", "");
      }
    };
    const observer = new MutationObserver(decorate);
    observer.observe(document, { childList: true, subtree: true });
    decorate();
    window.addEventListener("load", () => window.setTimeout(() => observer.disconnect(), 1_000));
  });
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("hydrated")) {
      hydrationErrors.push(message.text());
    }
  });

  await page.goto("/console");
  await expect(page.getByRole("heading", { level: 1, name: "管理总览" })).toBeVisible();

  await page.goto("/console/access");
  await expect(page.getByRole("heading", { level: 1, name: "后台用户" })).toBeVisible();
  expect(hydrationErrors).toEqual([]);
});

test("console navigation keeps the sidebar mounted across route changes", async ({ page }) => {
  await page.goto("/console");
  await expect(page.getByRole("heading", { level: 1, name: "管理总览" })).toBeVisible();

  const sidebar = page.locator(".appSidebar");
  await sidebar.evaluate((element) => {
    element.setAttribute("data-persistence-probe", "mounted");
  });

  const operations = page.getByRole("button", { name: /内容运营/u });
  await operations.click();
  await expect(operations).toHaveAttribute("aria-expanded", "true");
  await page.locator('.appNav a[href="/console/campaigns"]').click();

  await expect(page).toHaveURL(/\/console\/campaigns$/u);
  await expect(page.getByRole("heading", { level: 1, name: "活动" })).toBeVisible();
  await expect(sidebar).toHaveAttribute("data-persistence-probe", "mounted");
  await expect(page.getByRole("button", { name: /内容运营/u })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

test("organization synchronization stays hidden and direct access explains the platform switch", async ({
  page,
}) => {
  await page.goto("/console");
  const organization = page.getByRole("button", { name: /组织管理/u });
  await organization.click();
  await expect(page.locator('.appNav a[href="/console/directory"]')).toHaveCount(0);

  await page.goto("/console/directory");
  await expect(page.getByRole("heading", { level: 1, name: "组织同步" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "组织同步暂未开放" })).toBeVisible();
  await expect(page.getByText(/历史连接和员工数据均已保留/u)).toBeVisible();
  await expect(page.getByRole("link", { name: "返回员工管理" })).toBeVisible();
});

test("SaaS parameter center exposes the disabled organization synchronization switch", async ({
  page,
}) => {
  await page.goto("/platform/settings/general");
  const setting = page.getByRole("article", { name: "组织同步功能" });
  await expect(setting).toBeVisible();
  await expect(setting.getByRole("button", { name: "禁用" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(setting).toContainText("停止新请求、事件接收和自动同步");
});

test("every backend role can open its own account from the fixed sidebar area", async ({
  page,
}) => {
  await page.goto("/console");
  const accountEntry = page.locator('.appSidebarBottom a[href="/console/account"]');
  await expect(accountEntry).toBeVisible();
  await accountEntry.click();

  await expect(page).toHaveURL(/\/console\/account$/u);
  await expect(page.getByRole("heading", { level: 1, name: "个人中心" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "个人资料" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录与安全" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "我的角色与管理范围" })).toBeVisible();
  await expect(page.getByText("手机号验证码", { exact: true })).toBeVisible();
  await expect(page.getByText("无密码模式，无需修改", { exact: true })).toBeVisible();
});

test("campaign work views prioritize active execution and use semantic action buttons", async ({
  page,
}) => {
  await page.goto("/console/campaigns");
  await expect(page.getByRole("heading", { level: 1, name: "活动" })).toBeVisible();

  const tabs = page.getByRole("tab");
  for (const [index, label] of ["执行中", "待处理", "历史活动", "全部"].entries()) {
    await expect(tabs.nth(index)).toHaveText(new RegExp(`^${label} \\(\\d+\\)$`, "u"));
  }
  await expect(page.getByRole("tab", { name: "执行中" })).toHaveAttribute("aria-selected", "true");
  const refresh = page.getByRole("button", { exact: true, name: "刷新" });
  await expect(refresh).toHaveClass(/refreshButton/u);
  expect(
    await refresh.evaluate((element) => getComputedStyle(element, "::before").maskImage),
  ).not.toBe("none");
});

test("drawers and confirmation dialogs use the full viewport instead of the workspace bounds", async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/console/enterprises");
  await expect(page.getByRole("heading", { level: 1, name: "企业管理" })).toBeVisible();

  await page.getByRole("button", { name: "创建企业" }).click();
  await expect(page.getByRole("heading", { name: "创建集团企业" })).toBeVisible();
  await expectFullViewport(page.locator(".workspaceDrawerBackdrop"), 1440, 900);
  await page.getByRole("button", { name: "关闭创建集团企业" }).click();

  await page.getByRole("button", { name: "编辑选中企业" }).click();
  await page.getByRole("button", { name: "停用企业" }).click();
  await expect(page.getByRole("heading", { name: "确认停用这家企业？" })).toBeVisible();
  await expectFullViewport(page.locator(".dialogBackdrop"), 1440, 900);
});

test("tracked refresh displays the centered loading feedback", async ({ page }) => {
  await page.goto("/console");
  await expect(page.getByRole("heading", { level: 1, name: "管理总览" })).toBeVisible();

  await page.route("**/workspace", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    await route.continue();
  });
  await page.getByRole("button", { exact: true, name: "刷新" }).click();

  const loading = page.locator(".globalLoading");
  await expect(loading).toHaveClass(/visible/u);
  await expect(loading.getByText("正在加载内容")).toBeVisible();
  await expect(loading).not.toHaveClass(/visible/u, { timeout: 5_000 });
});

test("an expired access token renews once and transparently retries the page request", async ({
  page,
}) => {
  let overviewRequests = 0;
  await page.route("**/platform/operations/overview", async (route) => {
    overviewRequests += 1;
    if (overviewRequests === 1) {
      await route.fulfill({
        body: JSON.stringify({ message: "Access token is invalid or expired" }),
        contentType: "application/json",
        status: 401,
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/platform");
  await expect(page.getByRole("heading", { level: 1, name: "SaaS 平台概览" })).toBeVisible();
  await expect(page.getByText("Access token is invalid or expired")).toHaveCount(0);
  await expect(page.locator(".metricCard").first().locator("strong")).not.toHaveText("—");
  expect(overviewRequests).toBe(2);
  const expiresAt = await page.evaluate(() => {
    const session = JSON.parse(window.localStorage.getItem("xhs-agentic:mvp-session:v1") ?? "null");
    return session?.accessTokenExpiresAt ?? null;
  });
  expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
});

test("sidebar bottom remains fixed while only the navigation area scrolls", async ({ page }) => {
  await page.setViewportSize({ height: 700, width: 1440 });
  await page.goto("/platform/settings/general");
  await expect(page.getByRole("heading", { level: 1, name: "平台参数设置" })).toBeVisible();

  const navigation = page.locator(".appNavScroll");
  const bottom = page.locator(".appSidebarBottom");
  const before = await bottom.boundingBox();
  expect(before).not.toBeNull();

  await navigation.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const after = await bottom.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
  expect((after?.y ?? 0) + (after?.height ?? 0)).toBeLessThanOrEqual(700);
  await expect(bottom.getByText("平台管理范围")).toBeVisible();
});

test("mobile layout moves the scope switcher above content without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/console");
  await expect(page.getByRole("heading", { level: 1, name: "管理总览" })).toBeVisible();
  await expect(page.locator(".appSidebarBottom")).toBeHidden();
  await expect(page.locator(".mobileScopeControl")).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    root: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dimensions.root).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
});

test("platform health actions keep spacing when inline or wrapped", async ({ page }, testInfo) => {
  await page.goto("/platform");
  const actions = page.locator(".healthActions");
  const links = actions.getByRole("link");
  await expect(links).toHaveCount(2);
  await expect(page.locator(".metricCard").first().locator("strong")).not.toHaveText("—");
  await expect(links.nth(0)).toHaveAttribute("href", "/platform/readback");
  await expect(links.nth(1)).toHaveAttribute("href", "/platform/gates");

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await actions.scrollIntoViewIfNeeded();
    await expect(actions).toHaveCSS("gap", "10px");
    const first = await links.nth(0).boundingBox();
    const second = await links.nth(1).boundingBox();
    const health = await page.locator(".healthList").boundingBox();
    if (!first || !second || !health) throw new Error("Health actions must be visible");
    expect(first.y - (health.y + health.height)).toBeGreaterThanOrEqual(11);
    if (Math.abs(first.y - second.y) < 1) {
      expect(second.x - (first.x + first.width)).toBeGreaterThanOrEqual(9);
    } else {
      expect(second.y - (first.y + first.height)).toBeGreaterThanOrEqual(9);
    }
    for (const box of [first, second]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await expect(links.nth(0)).toHaveCSS("min-height", "34px");
    await links.nth(0).hover();
    await links.nth(0).focus();
    await expect(links.nth(0)).toBeFocused();
    await expect(page.locator(".globalLoading")).not.toHaveClass(/visible/u);
    await links.nth(0).evaluate((element) => element.blur());
    await page
      .locator(".panel")
      .filter({ has: actions })
      .screenshot({
        path: testInfo.outputPath(`platform-health-${width}.png`),
      });
  }

  await links.nth(0).click();
  await expect(page).toHaveURL(/\/platform\/readback$/u);
  await page.goBack();
  await page.locator('.healthActions a[href="/platform/gates"]').click();
  await expect(page).toHaveURL(/\/platform\/gates$/u);
});

async function expectFullViewport(
  locator: import("@playwright/test").Locator,
  width: number,
  height: number,
): Promise<void> {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x).toBe(0);
  expect(bounds?.y).toBe(0);
  expect(bounds?.width).toBe(width);
  expect(bounds?.height).toBe(height);
}
