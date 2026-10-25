import { expect, type Locator, type Page, test } from "@playwright/test";

type FixtureOptions = {
  enterprise?: boolean;
  platform?: boolean;
  mode?: "FORMAL" | "DEVELOPMENT";
  tenantOnly?: boolean;
};

// Every application request is a fixture. Only local Next assets and pages may reach a server.
async function fixture(page: Page, options: FixtureOptions = {}) {
  const enterprise = options.enterprise !== false && !options.tenantOnly;
  const platform = options.platform !== false;
  const tenant = { id: "shell-group", name: "导航演示集团", customerType: "GROUP" };
  const store = { id: "shell-store", name: "导航示例企业" };
  const scopes = [
    ...(options.tenantOnly
      ? [
          {
            scopeType: "TENANT",
            tenant,
            enterprise: null,
            inheritedEnterprises: [],
            role: { code: "TENANT_ADMIN", name: "集团管理员" },
            permissions: ["tenant.enterprise.read"],
          },
        ]
      : []),
    ...(enterprise
      ? [
          {
            scopeType: "ENTERPRISE",
            tenant,
            enterprise: store,
            inheritedEnterprises: [],
            role: { code: "ENTERPRISE_ADMIN", name: "企业管理员" },
            permissions: ["campaign.read", "dashboard.read"],
          },
        ]
      : []),
    ...(platform || enterprise
      ? [
          {
            scopeType: "PLATFORM",
            tenant: null,
            enterprise: null,
            inheritedEnterprises: [],
            role: { code: "PLATFORM_ADMIN", name: "系统管理员" },
            permissions: platform ? ["platform.monitor.read"] : [],
          },
        ]
      : []),
  ];
  const profile = {
    userId: "shell-fixture-user",
    name: "导航演示管理员",
    phone: "",
    features: {},
    scopes,
  };
  const unknown: string[] = [];
  const external: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(
    ({ mode, tenantId, enterpriseId }) => {
      localStorage.setItem(
        "xhs-agentic:mvp-session:v1",
        JSON.stringify({ mode, tenantId, enterpriseId, adminPhone: "", employeePhone: "" }),
      );
    },
    {
      mode: options.mode ?? "FORMAL",
      tenantId: enterprise || options.tenantOnly ? tenant.id : "",
      enterpriseId: enterprise ? store.id : "",
    },
  );
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const local = ["127.0.0.1", "localhost"].includes(url.hostname);
    const api = local && (url.port === "3100" || url.pathname.startsWith("/api/"));
    if (!api) {
      if (local && url.port === "3101") return route.continue();
      external.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    const path = url.pathname.replace(/^\/api/u, "");
    const send = (json: unknown) => route.fulfill({ json });
    if (path === "/public/platform-branding")
      return send({ name: "企声发布 · 导航演示", logoDataUrl: null });
    if (path === "/auth/admin/refresh" || path === "/auth/dev/admin-token")
      return send({ accessToken: "shell-fixture-admin-token", expiresInSeconds: 3600 });
    if (path === "/auth/admin/session") return send(profile);
    if (path === "/auth/admin/account") return send({ name: profile.name, email: null });
    if (path === "/auth/employee/web-session" || path === "/auth/dev/employee-bind")
      return send({ accessToken: "shell-fixture-employee-token", memberships: [] });
    if (path === "/employee/tasks") return send([]);
    if (path.endsWith("/generation-status"))
      return send({ affectedEnterpriseCount: 0, notices: [] });
    if (path.endsWith("/campaigns"))
      return send({ items: [], pageInfo: { hasNextPage: false, nextCursor: null } });
    if (path.endsWith("/workspace")) return send(null);
    if (path === `/console/tenants/${tenant.id}/enterprises` || path.endsWith("/industries"))
      return send([]);
    if (path === "/platform/operations/overview")
      return send({ generatedAt: "2026-10-25T00:00:00Z" });
    unknown.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { message: "Unmocked shell fixture request" } });
  });
  return {
    assertIsolated() {
      expect(unknown, "Every application request must have an explicit fixture").toEqual([]);
      expect(external, "The suite must never call an external origin").toEqual([]);
      expect(errors, "Navigation must not produce browser errors").toEqual([]);
    },
  };
}

function entry(page: Page) {
  return page.getByRole("combobox", { name: "切换入口", exact: true });
}

async function expectEntries(page: Page, labels: string[], current: string) {
  const select = entry(page);
  await expect(select).toHaveCount(1);
  await expect(select).toBeVisible();
  if (labels.length > 1) await expect(select).toBeEnabled();
  else await expect(select).toBeDisabled();
  await expect(select).toHaveValue(current);
  await expect(select.locator("option")).toHaveText(labels);
  await expect(page.locator(".developmentInfo")).toHaveCount(0);
  await expect(page.getByText("开发环境信息", { exact: true })).toHaveCount(0);
  await expect(page.getByText("本机开发数据 · 不影响正式客户", { exact: true })).toHaveCount(0);
  await expect(page.locator(".appSidebarBottom > a.ghostButton")).toHaveCount(0);
}

async function expectLayout(page: Page, select: Locator) {
  await select.scrollIntoViewIfNeeded();
  const box = await select.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(box?.width).toBeGreaterThanOrEqual(100);
  const result = await page.evaluate(() => {
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        ".appSidebarBottom select,.appSidebarBottom button,.appSidebarBottom .sidebarAccountCard,.mobileEntrySwitcher select,.mobileAccountLink,header select,header button",
      ),
    ]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(
        ({ rect }) =>
          rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight,
      );
    const overlaps = [];
    for (const [index, first] of controls.entries()) {
      for (const second of controls.slice(index + 1)) {
        const a = first.rect;
        const b = second.rect;
        if (
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
        )
          overlaps.push([first.element.textContent?.trim(), second.element.textContent?.trim()]);
      }
    }
    return {
      rootWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      viewport: innerWidth,
      overlaps,
      outside: controls
        .filter(({ rect }) => rect.left < -1 || rect.right > innerWidth + 1)
        .map(({ element }) => element.textContent?.trim()),
    };
  });
  expect(result.rootWidth).toBeLessThanOrEqual(result.viewport);
  expect(result.bodyWidth).toBeLessThanOrEqual(result.viewport);
  expect(result.overlaps, "The select, account entry and action buttons must not overlap").toEqual(
    [],
  );
  expect(result.outside, "Navigation controls must stay inside the viewport").toEqual([]);
}

async function expectEmptyScopeHidden(page: Page) {
  const scope = page.locator(".mobileScopeControl");
  await expect(scope).toHaveCount(1);
  await expect(scope).toBeEmpty();
  await expect(scope).toBeHidden();
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test.describe(`shell entry switcher at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("switches between console, platform and employee with one accessible native select", async ({
      page,
    }, testInfo) => {
      const isolated = await fixture(page);
      await page.goto("/console");
      await expect(page.getByRole("heading", { name: "管理总览", exact: true })).toBeVisible();
      await expectEntries(page, ["工作空间", "员工发布", "系统设置"], "/console");
      await expectEmptyScopeHidden(page);
      await expectLayout(page, entry(page));
      await page.keyboard.press("Tab");
      await entry(page).focus();
      await expect(entry(page)).toBeFocused();
      expect(
        await entry(page).evaluate((element) => {
          const style = getComputedStyle(element);
          return style.outlineStyle !== "none" || style.boxShadow !== "none";
        }),
      ).toBe(true);
      await entry(page).click();
      await entry(page).press("Escape");
      await expect(entry(page)).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath(`shell-console-${viewport.width}.png`) });

      if (viewport.width === 1440) {
        await page.setViewportSize({ width: 1440, height: 700 });
        const bottom = page.locator(".appSidebarBottom");
        const before = await bottom.boundingBox();
        expect(before).not.toBeNull();
        expect((before?.y ?? 0) + (before?.height ?? 0)).toBeLessThanOrEqual(700);
        const navigation = page.locator(".appNavScroll");
        await navigation.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const after = await bottom.boundingBox();
        expect(after).not.toBeNull();
        expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
        expect((after?.y ?? 0) + (after?.height ?? 0)).toBeLessThanOrEqual(700);
        await expectLayout(page, entry(page));
        await page.screenshot({ path: testInfo.outputPath("shell-footer-1440x700.png") });
        await page.setViewportSize(viewport);
      }

      await entry(page).selectOption("/platform");
      await expect(page).toHaveURL(/\/platform$/u);
      await expect(page.getByRole("heading", { name: "系统概览", exact: true })).toBeVisible();
      await expectEntries(page, ["工作空间", "员工发布", "系统设置"], "/platform");
      await expectLayout(page, entry(page));
      await page.screenshot({ path: testInfo.outputPath(`shell-platform-${viewport.width}.png`) });

      await entry(page).selectOption("/employee");
      await expect(page).toHaveURL(/\/employee$/u);
      await expect(page.getByRole("heading", { name: "我的内容任务", exact: true })).toBeVisible();
      await expectEntries(page, ["工作空间", "员工发布", "系统设置"], "/employee");
      await expectLayout(page, entry(page));
      await page.screenshot({ path: testInfo.outputPath(`shell-employee-${viewport.width}.png`) });

      await entry(page).selectOption("/console");
      await expect(page).toHaveURL(/\/console$/u);
      await expectEntries(page, ["工作空间", "员工发布", "系统设置"], "/console");
      isolated.assertIsolated();
    });

    test("hides system settings without platform permissions, including an empty platform scope", async ({
      page,
    }) => {
      const isolated = await fixture(page, { platform: false });
      await page.goto("/console");
      await expectEntries(page, ["工作空间", "员工发布"], "/console");
      await entry(page).selectOption("/employee");
      await expectEntries(page, ["工作空间", "员工发布"], "/employee");
      await expectLayout(page, entry(page));
      await entry(page).selectOption("/console");
      await expectEntries(page, ["工作空间", "员工发布"], "/console");
      isolated.assertIsolated();
    });

    test("hides workspace without tenant or enterprise access", async ({ page }) => {
      const isolated = await fixture(page, { enterprise: false });
      await page.goto("/platform");
      await expectEntries(page, ["员工发布", "系统设置"], "/platform");
      await expectLayout(page, entry(page));
      await entry(page).selectOption("/employee");
      await expectEntries(page, ["员工发布", "系统设置"], "/employee");
      isolated.assertIsolated();
    });

    test("keeps workspace for a tenant administrator with no enterprise and opens enterprise management", async ({
      page,
    }) => {
      const isolated = await fixture(page, { tenantOnly: true, platform: false });
      await page.goto("/console");
      await expect(page).toHaveURL(/\/console\/enterprises$/u);
      await expect(page.getByRole("heading", { name: "企业管理", exact: true })).toBeVisible();
      await expectEntries(page, ["工作空间", "员工发布"], "/console");
      await expectEmptyScopeHidden(page);
      await expectLayout(page, entry(page));
      await entry(page).selectOption("/employee");
      await expectEntries(page, ["工作空间", "员工发布"], "/employee");
      await entry(page).selectOption("/console");
      await expect(page).toHaveURL(/\/console\/enterprises$/u);
      await expectEntries(page, ["工作空间", "员工发布"], "/console");
      isolated.assertIsolated();
    });

    test("does not offer management entries to an employee with no administrative scopes", async ({
      page,
    }) => {
      const isolated = await fixture(page, { enterprise: false, platform: false });
      await page.goto("/employee");
      await expectEntries(page, ["员工发布"], "/employee");
      await expectLayout(page, entry(page));
      isolated.assertIsolated();
    });

    test("removes the development information block from development sessions too", async ({
      page,
    }) => {
      const isolated = await fixture(page, { mode: "DEVELOPMENT" });
      await page.goto("/console");
      await expectEntries(page, ["工作空间", "员工发布", "系统设置"], "/console");
      await entry(page).selectOption("/platform");
      await expectEntries(page, ["工作空间", "员工发布", "系统设置"], "/platform");
      isolated.assertIsolated();
    });
  });
}
