import { expect, type Locator, type Page, test } from "@playwright/test";

// All account and employee requests are intercepted; this suite sends no SMS.
async function mockEmployees(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
    ),
  );
  await page.route(/:3100\//u, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked employee SMS fixture request" } }),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "employee-sms-fixture", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/account", (route) =>
    route.fulfill({
      json: {
        name: "短信验收管理员",
        email: "employee-sms@example.test",
        emailVerifiedAt: "2026-10-13T00:00:00Z",
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
            scopeType: "TENANT",
            role: { code: "TENANT_ADMIN", name: "集团主管理员" },
            tenant: { id: "tenant", name: "验收集团", customerType: "GROUP" },
            inheritedEnterprises: [{ id: "enterprise", name: "验收企业" }],
            permissions: [
              "enterprise.membership.read",
              "enterprise.membership.manage",
              "enterprise.membership.participation.manage",
              "tenant.membership.policy.manage",
            ],
          },
        ],
      },
    }),
  );
  await page.route("**/generation-status", (route) =>
    route.fulfill({ json: { affectedEnterpriseCount: 0, notices: [] } }),
  );
  await page.route("**/departments", (route) =>
    route.fulfill({ json: [{ id: "department", name: "信息科", code: "IT", status: "ACTIVE" }] }),
  );
  await page.route("**/memberships/import-batches", (route) => route.fulfill({ json: [] }));
  await page.route("**/personnel-policy", (route) =>
    route.fulfill({ json: { allowEnterpriseParticipationManagement: true } }),
  );
  const members = [
    { id: "normal", name: "正常员工", smsNotificationStatus: "NORMAL", status: "ACTIVE" },
    { id: "review", name: "核实员工", smsNotificationStatus: "NEEDS_REVIEW", status: "ACTIVE" },
    {
      id: "pending",
      name: "待验证员工",
      smsNotificationStatus: "PENDING_VERIFICATION",
      status: "PENDING_BIND",
    },
    { id: "unknown", name: "通道异常员工", smsNotificationStatus: null, status: "ACTIVE" },
    { id: "managed", name: "通讯录员工", smsNotificationStatus: "NEEDS_REVIEW", status: "ACTIVE" },
    { id: "left", name: "离职员工", smsNotificationStatus: "NORMAL", status: "LEFT" },
  ].map((member, index) => ({
    ...member,
    enterpriseId: "enterprise",
    employeeNo: `IT-${index + 1}`,
    phone: `1380000000${index + 1}`,
    departmentId: "department",
    seatStatus: "ENABLED",
    directoryManaged: member.id === "managed",
    participation: { status: "PARTICIPATING", lockedByTenant: false, effectiveUntil: null },
  }));
  await page.route("**/memberships?*", (route) => {
    const filter = new URL(route.request().url()).searchParams.get("smsNotificationStatus");
    const items = filter
      ? members.filter((member) => member.smsNotificationStatus === filter)
      : members;
    return route.fulfill({
      json: { items, pageInfo: { totalCount: items.length, nextCursor: null, hasNextPage: false } },
    });
  });
  const writes: { path: string; body: { phone: string; reason: string } }[] = [];
  await page.route("**/memberships/review/phone", (route) => {
    const body = route.request().postDataJSON();
    writes.push({ path: new URL(route.request().url()).pathname, body });
    if (body.phone === members[0]?.phone) {
      return route.fulfill({
        status: 409,
        json: { message: "该手机号已属于本企业的其他员工，请核实后再更正" },
      });
    }
    const member = members.find(({ id }) => id === "review");
    if (!member) throw new Error("Missing review fixture");
    member.phone = body.phone;
    member.status = "PENDING_BIND";
    member.smsNotificationStatus = "PENDING_VERIFICATION";
    return route.fulfill({ json: member });
  });
  return { members, writes };
}

function employeeRow(page: Page, name: string) {
  return page
    .locator(".membershipTable > article")
    .filter({ has: page.getByText(name, { exact: true }) });
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

async function expectStyledSelect(select: Locator) {
  await expect(select).toHaveCSS("min-height", "38px");
  await expect(select).toHaveCSS("border-top-width", "1px");
  await select.focus();
  await expect(select).toBeFocused();
  await expect(select).toHaveCSS("outline-style", "solid");
}

for (const width of [1440, 390]) {
  test(`SMS states and independent phone correction stay usable at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = await mockEmployees(page);
    await page.goto("/console/employees");
    await expect(employeeRow(page, "正常员工").locator(".membershipSmsCell")).toContainText("正常");
    await expect(employeeRow(page, "核实员工").locator(".membershipSmsCell")).toContainText(
      "请核实号码",
    );
    await expect(employeeRow(page, "待验证员工").locator(".membershipSmsCell")).toContainText(
      "待验证",
    );
    await expect(employeeRow(page, "通道异常员工").locator(".membershipSmsCell")).toContainText(
      "—",
    );
    await expect(employeeRow(page, "通道异常员工").locator(".membershipSmsCell")).not.toContainText(
      "待验证",
    );
    await expect(
      employeeRow(page, "通讯录员工").getByRole("button", { name: "编辑", exact: true }),
    ).toHaveCount(0);
    await expect(
      employeeRow(page, "离职员工").getByRole("button", { name: "编辑", exact: true }),
    ).toHaveCount(0);
    for (const label of ["按部门筛选", "按任务参与状态筛选", "按号码状态筛选"]) {
      await expectStyledSelect(page.getByLabel(label));
    }
    const selection = page.getByLabel("选择员工 核实员工", { exact: true });
    await expect(selection).toHaveCSS("appearance", "none");
    await expect(selection).toHaveCSS("width", "16px");
    await expect(selection).toHaveCSS("height", "16px");
    await selection.check();
    await expect(selection).toBeChecked();
    await selection.uncheck();
    await expectNoOverflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath(`employee-sms-${width}.png`),
      fullPage: true,
    });

    await employeeRow(page, "核实员工").getByRole("button", { name: "编辑", exact: true }).click();
    await page
      .getByRole("dialog", { name: "编辑员工资料" })
      .getByRole("button", { name: "更正手机号" })
      .click();
    const drawer = page.getByRole("dialog", { name: "更正员工手机号" });
    const save = drawer.getByRole("button", { name: "保存正确手机号" });
    await expect(drawer).toContainText("解除该员工在本企业的小程序绑定");
    await expect(drawer).toContainText("其他企业的绑定不受影响");
    await expect(save).toBeDisabled();
    await drawer.getByLabel("正确手机号").fill("13800000001");
    await expect(save).toBeDisabled();
    await drawer.getByLabel("更正原因").fill("已与员工确认导入号码录错");
    await expect(save).toBeEnabled();
    await drawer.getByLabel("更正原因").press("Tab");
    await expect(save).toBeFocused();
    await expect(save).toHaveCSS("outline-style", "solid");
    const bounds = await save.boundingBox();
    const drawerBounds = await drawer.boundingBox();
    expect(bounds?.width).toBeLessThanOrEqual((drawerBounds?.width ?? 0) - 20);
    await expectNoOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`employee-phone-${width}.png`),
      fullPage: false,
    });
    await save.click();
    await expect(
      page.getByRole("alert").filter({ hasText: "该手机号已属于本企业的其他员工", visible: true }),
    ).toContainText("该手机号已属于本企业的其他员工");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel("正确手机号")).toHaveValue("13800000001");
    await drawer.getByLabel("正确手机号").fill("13800000999");
    await save.click();
    await expect(drawer).toHaveCount(0);
    await expect(employeeRow(page, "核实员工").locator(".membershipSmsCell")).toContainText(
      "待验证",
    );
    await expect(employeeRow(page, "核实员工")).toContainText("待绑定");
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[1]?.body).toEqual({
      phone: "13800000999",
      reason: "已与员工确认导入号码录错",
    });
    expect(fixture.writes.every(({ path }) => path.endsWith("/phone"))).toBe(true);
  });
}

test("number status filtering searches all employees and retains its filter during pagination", async ({
  page,
}) => {
  await mockEmployees(page);
  const requests: URL[] = [];
  await page.route("**/memberships?*", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const filtered = url.searchParams.get("smsNotificationStatus") === "NEEDS_REVIEW";
    const cursor = url.searchParams.get("cursor");
    const count = filtered ? (cursor ? 1 : 100) : 100;
    const items = Array.from({ length: count }, (_, index) => ({
      id: `${filtered ? "review" : "normal"}-${cursor ? 100 : index}`,
      name: `${filtered ? "核实员工" : "正常员工"}${cursor ? 100 : index}`,
      phone: `138${String(index).padStart(8, "0")}`,
      enterpriseId: "enterprise",
      departmentId: "department",
      status: "ACTIVE",
      seatStatus: "ENABLED",
      directoryManaged: false,
      smsNotificationStatus: filtered ? "NEEDS_REVIEW" : "NORMAL",
    }));
    return route.fulfill({
      json: {
        items,
        pageInfo: {
          totalCount: filtered ? 101 : 201,
          nextCursor: cursor ? null : "next-page",
          hasNextPage: !cursor,
        },
      },
    });
  });
  await page.goto("/console/employees");
  await expect(page.getByText("当前显示 100 / 201 人")).toBeVisible();
  await expect(employeeRow(page, "核实员工0")).toHaveCount(0);
  await page.getByLabel("按号码状态筛选").selectOption("NEEDS_REVIEW");
  await expect(employeeRow(page, "核实员工0")).toBeVisible();
  await expect(page.getByText("当前显示 100 / 101 人")).toBeVisible();
  await page.getByRole("button", { name: "加载更多员工" }).click();
  await expect(page.getByText("当前显示 101 / 101 人")).toBeVisible();
  expect(requests.at(-1)?.searchParams.get("smsNotificationStatus")).toBe("NEEDS_REVIEW");
  expect(requests.at(-1)?.searchParams.get("cursor")).toBe("next-page");
  await expect(employeeRow(page, "核实员工100")).toBeVisible();
});
