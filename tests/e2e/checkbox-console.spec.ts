import { expect, type Locator, type Page, test } from "@playwright/test";

// Every identity/business call is intercepted. These tests never modify real
// employees, policies, roles, materials, or create a paid campaign.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
    ),
  );
  await page.route(/:3100\//u, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked checkbox fixture request" } }),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "checkbox-fixture-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/account", (route) =>
    route.fulfill({
      json: {
        name: "复选框验收管理员",
        email: "checkbox@example.test",
        emailVerifiedAt: "2026-10-09T00:00:00Z",
      },
    }),
  );
  await page.route("**/auth/admin/session", (route) =>
    route.fulfill({
      json: {
        userId: "checkbox-admin",
        phone: "13800000000",
        features: { directorySync: true },
        scopes: [
          {
            scopeType: "TENANT",
            role: { code: "TENANT_ADMIN", name: "集团主管理员" },
            tenant: { id: "tenant", name: "复选框验收集团", customerType: "GROUP" },
            inheritedEnterprises: [{ id: "enterprise", name: "复选框验收企业" }],
            permissions: [
              "tenant.enterprise.read",
              "tenant.shared-material.manage",
              "tenant.role.manage",
              "tenant.membership.policy.manage",
              "enterprise.membership.read",
              "enterprise.membership.manage",
              "enterprise.membership.participation.manage",
              "tenant.directory.read",
              "tenant.directory.manage",
              "tenant.directory.sync",
              "campaign.read",
              "campaign.manage",
              "material.manage",
            ],
          },
        ],
      },
    }),
  );
  await page.route("**/generation-status", (route) =>
    route.fulfill({ json: { affectedEnterpriseCount: 0, notices: [] } }),
  );
  await page.route("**/campaign-planning/medical-options", (route) =>
    route.fulfill({ json: { enabled: false } }),
  );
});

const members = [
  { id: "alpha", name: "测试员工甲", phone: "13800000001", status: "ACTIVE" },
  { id: "beta", name: "测试员工乙", phone: "13800000002", status: "ACTIVE" },
  { id: "former", name: "测试离职员工", phone: "13800000003", status: "LEFT" },
].map((member) => ({
  ...member,
  enterpriseId: "enterprise",
  employeeNo: `CHECK-${member.id}`,
  departmentId: "department",
  seatStatus: "ENABLED",
  directoryManaged: false,
  participation: { status: "PARTICIPATING", lockedByTenant: false, effectiveUntil: null },
}));

async function expectCheckbox(control: Locator) {
  await expect(control).toBeVisible();
  await expect(control).toHaveCSS("appearance", "none");
  await expect(control).toHaveCSS("width", "16px");
  await expect(control).toHaveCSS("height", "16px");
  await expect(control).toHaveCSS("padding", "0px");
  const visual = await control.evaluate((element) => {
    const style = getComputedStyle(element);
    // Resolve tokens through an actual CSS property so lab percentages and
    // computed numeric notation compare in the browser's canonical form.
    const probe = document.createElement("span");
    probe.hidden = true;
    probe.style.background = "var(--accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).backgroundColor;
    probe.style.background = "var(--surface)";
    const surface = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      border: Number.parseFloat(style.borderTopWidth),
      radius: Number.parseFloat(style.borderTopLeftRadius),
      background: style.backgroundColor,
      checked: (element as HTMLInputElement).checked,
      mixed: (element as HTMLInputElement).indeterminate,
      disabled: (element as HTMLInputElement).disabled,
      accent,
      surface,
    };
  });
  expect(visual.border).toBeGreaterThanOrEqual(1);
  expect(visual.radius).toBeLessThanOrEqual(3);
  expect(visual.background).not.toBe("rgba(0, 0, 0, 0)");
  // Preserve the real hover/check transition and wait for its settled color.
  await expect
    .poll(() => control.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe(visual.checked || visual.mixed ? visual.accent : visual.surface);
}

async function keyboardToggle(page: Page, control: Locator, checked: boolean) {
  await page.keyboard.press("Tab");
  await control.focus();
  await expect(control).toBeFocused();
  await expect(control).toHaveCSS("outline-style", "solid");
  expect(
    await control.evaluate((element) => Number.parseFloat(getComputedStyle(element).outlineWidth)),
  ).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Space");
  if (checked) await expect(control).toBeChecked();
  else await expect(control).not.toBeChecked();
  await expectCheckbox(control);
}

async function expectLabelLayout(control: Locator) {
  const geometry = await control.evaluate((element) => {
    const input = element.getBoundingClientRect();
    const label = element.closest("label");
    if (!label) throw new Error("Checkbox must have a visible associated label");
    const bounds = label.getBoundingClientRect();
    const siblings = Array.from(label.childNodes)
      .filter((node) => node !== element)
      .flatMap((node) => {
        if (node instanceof Element) return [node.getBoundingClientRect()];
        if (!node.textContent?.trim()) return [];
        const range = document.createRange();
        range.selectNodeContents(node);
        return Array.from(range.getClientRects());
      });
    return {
      inside:
        input.x >= bounds.x - 1 &&
        input.right <= bounds.right + 1 &&
        input.y >= bounds.y - 1 &&
        input.bottom <= bounds.bottom + 1,
      overlaps: siblings.some(
        (copy) =>
          copy.width > 0 &&
          copy.height > 0 &&
          Math.min(input.right, copy.right) > Math.max(input.left, copy.left) + 0.5 &&
          Math.min(input.bottom, copy.bottom) > Math.max(input.top, copy.top) + 0.5,
      ),
    };
  });
  expect(geometry.inside).toBe(true);
  expect(geometry.overlaps).toBe(false);
}

async function expectNoPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

async function mockEmployees(page: Page) {
  const writes: unknown[] = [];
  await page.route("**/memberships?*", (route) =>
    route.fulfill({ json: { items: members, pageInfo: { nextCursor: null, hasNextPage: false } } }),
  );
  await page.route("**/departments", (route) =>
    route.fulfill({
      json: [{ id: "department", name: "测试部门", code: "CHECK", status: "ACTIVE" }],
    }),
  );
  await page.route("**/memberships/import-batches", (route) => route.fulfill({ json: [] }));
  await page.route("**/personnel-policy", (route) =>
    route.fulfill({ json: { allowEnterpriseParticipationManagement: true } }),
  );
  await page.route("**/memberships/alpha/participation", (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  return writes;
}

async function mockDirectory(page: Page) {
  const writes: { path: string; body: unknown }[] = [];
  const connection = {
    id: "checkbox-directory",
    scopeType: "TENANT",
    name: "复选框验收通讯录",
    provider: "WECOM",
    externalOrganizationId: "ww-checkbox-fixture",
    status: "ACTIVE",
    credentialLastFour: "0000",
    syncMode: "MANUAL",
    syncIntervalMinutes: 1440,
    consecutiveFailureCount: 0,
    lastSyncAt: null,
    nextSyncAt: null,
  };
  let policy = {
    enterpriseId: "enterprise",
    allowEnterpriseParticipationManagement: false,
    allowEnterpriseSeatManagement: true,
  };
  const changes = ["CREATE", "UPDATE", "CONFLICT"].map((action, index) => ({
    id: `change-${index}`,
    enterpriseId: "enterprise",
    externalUserId: `external-employee-${index}`,
    action,
    message: action === "CONFLICT" ? "需人工核对手机号冲突" : "可应用的人员资料变化",
  }));
  await page.route("**/console/tenants/tenant/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json: unknown = [];
    if (request.method() === "POST") {
      writes.push({ path, body: request.postDataJSON() });
      if (path.endsWith("/personnel-policies/enterprise"))
        policy = { ...policy, ...request.postDataJSON() };
    }
    if (path.endsWith("/generation-status")) json = { affectedEnterpriseCount: 0, notices: [] };
    else if (path.endsWith("/directory-connections")) json = [connection];
    else if (path.endsWith("/enterprises"))
      json = [{ id: "enterprise", name: "复选框验收企业", status: "ACTIVE" }];
    else if (path.endsWith("/personnel-policies")) json = [policy];
    else if (path.endsWith("/departments"))
      json = [{ id: "external-root", name: "测试组织", path: "集团 / 测试组织" }];
    else if (path.endsWith("/preview"))
      json = {
        id: "checkbox-preview",
        createCount: 1,
        updateCount: 1,
        departureCount: 0,
        conflictCount: 1,
        changes,
      };
    else if (path.endsWith("/apply")) json = { appliedCount: 1, rejectedCount: 0 };
    return route.fulfill({ json });
  });
  return writes;
}

async function mockMaterials(page: Page) {
  const materialBase = {
    enterpriseId: "enterprise",
    content: "用于验证复选框筛选的品牌资料。",
    type: "TEXT",
    version: 1,
    status: "ACTIVE",
    authorizationStatus: "AUTHORIZED",
    ingestionStatus: "READY",
    usabilityStatus: "USABLE",
    validFrom: null,
    tags: [],
    artifacts: [],
    ingestionJobs: [],
    analysis: {},
  };
  await page.route("**/console/tenants/tenant/enterprises/enterprise/materials", (route) =>
    route.fulfill({
      json: [
        {
          ...materialBase,
          id: "expiring",
          seriesId: "expiring",
          title: "即将到期资料",
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
        {
          ...materialBase,
          id: "permanent",
          seriesId: "permanent",
          title: "长期资料",
          expiresAt: null,
        },
      ],
    }),
  );
}

async function mockCampaign(page: Page) {
  const writes: Record<string, unknown>[] = [];
  await page.route("**/console/tenants/tenant/enterprises/enterprise/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = [];
    if (path.endsWith("/generation-status")) json = { affectedEnterpriseCount: 0, notices: [] };
    else if (path.endsWith("/workspace"))
      json = {
        steps: [],

        capabilities: { imagesPerDistribution: 1 },
        counts: { effectiveMaterials: 1 },
      };
    else if (path.endsWith("/memberships"))
      json = { items: members, pageInfo: { nextCursor: null, hasNextPage: false } };
    else if (path.endsWith("/departments"))
      json = [{ id: "department", name: "测试部门", code: "CHECK", status: "ACTIVE" }];
    else if (path.endsWith("/draft")) {
      if (route.request().method() === "POST") writes.push(route.request().postDataJSON());
      json = { draft: null };
    } else if (path.endsWith("/generation-styles"))
      json = {
        contentDirections: [
          { id: "direction", name: "科普", description: "清晰说明", isDefault: true },
        ],
        imageStyles: [{ id: "image", name: "摄影", description: "自然画面", isDefault: true }],
      };
    else if (path.endsWith("/preflight")) json = { ready: true, checks: [] };
    else if (path.endsWith("/retrieval-preview")) json = { hits: [] };
    return route.fulfill({ json });
  });
  return writes;
}

async function mockRoles(page: Page) {
  const writes: unknown[] = [];
  await page.route("**/admin-users", (route) => {
    if (route.request().method() === "POST") {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ json: [] });
  });
  await page.route("**/roles", (route) =>
    route.fulfill({
      json: [
        {
          id: "operator",
          code: "OPERATOR",
          name: "内容运营",
          description: "维护素材，安排营销活动。",
        },
        {
          id: "reviewer",
          code: "REVIEWER",
          name: "内容审核",
          description: "核对内容与合规依据后安排开放。",
        },
      ],
    }),
  );
  return writes;
}

for (const width of [1440, 390]) {
  test(`switching enterprise uses the shared centered loading feedback at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/auth/admin/session", (route) =>
      route.fulfill({
        json: {
          userId: "checkbox-admin",
          phone: "13800000000",
          features: {},
          scopes: [
            {
              scopeType: "TENANT",
              role: { code: "TENANT_ADMIN", name: "集团主管理员" },
              tenant: { id: "tenant", name: "切换验收集团", customerType: "GROUP" },
              inheritedEnterprises: [
                { id: "enterprise", name: "首家企业" },
                { id: "enterprise-b", name: "第二家企业" },
              ],
              permissions: ["tenant.enterprise.read", "enterprise.membership.read"],
            },
          ],
        },
      }),
    );
    await mockEmployees(page);
    await page.route("**/enterprises/enterprise-b/memberships?*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 850));
      await route.fulfill({
        json: { items: [], pageInfo: { nextCursor: null, hasNextPage: false } },
      });
    });
    await page.goto("/console/employees");
    await expect(page.getByRole("heading", { level: 1, name: "员工管理" })).toBeVisible();
    const selector = page.getByRole("combobox", { name: "切换当前企业" });
    await expect(selector).toHaveValue("enterprise");
    await expect(selector).toHaveCSS("appearance", "none");
    await expect(selector).toBeEnabled();
    await selector.hover();
    await selector.focus();
    await expect(selector).toBeFocused();
    const loading = page.locator(".globalLoading");
    await expect(loading).not.toHaveClass(/visible/u);
    await selector.selectOption("enterprise-b");
    await expect(selector).toHaveValue("enterprise-b");
    await expect(loading).toHaveClass(/visible/u);
    await expect(loading.getByText("正在切换企业")).toBeVisible();
    const box = await loading.locator(".globalLoadingCard").boundingBox();
    const backdrop = await loading.boundingBox();
    if (!box || !backdrop) throw new Error("Shared loading card was not displayed");
    expect(Math.abs(box.x + box.width / 2 - backdrop.x - backdrop.width / 2)).toBeLessThan(2);
    expect(Math.abs(box.y + box.height / 2 - backdrop.y - backdrop.height / 2)).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath(`enterprise-switch-${width}.png`) });
    await expect(loading.getByText("正在加载内容")).toBeVisible();
    await expect(loading).not.toHaveClass(/visible/u, { timeout: 5_000 });
    await expect(page.locator(".scopeCard")).toContainText("第二家企业");
    await selector.selectOption("enterprise");
    await expect(loading.getByText("正在切换企业")).toBeVisible();
    await expect(loading).not.toHaveClass(/visible/u, { timeout: 5_000 });
    await expectNoPageOverflow(page);
  });

  test(`employee selection uses consistent unchecked, checked, disabled and mixed states at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    await mockEmployees(page);
    await page.goto("/console/employees");
    // The existing narrow layout hides table headings (including select-all).
    // Verify its mixed state, but exercise only the visible row controls there.
    const all = page.locator('.membershipTableHead input[type="checkbox"]');
    const alpha = page.getByRole("checkbox", { name: "选择员工 测试员工甲", exact: true });
    const beta = page.getByRole("checkbox", { name: "选择员工 测试员工乙", exact: true });
    const former = page.getByRole("checkbox", { name: "选择员工 测试离职员工", exact: true });
    for (const control of [...(width >= 720 ? [all] : []), alpha, beta, former]) {
      await expectCheckbox(control);
      await expectLabelLayout(control);
    }
    await expect(former).toBeDisabled();
    await expect(former).toHaveCSS("cursor", "not-allowed");
    await former.click({ force: true });
    await expect(former).not.toBeChecked();
    await keyboardToggle(page, alpha, true);
    await expect(all).toHaveJSProperty("indeterminate", true);
    if (width >= 720) {
      await expectCheckbox(all);
      await all.check();
    } else await beta.check();
    await expect(all).toHaveJSProperty("indeterminate", false);
    await expect(beta).toBeChecked();
    await expect(former).not.toBeChecked();
    if (width >= 720) await expectCheckbox(all);
    await beta.uncheck();
    await expect(all).toHaveJSProperty("indeterminate", true);
    await expectNoPageOverflow(page);
    await page
      .locator(".membershipTable")
      .screenshot({ path: testInfo.outputPath(`employee-checkboxes-${width}.png`) });
    if (width >= 720) {
      await all.check();
      await all.uncheck();
    } else await alpha.uncheck();
    await expect(alpha).not.toBeChecked();
    await expect(beta).not.toBeChecked();
    await expect(all).toHaveJSProperty("indeterminate", false);
  });

  test(`employee participation lock checkbox remains small and submits its checked state at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    const writes = await mockEmployees(page);
    await page.goto("/console/employees");
    await page
      .locator(".membershipTable article")
      .filter({ hasText: "测试员工甲" })
      .getByRole("button", { name: "参与设置", exact: true })
      .click();
    const drawer = page.getByRole("dialog", { name: "设置员工参与状态", exact: true });
    const lock = drawer.getByRole("checkbox", { name: /^由集团锁定此状态/u });
    await expectCheckbox(lock);
    await expectLabelLayout(lock);
    await keyboardToggle(page, lock, true);
    await drawer
      .getByRole("combobox", { name: "后续活动参与状态", exact: true })
      .selectOption("EXEMPT");
    await drawer.getByRole("textbox", { name: "调整原因", exact: true }).fill("复选框样式验收");
    await expectNoPageOverflow(page);
    await drawer.screenshot({ path: testInfo.outputPath(`participation-checkbox-${width}.png`) });
    await drawer.getByRole("button", { name: "确认参与状态", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    expect(writes).toEqual([{ status: "EXEMPT", lockedByTenant: true, reason: "复选框样式验收" }]);
  });

  test(`directory policy, mapping and preview checkboxes share one compact style at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    const writes = await mockDirectory(page);
    await page.goto("/console/directory");
    const participation = page.getByRole("checkbox", {
      name: "允许本企业管理员决定谁需要参与发布",
      exact: true,
    });
    const seat = page.getByRole("checkbox", { name: "企业可管理员工启用状态", exact: true });
    await expectCheckbox(participation);
    await expectCheckbox(seat);
    await expectLabelLayout(participation);
    await expectLabelLayout(seat);
    await keyboardToggle(page, participation, true);
    await keyboardToggle(page, seat, false);
    await page
      .locator(".personnelPolicyPanel")
      .screenshot({ path: testInfo.outputPath(`directory-policy-${width}.png`) });
    await page.getByRole("button", { name: "保存策略", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "人员管理下放策略已更新" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "选择同步组织", exact: true }).click();
    const mapping = page.getByRole("dialog", { name: "选择同步组织", exact: true });
    const allow = mapping.getByRole("checkbox", { name: /^允许该企业确认本企业人员变化/u });
    await expectCheckbox(allow);
    await expectLabelLayout(allow);
    await keyboardToggle(page, allow, true);
    await mapping.screenshot({
      path: testInfo.outputPath(`directory-mapping-checkbox-${width}.png`),
    });
    await mapping.getByRole("button", { name: "确认组织映射", exact: true }).click();
    await expect(mapping).toHaveCount(0);

    await page.getByRole("button", { name: "预检人员变化", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "预检人员变化", exact: true });
    const changes = preview.locator('.directoryChangeList input[type="checkbox"]');
    await expect(changes).toHaveCount(3);
    for (const control of await changes.all()) {
      await expectCheckbox(control);
      await expectLabelLayout(control);
    }
    await expect(changes.nth(0)).toBeChecked();
    await expect(changes.nth(1)).toBeChecked();
    await expect(changes.nth(2)).not.toBeChecked();
    await keyboardToggle(page, changes.nth(0), false);
    await expectNoPageOverflow(page);
    await preview.screenshot({
      path: testInfo.outputPath(`directory-preview-checkboxes-${width}.png`),
    });
    await preview.getByRole("button", { name: "确认应用 1 项变化", exact: true }).click();
    await expect(preview).toHaveCount(0);
    expect(
      writes.find(({ path }) => path.endsWith("/personnel-policies/enterprise"))?.body,
    ).toMatchObject({
      allowEnterpriseParticipationManagement: true,
      allowEnterpriseSeatManagement: false,
    });
    expect(writes.find(({ path }) => path.endsWith("/mappings"))?.body).toMatchObject({
      allowEnterpriseSyncConfirmation: true,
    });
    expect(writes.find(({ path }) => path.endsWith("/apply"))?.body).toMatchObject({
      changeIds: ["change-1"],
    });
  });

  test(`material expiration filter never inherits search-input dimensions at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    await mockMaterials(page);
    await page.goto("/console/materials");
    const control = page.getByRole("checkbox", { name: "仅看即将到期", exact: true });
    await expect(page.locator(".materialLibrary > article")).toHaveCount(2);
    await expectCheckbox(control);
    await expectLabelLayout(control);
    await keyboardToggle(page, control, true);
    await expect(page.locator(".materialLibrary > article")).toHaveCount(1);
    await expect(page.locator(".materialLibrary")).toContainText("即将到期资料");
    await page
      .locator(".materialLibraryFilters")
      .screenshot({ path: testInfo.outputPath(`material-checkbox-${width}.png`) });
    await keyboardToggle(page, control, false);
    await expect(page.locator(".materialLibrary > article")).toHaveCount(2);
    await expectNoPageOverflow(page);
  });

  test(`campaign employee choices and reminder checkboxes align with their labels at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    await mockCampaign(page);
    await page.goto("/console/campaigns/new");
    await expect(page.getByRole("textbox", { name: "主题和传播目标" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "内容方向", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByRole("button", { name: /^指定员工/u }).click();
    const picker = page.locator(".audienceMemberPicker");
    const selected = picker.getByRole("checkbox");
    await expect(selected).toHaveCount(2);
    for (const control of await selected.all()) {
      await expectCheckbox(control);
      await expectLabelLayout(control);
    }
    await keyboardToggle(page, selected.nth(0), true);
    await expect(picker).toContainText("已选 1 人");
    await picker.getByRole("button", { name: "全选", exact: true }).click();
    await expect(selected.nth(1)).toBeChecked();
    await picker.getByRole("button", { name: "清空", exact: true }).click();
    await expect(selected.nth(0)).not.toBeChecked();
    await selected.nth(1).check();
    await picker.screenshot({ path: testInfo.outputPath(`campaign-members-${width}.png`) });
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    const reminders = page.locator(".reminderChoices");
    await expect(reminders.getByRole("checkbox")).toHaveCount(3);
    for (const control of await reminders.getByRole("checkbox").all()) {
      await expectCheckbox(control);
      await expectLabelLayout(control);
    }
    const sixHours = reminders.getByRole("checkbox", { name: "开放后 6 小时", exact: true });
    const twelveHours = reminders.getByRole("checkbox", { name: "开放后 12 小时", exact: true });
    await expect(sixHours).toBeChecked();
    await keyboardToggle(page, sixHours, false);
    await keyboardToggle(page, twelveHours, true);
    await expect(page.locator(".campaignReminderPolicy")).toContainText("12 小时、18 小时");
    await reminders.screenshot({ path: testInfo.outputPath(`campaign-reminders-${width}.png`) });
    await expectNoPageOverflow(page);
  });

  test(`backoffice role checkboxes keep their 16px grid and support keyboard multiselect at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    const writes = await mockRoles(page);
    await page.goto("/console/access");
    await page.getByRole("button", { name: "添加后台用户", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "添加后台用户", exact: true });
    await drawer.getByRole("textbox", { name: "姓名", exact: true }).fill("复选框验收人员");
    await drawer.getByRole("textbox", { name: "手机号", exact: true }).fill("13800000004");
    const roles = drawer.locator(".adminRolePicker");
    const submit = drawer.getByRole("button", { name: "添加后台用户", exact: true });
    await expect(submit).toBeDisabled();
    await expect(roles.getByRole("checkbox")).toHaveCount(2);
    for (const control of await roles.getByRole("checkbox").all()) {
      await expectCheckbox(control);
      await expectLabelLayout(control);
      await keyboardToggle(page, control, true);
    }
    await expect(submit).toBeEnabled();
    await roles.screenshot({ path: testInfo.outputPath(`role-checkboxes-${width}.png`) });
    await expectNoPageOverflow(page);
    await submit.click();
    await expect(drawer).toHaveCount(0);
    expect(writes).toEqual([
      {
        name: "复选框验收人员",
        phone: "13800000004",
        roleCodes: ["OPERATOR", "REVIEWER"],
        scopeType: "TENANT",
      },
    ]);
  });
}
