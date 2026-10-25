import { expect, test } from "@playwright/test";

const API_BASE_URL = "http://127.0.0.1:3100";

test.afterEach(async ({ page }) => {
  if (page.isClosed()) return;
  const session = await page
    .evaluate(() => JSON.parse(window.localStorage.getItem("xhs-agentic:mvp-session:v1") ?? "null"))
    .catch(() => null);
  if (!session?.adminToken || !session?.tenantId || !session?.enterpriseId) return;
  await page.goto("about:blank").catch(() => undefined);
  await page.request
    .post(
      `${API_BASE_URL}/console/tenants/${session.tenantId}/enterprises/${session.enterpriseId}/campaign-planning/draft/clear`,
      { headers: { authorization: `Bearer ${session.adminToken}` } },
    )
    .catch(() => undefined);
});

const prototypes = [
  { heading: "登录 SaaS 管理后台", name: "admin-login", path: "/login" },
  { heading: "SaaS 平台概览", name: "platform-overview", path: "/platform" },

  { heading: "任务中心", name: "platform-operations", path: "/platform/operations" },
  { heading: "平台模型 API 与路由", name: "platform-models", path: "/platform/models" },
  { heading: "平台用户", name: "platform-access", path: "/platform/access" },
  { heading: "个人中心", name: "platform-account", path: "/platform/account" },
  {
    heading: "平台参数设置",
    name: "platform-settings",
    path: "/platform/settings/general",
  },
  { heading: "管理总览", name: "console-overview", path: "/console" },
  { heading: "企业管理", name: "enterprises", path: "/console/enterprises" },
  {
    heading: "活动",
    name: "campaigns",
    path: "/console/campaigns",
  },
  { heading: "创建营销活动", name: "campaign-new", path: "/console/campaigns/new" },
  { heading: "员工管理", name: "employees", path: "/console/employees" },
  { heading: "组织同步", name: "directory", path: "/console/directory" },
  { heading: "品牌资料", name: "materials", path: "/console/materials" },
  { heading: "内容规范", name: "compliance", path: "/console/compliance" },
  { heading: "GEO 覆盖分析", name: "geo-coverage", path: "/console/geo" },

  { heading: "后台用户", name: "access", path: "/console/access" },
  { heading: "审计日志", name: "audit", path: "/console/audit" },
  { heading: "经营分析", name: "analytics", path: "/console/analytics" },
  { heading: "个人中心", name: "console-account", path: "/console/account" },
  { heading: "明澈内容助手", name: "employee-miniapp", path: "/prototype/employee" },
] as const;

for (const prototype of prototypes) {
  test(`${prototype.name} renders`, async ({ page }) => {
    await page.goto(prototype.path);
    await expect(
      page.getByRole("heading", { exact: true, level: 1, name: prototype.heading }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Internal Server Error");
    await page.screenshot({
      fullPage: true,
      path: `.artifacts/prototypes/${prototype.name}.png`,
    });
  });

  test(`${prototype.name} has no page-level responsive overflow`, async ({ page }) => {
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ height: 1000, width });
      await page.goto(prototype.path);

      const layout = await page.evaluate(() => ({
        body: document.body.scrollWidth,
        root: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));

      expect(layout.root, `${prototype.path} root overflow at ${width}px`).toBeLessThanOrEqual(
        layout.viewport,
      );
      expect(layout.body, `${prototype.path} body overflow at ${width}px`).toBeLessThanOrEqual(
        layout.viewport,
      );
    }
  });
}

test("platform parameter center switches groups and keeps secrets masked responsively", async ({
  page,
}) => {
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ height: 1000, width });
    await page.goto("/platform/settings/general");
    await page.locator('.appNav a[href="/platform/settings/storage"]').click();

    await expect(page).toHaveURL(/\/platform\/settings\/storage$/u);
    await expect(page.getByRole("heading", { exact: true, name: "存储设置" })).toBeVisible();
    const secretRow = page.locator(".parameterRow").filter({ hasText: "Secret Access Key" });
    await expect(secretRow.getByLabel("Secret Access Key", { exact: true })).toHaveValue("");
    await expect(secretRow).toContainText(/••••••••.{4}/u);

    const layout = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      root: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(layout.root).toBeLessThanOrEqual(layout.viewport);
    expect(layout.body).toBeLessThanOrEqual(layout.viewport);
  }
});

test("platform administrator updates and restores a parameter and probes storage in browser", async ({
  page,
}) => {
  await page.goto("/platform/settings/general");
  const platformNameRow = page
    .locator(".parameterRow")
    .filter({ hasText: "general.platform_name" });
  const valueInput = platformNameRow.getByLabel("平台显示名称", { exact: true });
  const reasonInput = platformNameRow.getByLabel("平台显示名称变更原因", { exact: true });
  const saveButton = platformNameRow.getByRole("button", { exact: true, name: "保存" });
  const originalValue = await valueInput.inputValue();
  const testValue = `企声发布 Browser ${Date.now()}`;

  await valueInput.fill(testValue);
  await reasonInput.fill("本地浏览器验证参数写入");
  const firstSave = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/platform/settings/general.platform_name"),
  );
  await saveButton.click();
  expect((await firstSave).ok()).toBe(true);
  await expect(page.getByText("平台显示名称已保存到数据库并写入审计记录")).toBeVisible();
  await expect(saveButton).toBeEnabled();
  await expect(valueInput).toHaveValue(testValue);

  await valueInput.fill(originalValue);
  await reasonInput.fill("本地浏览器测试后恢复参数");
  const restoreSave = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/platform/settings/general.platform_name"),
  );
  await saveButton.click();
  expect((await restoreSave).ok()).toBe(true);
  await expect(page.getByText("平台显示名称已保存到数据库并写入审计记录")).toBeVisible();
  await expect(saveButton).toBeEnabled();
  await page.reload();
  await expect(valueInput).toHaveValue(originalValue);

  await page.locator('.appNav a[href="/platform/settings/storage"]').click();
  const storageProbe = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/platform/settings/storage/test"),
  );
  await page.getByRole("button", { exact: true, name: "测试存储连接" }).click();
  expect((await storageProbe).ok()).toBe(true);
  await expect(page.getByText(/存储连接正常：dev-xhs-agentic/u)).toBeVisible();
});

test("employee CSV import previews quoted fields without writing before confirmation", async ({
  page,
}) => {
  await page.goto("/console/employees");
  await expect(page.getByRole("heading", { level: 1, name: "员工管理" })).toBeVisible();
  await page.getByRole("button", { exact: true, name: "批量导入" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    buffer: Buffer.from(
      '\uFEFF姓名,手机号,工号,部门代码\r\n"林晓,运营",13600000001,DEMO-1,',
      "utf8",
    ),
    mimeType: "text/csv",
    name: "员工预检.csv",
  });

  await expect(page.getByText("预检通过。确认后会再次校验，全部通过才会写入。")).toBeVisible();
  await expect(page.getByText("林晓,运营", { exact: true })).toBeVisible();
  await expect(page.getByText("136****0001", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认整批导入" })).toBeEnabled();
});

test("employee CSV import reports every invalid row and keeps confirmation disabled", async ({
  page,
}) => {
  await page.goto("/console/employees");
  await expect(page.getByRole("heading", { level: 1, name: "员工管理" })).toBeVisible();
  await page.getByRole("button", { exact: true, name: "批量导入" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    buffer: Buffer.from(
      "\uFEFF姓名,手机号,工号,部门代码\r\n错误员工,12345,DUP-1,UNKNOWN\r\n重复员工,12345,DUP-1,UNKNOWN",
      "utf8",
    ),
    mimeType: "text/csv",
    name: "员工错误.csv",
  });

  await expect(page.getByText("手机号不是有效的中国大陆手机号码").first()).toBeVisible();
  await expect(page.getByText("同一批次中工号重复").first()).toBeVisible();
  await expect(page.getByText("部门代码 UNKNOWN 不存在或已停用").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "确认整批导入" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "下载错误报告" })).toBeVisible();
});

test("P1 employee workflow keeps low-frequency operations in accessible drawers", async ({
  page,
}) => {
  await page.goto("/console/employees");
  await expect(page.getByRole("heading", { level: 1, name: "员工管理" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "批量导入员工" })).toHaveCount(0);

  await page.getByRole("button", { exact: true, name: "批量导入" }).click();
  await expect(page.getByRole("dialog", { name: "批量导入员工" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "批量导入员工" })).toHaveCount(0);

  await page.getByRole("button", { exact: true, name: "录入员工" }).click();
  await expect(page.getByRole("dialog", { name: "录入员工" })).toBeVisible();
  await page.getByRole("button", { name: "关闭录入员工" }).click();

  await page.getByRole("tab", { name: /^待绑定/u }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "等待员工绑定小程序" }),
  ).toBeVisible();
});

test("P2 employee workflow supports editing, atomic bulk actions and import history", async ({
  page,
}) => {
  await page.goto("/console/employees");
  await expect(page.getByRole("heading", { level: 1, name: "员工管理" })).toBeVisible();

  await page
    .locator(".membershipActions")
    .getByRole("button", { name: "编辑", exact: true })
    .first()
    .click();
  const editDrawer = page.getByRole("dialog", { name: "编辑员工资料" });
  await expect(editDrawer).toBeVisible();
  await expect(editDrawer.getByLabel("修改说明")).toHaveValue("人资核对后更新员工档案");
  await page.keyboard.press("Escape");

  const firstSelectableEmployee = page.getByRole("checkbox", { name: /^选择员工 /u }).first();
  await firstSelectableEmployee.check();
  await expect(page.getByText("已选择 1 人", { exact: true })).toBeVisible();
  await page.getByRole("button", { exact: true, name: "批量转部门" }).click();
  const bulkDrawer = page.getByRole("dialog", { name: "批量转部门" });
  await expect(bulkDrawer.getByLabel("接收部门")).toBeVisible();
  await expect(bulkDrawer.getByText(/任一员工不符合条件时整批不生效/u)).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { exact: true, name: "导入记录" }).click();
  const historyDrawer = page.getByRole("dialog", { name: "员工导入记录" });
  await expect(historyDrawer.getByText("员工预检.csv", { exact: true }).first()).toBeVisible();
  await expect(historyDrawer.getByText("员工错误.csv", { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { exact: true, name: "管理部门" }).click();
  const departmentDrawer = page.getByRole("dialog", { name: "管理部门" });
  await departmentDrawer.getByRole("button", { exact: true, name: "编辑" }).first().click();
  await expect(departmentDrawer.getByRole("heading", { name: "编辑部门" })).toBeVisible();
  await expect(departmentDrawer.getByRole("button", { name: "保存部门修改" })).toBeVisible();
});

test("P2 campaign planning restores drafts and exposes templates and reminder policy", async ({
  page,
}) => {
  await page.goto("/console/campaigns/new");
  await page.getByRole("heading", { level: 1, name: "创建营销活动" }).waitFor();
  await page.getByRole("button", { name: /活动内容/u }).click();
  await expect(page.locator(".campaignDraftStatus")).toContainText(/草稿已自动保存/u);

  const title = page.getByLabel("活动名称");
  const originalTitle = await title.inputValue();
  const draftTitle = `浏览器草稿 ${Date.now()}`;
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && /campaign-planning\/draft$/u.test(response.url()),
  );
  await title.fill(draftTitle);
  expect((await saved).ok()).toBe(true);
  await expect(page.getByText(/草稿已自动保存/u)).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: /活动内容/u }).click();
  await expect(page.getByLabel("活动名称")).toHaveValue(draftTitle);

  await page.getByRole("button", { exact: true, name: "保存为活动模板" }).click();
  const templateDrawer = page.getByRole("dialog", { name: "保存活动模板" });
  await expect(templateDrawer.getByLabel("模板名称")).toBeVisible();
  await page.keyboard.press("Escape");

  const restore = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && /campaign-planning\/draft$/u.test(response.url()),
  );
  await page.getByLabel("活动名称").fill(originalTitle);
  expect((await restore).ok()).toBe(true);

  await page.getByRole("button", { exact: true, name: "下一步" }).click();
  await page.getByRole("button", { exact: true, name: "下一步" }).click();
  await expect(page.getByText("未完成提醒策略", { exact: true })).toBeVisible();
  await expect(page.getByLabel("开放后 6 小时")).toBeVisible();
  await expect(page.getByLabel("开放后 12 小时")).toBeVisible();
  await expect(page.getByLabel("开放后 18 小时")).toBeVisible();
});

test("P2 management analytics supports periods, group comparison, action drawer and export", async ({
  page,
}) => {
  const initialDashboard = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && /\/dashboard\?from=/u.test(response.url()),
  );
  await page.goto("/console/analytics");
  await page.getByRole("heading", { level: 1, name: "经营分析" }).waitFor();
  expect((await initialDashboard).ok()).toBe(true);

  const sevenDayRequest = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && /\/dashboard\?from=/u.test(response.url()),
  );
  await page.getByLabel("时间范围").selectOption("7");
  expect((await sevenDayRequest).ok()).toBe(true);
  await expect(page.getByText(/环比/u).first()).toBeVisible();

  const groupRequest = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      /\/console\/tenants\/[^/]+\/dashboard\?/u.test(response.url()),
  );
  await page.getByLabel("组织范围").selectOption("GROUP");
  expect((await groupRequest).ok()).toBe(true);
  await page.getByRole("tab", { name: /企业对比/u }).click();
  await expect(page.getByRole("heading", { name: "企业执行与传播对比" })).toBeVisible();

  await page.getByRole("tab", { name: /内容策略对比/u }).click();
  await expect(page.getByRole("heading", { name: "哪些内容策略更值得复用" })).toBeVisible();
  await page.getByRole("tab", { name: /提醒计划/u }).click();
  await expect(page.getByRole("heading", { name: "尚未提交链接的员工提醒时点" })).toBeVisible();

  await page.getByRole("button", { exact: true, name: "新建跟进事项" }).click();
  const actionDrawer = page.getByRole("dialog", { name: "新建管理跟进事项" });
  await expect(actionDrawer.getByLabel("事项标题")).not.toHaveValue("");
  await expect(actionDrawer.getByLabel("负责人")).toBeVisible();
  await expect(actionDrawer.getByLabel("截止时间")).toBeVisible();
  await page.keyboard.press("Escape");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { exact: true, name: "导出管理摘要" }).click();
  expect((await download).suggestedFilename()).toBe("集团经营管理摘要.csv");
});

test("P2 shared interactions preserve keyboard focus and support higher contrast", async ({
  page,
}) => {
  await page.emulateMedia({ contrast: "more" });
  await page.goto("/console/employees");
  await expect(page.getByRole("heading", { level: 1, name: "员工管理" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  const createEmployee = page.getByRole("button", { exact: true, name: "录入员工" });
  await createEmployee.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "录入员工" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(createEmployee).toBeFocused();

  await expect(page.getByRole("tab", { name: /^全部员工/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const borderWidth = await page
    .locator(".metricCard")
    .first()
    .evaluate((element) => getComputedStyle(element).borderTopWidth);
  expect(borderWidth).toBe("2px");

  await page.goto("/console/campaigns/new");
  await page.getByRole("button", { name: /活动内容/u }).click();
  await expect(page.locator(".campaignDraftStatus")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByLabel("活动模板")).toBeVisible();
  await expect(page.getByLabel("传播要求模板")).toHaveCount(0);
});

test("P1 content rules separate rules entities questions and import work", async ({ page }) => {
  await page.goto("/console/compliance");
  await page.getByRole("tab", { name: /^用户问题/u }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "用户真正关心的问题" }),
  ).toBeVisible();

  await page.getByRole("tab", { name: /^批量导入/u }).click();
  await expect(page.getByRole("heading", { exact: true, name: "批量导入敏感规则" })).toBeVisible();

  await page.getByRole("tab", { name: /^品牌实体/u }).click();
  await page.getByRole("button", { exact: true, name: "新增品牌实体" }).click();
  await expect(page.getByRole("dialog", { name: "新增品牌实体" })).toBeVisible();
});

test("P1 enterprise views expose business decisions on demand", async ({ page }) => {
  await page.goto("/console/enterprises");
  await page.getByRole("button", { exact: true, name: "编辑选中企业" }).click();
  await expect(page.getByRole("dialog", { name: /编辑/u })).toBeVisible();
  await page.getByRole("button", { exact: true, name: "停用企业" }).click();
  await expect(page.getByRole("dialog", { name: "确认停用这家企业？" })).toBeVisible();
  await expect(
    page.getByText("员工启用与任务参与状态不会被改写，恢复企业后可继续使用。"),
  ).toBeVisible();
});

test("Sprint 7 material upload modes stay usable at supported widths", async ({ page }) => {
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ height: 1000, width });
    await page.goto("/console/materials");
    await page.getByRole("button", { exact: true, name: "新增资料" }).click();
    await expect(page.getByLabel("选择文件", { exact: true })).toBeVisible();
    await expect(page.getByLabel("资料内容", { exact: true })).toBeVisible();
    await expect(page.getByLabel("标题", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("素材来源")).toHaveCount(0);
    await expect(page.getByText("公开网页", { exact: false })).toHaveCount(0);
    await expect(
      page.getByText("AI 会自动整理标题、摘要和关键词。", { exact: false }),
    ).toBeVisible();

    const layout = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      root: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(layout.root).toBeLessThanOrEqual(layout.viewport);
    expect(layout.body).toBeLessThanOrEqual(layout.viewport);
  }
});

test("Sprint 7 retrieval evidence renders responsively in the campaign wizard", async ({
  page,
}) => {
  await page.route("**/campaigns/retrieval-preview", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        contextCharacters: 42,
        hits: [
          {
            chunkId: "sprint7-evidence",
            enterpriseId: "sprint7-enterprise",
            hitReasons: ["文案关键词命中", "语义相关", "企业私有素材"],
            lexicalScore: 0.91,
            materialId: "sprint7-material",
            materialScopeKey: "sprint7-enterprise",
            materialSeriesId: "sprint7-series",
            materialTitle: "全飞秒 Pro 授权技术资料",
            materialType: "TEXT",
            materialVersion: 3,
            rank: 1,
            score: 0.93,
            snippet: "全飞秒 Pro 内容应说明专业设备、规范术前评估与个体差异。",
            tagScore: 0.75,
            vectorScore: 0.88,
          },
        ],
        query: "全飞秒 Pro 专业设备与术前评估",
        strategyVersion: "hybrid-v1",
      },
      status: 200,
    });
  });

  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ height: 1000, width });
    await page.goto("/console/campaigns/new");
    await expect(page.locator(".campaignDraftStatus")).not.toContainText("正在读取草稿");
    await page.getByRole("button", { name: /活动内容/u }).click();
    await expect(
      page.getByRole("heading", { exact: true, name: "定义这次要传播什么" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(
      page.getByRole("heading", { exact: true, name: "选择收到本期内容的员工" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.getByText("已找到 1 条相关资料")).toBeVisible();
    await expect(page.getByText("全飞秒 Pro 授权技术资料 · v3")).toBeVisible();
    await expect(page.getByText("与本次主题相关度 93%", { exact: false })).toBeVisible();

    const layout = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      root: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(layout.root).toBeLessThanOrEqual(layout.viewport);
    expect(layout.body).toBeLessThanOrEqual(layout.viewport);
  }
});

test("a formally authenticated platform administrator enters with a revocable session", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.evaluate(() => window.localStorage.clear());
  await page.getByLabel("管理员手机号").fill("13800000000");
  await page.getByRole("button", { name: "获取验证码" }).click();
  await expect(page.getByLabel("验证码")).toHaveValue("000000");
  await page.getByRole("button", { name: "验证并进入后台" }).click();

  await expect(page).toHaveURL(/\/platform$/u);
  await expect(page.getByRole("heading", { level: 1, name: "SaaS 平台概览" })).toBeVisible();
  await expect(page.getByRole("button", { name: "退出管理会话" })).toBeVisible();
});
