import { expect, type Locator, type Page, test } from "@playwright/test";

// Isolated browser fixtures: no request in this suite can change a real employee or rule.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
    ),
  );
  await page.route(/:3100\//u, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked spacing fixture request" } }),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "spacing-fixture-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/account", (route) =>
    route.fulfill({
      json: {
        name: "间距验收管理员",
        email: "spacing@example.test",
        emailVerifiedAt: "2026-10-09T00:00:00.000Z",
      },
    }),
  );
  await page.route("**/auth/admin/session", (route) =>
    route.fulfill({
      json: {
        userId: "spacing-admin",
        phone: "13800000000",
        features: { directorySync: true },
        scopes: [
          {
            scopeType: "TENANT",
            role: { code: "TENANT_ADMIN", name: "集团主管理员" },
            tenant: { id: "tenant", name: "间距验收集团", customerType: "GROUP" },
            inheritedEnterprises: [{ id: "enterprise", name: "间距验收企业" }],
            permissions: [
              "tenant.enterprise.read",
              "tenant.shared-material.manage",
              "enterprise.membership.read",
              "enterprise.membership.manage",
              "enterprise.membership.participation.manage",
              "tenant.membership.policy.manage",
              "tenant.role.manage",
              "tenant.directory.read",
              "tenant.directory.manage",
              "tenant.directory.sync",
              "campaign.read",
              "campaign.manage",
              "campaign.approve",
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

async function expectVerticalGap(above: Locator, below: Locator, minimum = 16) {
  await expect(above).toBeVisible();
  await expect(below).toBeVisible();
  const upper = await above.boundingBox();
  const lower = await below.boundingBox();
  expect(upper).not.toBeNull();
  expect(lower).not.toBeNull();
  if (!upper || !lower) return;
  expect(lower.y - upper.y - upper.height).toBeGreaterThanOrEqual(minimum - 0.5);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

async function expectStyledCheckbox(page: Page, checkbox: Locator) {
  await expect(checkbox).toHaveCSS("appearance", "none");
  await expect(checkbox).toHaveCSS("width", "16px");
  await expect(checkbox).toHaveCSS("height", "16px");
  await page.keyboard.press("Tab");
  await checkbox.focus();
  await expect(checkbox).toBeFocused();
  await expect(checkbox).toHaveCSS("outline-style", "solid");
  expect(
    await checkbox.evaluate((element) => Number.parseFloat(getComputedStyle(element).outlineWidth)),
  ).toBeGreaterThanOrEqual(2);
}

async function mockCompliance(page: Page) {
  const writes: { dryRun: boolean; csv: string; path: string }[] = [];
  await page.route("**/sensitive-rules", (route) => route.fulfill({ json: [] }));
  await page.route("**/geo-entities", (route) => route.fulfill({ json: [] }));
  await page.route("**/sensitive-rules/import-csv", (route) => {
    const body = route.request().postDataJSON() as { dryRun: boolean; csv: string };
    writes.push({ ...body, path: new URL(route.request().url()).pathname });
    return route.fulfill({
      json: { dryRun: body.dryRun, counts: { CREATED: 1 }, rows: [] },
    });
  });
  return writes;
}

async function mockEmployees(page: Page) {
  const writes: { action: string; membershipIds: string[]; reason: string }[] = [];
  await page.route("**/memberships?*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "spacing-member",
            enterpriseId: "enterprise",
            name: "间距测试员工",
            phone: "13800000001",
            employeeNo: "SPACE-001",
            status: writes.length ? "LEFT" : "ACTIVE",
            seatStatus: "ENABLED",
            directoryManaged: false,
            departmentId: null,
            participation: {
              status: "PARTICIPATING",
              lockedByTenant: false,
              effectiveUntil: null,
            },
          },
        ],
        pageInfo: { nextCursor: null, hasNextPage: false },
      },
    }),
  );
  await page.route("**/departments", (route) => route.fulfill({ json: [] }));
  await page.route("**/memberships/import-batches", (route) => route.fulfill({ json: [] }));
  await page.route("**/personnel-policy", (route) =>
    route.fulfill({ json: { allowEnterpriseParticipationManagement: true } }),
  );
  await page.route("**/memberships/bulk", (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { updatedCount: 1 } });
  });
  return writes;
}

async function mockAnalytics(page: Page) {
  await page.route("**/management-actions", (route) => route.fulfill({ json: [] }));
  await page.route("**/dashboard?*", (route) =>
    route.fulfill({
      json: {
        summary: {
          taskCount: 1,
          verifiedCount: 0,
          lateCorrectedCount: 0,
          expiredIncompleteCount: 1,
          completionRate: 0,
          metricTotals: { likes: 0, comments: 0, favorites: 0 },
          metricCoverage: { likes: 0, comments: 0, favorites: 0 },
        },
        metricObservations: [],
        metricWindows: [],
        campaigns: [],
        incompleteEmployees: [
          {
            taskId: "spacing-task",
            enterpriseId: "enterprise",
            enterpriseName: "间距验收企业",
            employeeName: "间距测试员工",
            campaignTitle: "测试活动",
          },
        ],
        contentComparisons: [],
        enterpriseComparisons: [],
        reminders: [],
      },
    }),
  );
}

async function mockCampaignPlanning(page: Page) {
  await page.route("**/console/tenants/tenant/enterprises/enterprise/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = [];
    if (path.endsWith("/workspace"))
      json = {
        steps: [],

        capabilities: { imagesPerDistribution: 1 },
        counts: { effectiveMaterials: 1 },
      };
    else if (path.endsWith("/generation-status"))
      json = { affectedEnterpriseCount: 0, notices: [] };
    else if (path.endsWith("/memberships"))
      json = { items: [], pageInfo: { nextCursor: null, hasNextPage: false } };
    else if (path.endsWith("/draft")) json = { draft: null };
    else if (path.endsWith("/generation-styles"))
      json = {
        contentDirections: [
          { id: "spacing-direction", name: "科普说明", description: "清晰说明", isDefault: false },
        ],
        imageStyles: [
          { id: "spacing-image", name: "自然摄影", description: "自然画面", isDefault: false },
        ],
      };
    return route.fulfill({ json });
  });
}

async function mockAdminUsers(page: Page) {
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
          id: "spacing-operator",
          code: "OPERATOR",
          name: "内容运营",
          description: "维护宣传素材和活动安排，跟进员工参与及执行情况。",
        },
        {
          id: "spacing-reviewer",
          code: "REVIEWER",
          name: "内容审核",
          description: "审核生成内容与合规依据，确认活动可发布后再安排员工开放。",
        },
      ],
    }),
  );
  return writes;
}

for (const width of [1440, 390]) {
  test(`campaign employee cards open matching content or publication records at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const now = new Date().toISOString();
    const names = [
      "待开放员工",
      "待发布员工",
      "已发布员工",
      "生成失败员工",
      "已取消员工",
      "逾期员工",
    ];
    const snapshots = names.map((employeeName, index) => ({
      id: `snapshot-${index}`,
      membershipId: `member-${index}`,
      employeeName,
      employeePhone: `1380000000${index}`,
      departmentName: "信息科",
    }));
    const image = {
      id: "image",
      width: 300,
      height: 400,
      imageUrl: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#d7e6f2"/><text x="20" y="80" font-size="28">专属配图</text></svg>')}`,
    };
    const contents = snapshots.slice(0, 3).map((audienceSnapshot, index) => ({
      id: `content-${index}`,
      membershipId: audienceSnapshot.membershipId,
      audienceSnapshot,
      title: `${audienceSnapshot.employeeName}专属标题`,
      body: "本员工独立内容，用于抽检布局和身份定位验证。",
      images: [image],
      hashtags: ["技术分享"],
      revisions: [],
      riskAssessment: { passed: true, warnings: [], replacedBlocks: [] },
    }));
    const statuses = ["LOCKED", "AVAILABLE", "COMPLETED", "", "CANCELLED", "EXPIRED"];
    const tasks = snapshots
      .filter((_, index) => index !== 3)
      .map((snapshot) => {
        const index = snapshots.indexOf(snapshot);
        return {
          id: `task-${index}`,
          membershipId: snapshot.membershipId,
          status: statuses[index],
          submissions: index === 2 ? [{ status: "VALID", submittedAt: now }] : [],
          employeeContent: contents[index],
        };
      });
    const campaign = {
      id: "wall-campaign",
      title: "员工卡片与内容抽检",
      prompt: "规范介绍技术",
      status: "REVIEW_PENDING",
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      visibleAt: new Date(Date.now() + 3600000).toISOString(),
      expiresAt: new Date(Date.now() + 90000000).toISOString(),
      imageCount: 1,
      audienceCount: 6,
      generatedCount: 3,
      audienceSnapshots: snapshots,
      employeeContents: contents,
      distributionTasks: tasks,
      generationRuns: [
        {
          id: "run",
          createdAt: now,
          status: "FAILED",
          completedCount: 3,
          requestedCount: 6,
          failedCount: 1,
          workItems: [{ membershipId: "member-3", status: "FAILED" }],
        },
      ],
      retrievalEvidence: [],
      blueprint: null,
    };
    const searches: string[] = [];
    await page.route(
      "**/console/tenants/tenant/enterprises/enterprise/campaigns/wall-campaign**",
      (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/timeline")) return route.fulfill({ json: { events: [] } });
        if (url.pathname.endsWith("/work-items")) {
          searches.push(url.searchParams.get("employee") ?? "");
          return route.fulfill({
            json: { items: [], pageInfo: { hasNextPage: false, nextCursor: null } },
          });
        }
        return route.fulfill({ json: campaign });
      },
    );
    const publicationQueries: string[] = [];
    let publicationStatus = "VALID";
    await page.route("**/publication-reviews?*", (route) => {
      const taskId = new URL(route.request().url()).searchParams.get("taskId");
      publicationQueries.push(taskId ?? "");
      return route.fulfill({
        json: {
          items: [
            {
              id: "submission",
              taskId: "task-2",
              status: taskId ? publicationStatus : "MANUAL_REVIEW",
              task: {
                ...tasks.find(({ id }) => id === "task-2"),
                campaignId: campaign.id,
                status: taskId ? "COMPLETED" : "AVAILABLE",
              },
              submittedAt: now,
              verificationAttempt: 1,
              verificationPolicyVersion: "test",
              normalizedUrl: "https://example.test/note",
              extractedImageUrls: [],
              textSimilarityScore: 1,
              imageSimilarityScore: 1,
              factMatchScore: 1,
            },
          ],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      });
    });
    await page.goto("/console/campaigns/wall-campaign");
    const first = page.getByRole("button", { name: "查看待开放员工的专属素材" });
    await first.focus();
    await expect(first).toHaveCSS("outline-width", "2px");
    await first.press("Enter");
    const review = page.locator(".campaignDecisionGrid.singleColumn > article:not([hidden])");
    await expect(review.getByRole("heading", { name: "待开放员工专属标题" })).toBeVisible();
    const container = await page.locator(".campaignDecisionGrid.singleColumn").boundingBox();
    const panel = await review.boundingBox();
    expect(Math.abs((panel?.width ?? 0) - (container?.width ?? 0))).toBeLessThanOrEqual(1);
    await expect(review.getByRole("combobox", { name: "选择员工内容" })).toHaveValue("content-0");
    await expectNoHorizontalOverflow(page);
    await review.screenshot({ path: testInfo.outputPath(`campaign-full-review-${width}.png`) });
    await review.getByRole("button", { name: "需要处理", exact: true }).click();
    await page.getByRole("tab", { name: "概览与下一步" }).click();
    await page.getByRole("button", { name: "查看待发布员工的专属素材" }).click();
    await expect(review.getByRole("combobox", { name: "选择员工内容" })).toHaveValue("content-1");
    await expect(review.getByRole("heading", { name: "待发布员工专属标题" })).toBeVisible();
    await page.getByRole("tab", { name: "概览与下一步" }).click();
    await page.getByRole("button", { name: "查看生成失败员工的生成任务" }).click();
    await expect(page.getByRole("heading", { name: "每名员工的内容准备情况" })).toBeVisible();
    await expect.poll(() => searches.at(-1)).toBe("13800000003");
    await page.getByRole("tab", { name: "概览与下一步" }).click();
    await page.getByRole("button", { name: "查看已取消员工的活动记录" }).click();
    await expect(page.getByRole("heading", { name: "从创建到结束的完整记录" })).toBeVisible();
    await page.getByRole("tab", { name: "概览与下一步" }).click();
    await page.getByRole("button", { name: "查看逾期员工的活动记录" }).click();
    await expect(page.getByRole("heading", { name: "从创建到结束的完整记录" })).toBeVisible();
    await page.getByRole("tab", { name: "概览与下一步" }).click();
    await page.getByRole("link", { name: "查看已发布员工的发布核实记录" }).click();
    await expect(page).toHaveURL(/\/console\/publications\?taskId=task-2$/u);
    await expect(page.getByRole("heading", { name: "员工发布核实记录" })).toBeVisible();
    await expect(page.locator(".reviewQueue")).toContainText("发布已核实");
    await expect(page.getByRole("button", { name: "核实有效", exact: true })).toHaveCount(0);
    expect(new Set(publicationQueries)).toEqual(new Set(["task-2"]));
    await expectNoHorizontalOverflow(page);
    await page
      .locator(".reviewQueuePanel")
      .screenshot({ path: testInfo.outputPath(`employee-publication-${width}.png`) });
    for (const [status, label] of [
      ["VERIFYING", "正在核验"],
      ["INVALID", "内容不匹配"],
      ["DUPLICATE", "链接重复"],
      ["SUPERSEDED", "已被后续提交替代"],
    ]) {
      publicationStatus = status as string;
      await page.reload();
      await expect(page.locator(".reviewQueue")).toContainText(label as string);
      await expect(page.getByRole("button", { name: "核实有效", exact: true })).toHaveCount(0);
    }
    await page.getByRole("link", { name: "发布核实", exact: true }).click();
    await expect(page).toHaveURL(/\/console\/publications$/u);
    await expect(page.getByRole("heading", { name: "待核实发布", exact: true })).toBeVisible();
    await expect.poll(() => publicationQueries.at(-1)).toBe("");
    await expect(page.getByRole("button", { name: "核实有效", exact: true })).toBeEnabled();
  });

  test(`campaign tabs show filtered totals beyond the loaded page at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/workspace", (route) =>
      route.fulfill({
        json: { campaigns: { reviewPending: 1, generationFailed: 0, approved: 2, active: 24 } },
      }),
    );
    const campaignRows = [
      ["approved-campaign", "已批准待开放活动", "APPROVED"],
      ["active-campaign", "员工正在执行的活动", "ACTIVE"],
    ].map(([id, title, status]) => ({
      id,
      title,
      status,
      createdAt: "2026-10-13T00:00:00.000Z",
      visibleAt: "2026-10-14T08:00:00.000Z",
      audienceCount: 1,
      generatedCount: 1,
      imageCount: 1,
      generationRuns: [],
    }));
    const queries: URLSearchParams[] = [];
    await page.route("**/console/tenants/tenant/enterprises/enterprise/campaigns?*", (route) => {
      const query = new URL(route.request().url()).searchParams;
      queries.push(query);
      const statusCounts =
        query.get("search") === "无匹配"
          ? {}
          : query.get("archive") === "ARCHIVED"
            ? { CANCELLED: 5 }
            : {
                ACTIVE: 24,
                APPROVED: 2,
                REVIEW_PENDING: 1,
                GENERATING: 3,
                GENERATION_FAILED: 0,
                CANCELLED: 4,
                EXPIRED: 1,
                COMPLETED: 2,
              };
      return route.fulfill({
        json: {
          statusCounts,
          items:
            query.get("archive") === "ARCHIVED" || query.get("search") === "无匹配"
              ? []
              : campaignRows.filter(
                  ({ status }) => !query.get("status") || status === query.get("status"),
                ),
          pageInfo: { nextCursor: "unused-next-page", hasNextPage: true },
        },
      });
    });
    await page.goto("/console/campaigns");
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveText(["执行中 (26)", "待处理 (4)", "历史活动 (7)", "全部 (37)"]);
    await expect(page.locator(".compactCampaignList > a")).toHaveCount(2);
    await expect(page.getByRole("link", { name: /已批准待开放活动/u })).toContainText("等待开放");
    await expect(page.getByRole("link", { name: /员工正在执行的活动/u })).toContainText(
      "员工执行中",
    );
    await expectNoHorizontalOverflow(page);
    await page.locator(".compactCampaignPanel").screenshot({
      path: testInfo.outputPath(`campaign-executing-${width}.png`),
    });
    await page.goto("/console/campaigns?view=UPCOMING");
    await expect(page.getByRole("tab", { name: "执行中 (26)", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator(".compactCampaignList > a")).toHaveCount(2);
    await page.getByRole("tab", { name: "待处理 (4)", exact: true }).click();
    await expect(page.getByRole("tab", { name: "待处理 (4)", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect
      .poll(() => queries.some((query) => query.get("status") === "GENERATION_FAILED"))
      .toBe(true);
    await page.getByText("更多筛选", { exact: true }).click();
    const archive = page.getByLabel("活动范围", { exact: true });
    await expect(archive).toHaveCSS("appearance", "none");
    await archive.hover();
    await archive.focus();
    await expect(archive).toBeFocused();
    await expect(archive).toHaveCSS("min-height", "38px");
    await page.getByLabel("异常原因", { exact: true }).selectOption("TEMPORARY_SERVICE");
    await expect
      .poll(() => queries.some((query) => query.get("exceptionType") === "TEMPORARY_SERVICE"))
      .toBe(true);
    await page.getByLabel("活动范围", { exact: true }).selectOption("ARCHIVED");
    await expect(tabs).toHaveText(["执行中 (0)", "待处理 (0)", "历史活动 (5)", "全部 (5)"]);
    await page.getByRole("searchbox").fill("无匹配");
    await expect(tabs).toHaveText(["执行中 (0)", "待处理 (0)", "历史活动 (0)", "全部 (0)"]);
    await expectNoHorizontalOverflow(page);
    await page
      .locator(".compactCampaignPanel")
      .screenshot({ path: testInfo.outputPath(`campaign-tab-counts-${width}.png`) });
  });

  test(`department creation generates its code without a manual input at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockEmployees(page);
    const departments: { code: string; id: string; name: string; status: string }[] = [];
    const submitted: unknown[] = [];
    await page.route("**/departments", async (route) => {
      if (route.request().method() === "POST") {
        submitted.push(route.request().postDataJSON());
        await new Promise((resolve) => setTimeout(resolve, 350));
        const body = route.request().postDataJSON() as { name: string };
        const created = {
          code: "DEP_123456789ABC",
          id: "generated-department",
          name: body.name,
          status: "ACTIVE",
        };
        departments.push(created);
        return route.fulfill({ status: 201, json: created });
      }
      return route.fulfill({ json: departments });
    });
    await page.goto("/console/employees");
    await page.getByRole("button", { name: "管理部门", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "管理部门" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("textbox", { name: "部门代码", exact: true })).toHaveCount(0);
    const name = drawer.getByRole("textbox", { name: "部门名称", exact: true });
    await expect(name).toHaveCSS("min-height", "44px");
    await name.fill("信息科");
    const submit = drawer.getByRole("button", { name: "创建部门" });
    await submit.hover();
    await submit.focus();
    await expect(submit).toBeFocused();
    await expect(submit).toBeEnabled();
    const inputBox = await name.boundingBox();
    const buttonBox = await submit.boundingBox();
    if (!inputBox || !buttonBox) throw new Error("Department drawer controls are missing");
    expect(Math.abs(inputBox.x - buttonBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(inputBox.width - buttonBox.width)).toBeLessThanOrEqual(1);
    expect(buttonBox.y).toBeGreaterThan(inputBox.y + inputBox.height + 8);
    await drawer.screenshot({ path: testInfo.outputPath(`department-create-${width}.png`) });
    await submit.click();
    await expect(drawer.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    await expect(submit).toBeEnabled();
    expect(submitted).toEqual([{ name: "信息科" }]);
    await expect(drawer.getByText("DEP_123456789ABC")).toBeVisible();
    await drawer.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(drawer.getByRole("textbox", { name: "部门代码", exact: true })).toHaveValue(
      "DEP_123456789ABC",
    );
    await drawer.getByRole("button", { name: "取消编辑" }).click();
    await expect(drawer.getByRole("textbox", { name: "部门代码", exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test(`console CSV import separates the editor, feedback and actions at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const writes = await mockCompliance(page);
    await page.goto("/console/compliance");
    await page.getByRole("tab", { name: "批量导入", exact: true }).click();
    const panel = page.locator(".complianceWorkspace .panel:visible");
    const scope = panel.getByRole("combobox", { name: "规则作用域", exact: true });
    await expect(scope).toHaveCSS("appearance", "none");
    await scope.selectOption("SHARED");
    await expect(scope).toHaveValue("SHARED");
    const text = panel.getByRole("textbox", { name: "CSV 内容", exact: true });
    const actions = panel.locator(".materialActions");
    await expectVerticalGap(text, actions);
    const preview = panel.getByRole("button", { name: "预检 CSV", exact: true });
    for (const button of await actions.getByRole("button").all()) {
      const bounds = await button.boundingBox();
      expect(bounds?.height).toBeGreaterThanOrEqual(38);
      expect(bounds?.height).toBeLessThanOrEqual(44);
      await expect(button).toHaveCSS("font-size", "12px");
    }
    await preview.focus();
    await expect(preview).toBeFocused();
    await preview.click();
    await expect(panel.locator(".csvImportReport")).toBeVisible();
    await expectVerticalGap(text, panel.locator(".csvImportReport"));
    await expectVerticalGap(panel.locator(".csvImportReport"), actions);
    await expectNoHorizontalOverflow(page);
    await panel.screenshot({ path: testInfo.outputPath(`compliance-import-${width}.png`) });
    await panel.getByRole("button", { name: "确认导入", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "新增 1 条" })).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ dryRun: true });
    expect(writes[1]).toMatchObject({ dryRun: false });
    expect(writes[1]?.path).toBe("/api/console/tenants/tenant/sensitive-rules/import-csv");
  });

  test(`console destructive drawer actions keep their spacing and selection works at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const writes = await mockEmployees(page);
    await page.goto("/console/employees");
    const selection = page.getByRole("checkbox", { name: "选择员工 间距测试员工", exact: true });
    await selection.check();
    await expect(selection).toBeChecked();
    const controlSize = await selection.boundingBox();
    expect(controlSize?.width).toBeGreaterThanOrEqual(14);
    expect(controlSize?.width).toBeLessThanOrEqual(20);
    await page.getByRole("button", { name: "批量离职", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "批量标记离职", exact: true });
    const reason = drawer.getByRole("textbox", { name: "操作说明", exact: true });
    const submit = drawer.getByRole("button", { name: "确认批量标记离职", exact: true });
    await expectVerticalGap(drawer.locator(".bulkImpactCard"), reason.locator(".."));
    await expectVerticalGap(reason, submit);
    await reason.fill("仅用于浏览器验收的模拟离职说明");
    await submit.focus();
    await expect(submit).toBeFocused();
    await expect(submit).toHaveCSS("cursor", "pointer");
    const size = await submit.boundingBox();
    expect(size?.height).toBeGreaterThanOrEqual(36);
    expect(size?.height).toBeLessThanOrEqual(52);
    expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await expectNoHorizontalOverflow(page);
    await drawer.screenshot({ path: testInfo.outputPath(`employees-bulk-leave-${width}.png`) });
    await submit.click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "共处理 1 名员工" })).toBeVisible();
    expect(writes).toEqual([
      {
        action: "LEAVE",
        membershipIds: ["spacing-member"],
        reason: "仅用于浏览器验收的模拟离职说明",
      },
    ]);
  });

  test(`retired directory route opens the employee directory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockEmployees(page);
    await page.goto("/console/directory");
    await expect(page).toHaveURL(/\/console\/employees$/u);
    await expect(page.locator(".employeeDirectoryPanel")).toBeVisible();
    await expect(page.getByRole("button", { name: "编辑连接", exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`directory-redirect-${width}.png`) });
  });

  test(`employee participation lock stays compact, separated and keyboard accessible at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockEmployees(page);
    const writes: unknown[] = [];
    await page.route("**/memberships/spacing-member/participation", (route) => {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: {} });
    });
    await page.goto("/console/employees");
    await page.getByRole("button", { name: "参与设置", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "设置员工参与状态", exact: true });
    const status = drawer.getByRole("combobox", { name: "后续活动参与状态", exact: true });
    const lock = drawer.getByRole("checkbox", { name: /^由集团锁定此状态/u });
    await expect(lock).not.toBeChecked();
    await status.selectOption("PAUSED");
    const recovery = drawer.locator('input[type="datetime-local"]');
    await expect(recovery).toBeVisible();
    await expectVerticalGap(recovery.locator(".."), drawer.locator(".checkboxRow"));
    await lock.check();
    await expect(lock).toBeChecked();
    await expectStyledCheckbox(page, lock);
    await page.keyboard.press("Space");
    await expect(lock).not.toBeChecked();
    await page.keyboard.press("Space");
    await expect(lock).toBeChecked();
    await status.selectOption("EXEMPT");
    await expect(recovery).toHaveCount(0);
    await expectVerticalGap(status, drawer.locator(".checkboxRow"));
    const reason = drawer.getByRole("textbox", { name: "调整原因", exact: true });
    await reason.fill("浏览器验收集团锁定样式");
    await expectVerticalGap(drawer.locator(".checkboxRow"), reason.locator(".."));
    await expectVerticalGap(reason, drawer.locator(".bulkImpactCard"));
    await expectVerticalGap(
      drawer.locator(".bulkImpactCard"),
      drawer.getByRole("button", { name: "确认参与状态" }),
    );
    await expectNoHorizontalOverflow(page);
    await drawer.screenshot({ path: testInfo.outputPath(`employee-participation-${width}.png`) });
    await drawer.getByRole("button", { name: "确认参与状态", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    expect(writes).toEqual([
      { lockedByTenant: true, reason: "浏览器验收集团锁定样式", status: "EXEMPT" },
    ]);
  });

  test(`admin-user role controls align with their copy and submit from the drawer at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const writes = await mockAdminUsers(page);
    await page.goto("/console/access");
    await page.getByRole("button", { name: "添加后台用户", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "添加后台用户", exact: true });
    const name = drawer.getByRole("textbox", { name: "姓名", exact: true });
    const username = drawer.getByRole("textbox", { name: "登录账号", exact: true });
    const password = drawer.locator('input[type="password"]');
    const email = drawer.getByRole("textbox", { name: "邮箱（选填）", exact: true });
    await name.fill("间距验收管理员");
    await username.fill("spacing-admin");
    await password.fill("SpacingAdmin123!");
    const sections = drawer.locator(".drawerForm > .drawerSection");
    await expect(sections).toHaveCount(3);
    await expectVerticalGap(sections.nth(0), sections.nth(1));
    await expectVerticalGap(sections.nth(1), sections.nth(2));
    const nameBounds = await name.boundingBox();
    const usernameBounds = await username.boundingBox();
    expect(nameBounds).not.toBeNull();
    expect(usernameBounds).not.toBeNull();
    if (nameBounds && usernameBounds) {
      if (width >= 720) {
        expect(Math.abs(nameBounds.y - usernameBounds.y)).toBeLessThanOrEqual(1);
        expect(usernameBounds.x - nameBounds.x - nameBounds.width).toBeGreaterThanOrEqual(11.5);
      } else {
        expect(usernameBounds.y - nameBounds.y - nameBounds.height).toBeGreaterThanOrEqual(12);
      }
    }
    const passwordBounds = await password.boundingBox();
    const emailBounds = await email.boundingBox();
    expect(passwordBounds).not.toBeNull();
    expect(emailBounds).not.toBeNull();
    if (passwordBounds && emailBounds && width >= 720) {
      expect(Math.abs(passwordBounds.y - emailBounds.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(passwordBounds.height - emailBounds.height)).toBeLessThanOrEqual(1);
    } else if (width < 720) {
      await expectVerticalGap(password.locator(".."), email.locator(".."), 12);
    }
    const level = drawer.getByRole("combobox", { name: "授权层级", exact: true });
    await expect(level).toHaveCSS("appearance", "none");
    await level.selectOption("ENTERPRISE");
    const target = drawer.getByRole("combobox", { name: "目标企业", exact: true });
    await expect(target).toHaveValue("enterprise");
    const submit = drawer.getByRole("button", { name: "添加后台用户", exact: true });
    await expect(submit).toBeDisabled();
    const roleRows = drawer.locator(".adminRolePicker > label");
    await expect(roleRows).toHaveCount(2);
    for (const row of await roleRows.all()) {
      const checkbox = row.getByRole("checkbox");
      await expectStyledCheckbox(page, checkbox);
      const control = await checkbox.boundingBox();
      const copy = await row.locator(":scope > span").boundingBox();
      expect(control).not.toBeNull();
      expect(copy).not.toBeNull();
      if (control && copy) {
        expect(copy.x - control.x - control.width).toBeGreaterThanOrEqual(9.5);
        expect(
          Math.abs(control.y + control.height / 2 - copy.y - copy.height / 2),
        ).toBeLessThanOrEqual(1);
      }
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
      await expect(row).toHaveClass("selected");
    }
    await expect(submit).toBeEnabled();
    await expectVerticalGap(sections.nth(2), submit);
    await submit.scrollIntoViewIfNeeded();
    expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await expectNoHorizontalOverflow(page);
    await drawer.screenshot({ path: testInfo.outputPath(`admin-user-roles-${width}.png`) });
    await submit.click();
    await expect(drawer).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "间距验收管理员 已加入后台用户" }),
    ).toBeVisible();
    expect(writes).toEqual([
      {
        enterpriseId: "enterprise",
        name: "间距验收管理员",
        username: "spacing-admin",
        password: "SpacingAdmin123!",
        roleCodes: ["OPERATOR", "REVIEWER"],
        scopeType: "ENTERPRISE",
      },
    ]);
  });

  test(`late-correction warning has breathing room before and after at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockAnalytics(page);
    await page.goto("/console/analytics");
    await page.getByRole("tab", { name: /^未完成员工/u }).click();
    await page.getByRole("button", { name: "逾期核实", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "核实逾期发布", exact: true });
    const reason = drawer.getByRole("textbox", { name: "纠正原因", exact: true });
    const noticeBounds = await drawer.locator(".permissionNotice").boundingBox();
    const fieldBounds = await drawer.locator(".field").first().boundingBox();
    expect(noticeBounds).not.toBeNull();
    expect(fieldBounds).not.toBeNull();
    if (noticeBounds && fieldBounds) {
      expect(Math.abs(noticeBounds.x - fieldBounds.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(noticeBounds.width - fieldBounds.width)).toBeLessThanOrEqual(1);
    }
    await reason.fill("浏览器验收说明，不提交真实发布链接");
    const warning = drawer.locator(".inlineWarning");
    await expectVerticalGap(reason, warning);
    await expectVerticalGap(warning, drawer.getByRole("button", { name: "提交逾期验真" }));
    await expectNoHorizontalOverflow(page);
    await drawer.screenshot({ path: testInfo.outputPath(`analytics-correction-${width}.png`) });
  });

  test(`campaign style controls stay aligned when a selected description wraps at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockCampaignPlanning(page);
    await page.goto("/console/campaigns/new");
    const direction = page.getByRole("combobox", { name: "内容方向", exact: true });
    const imageStyle = page.getByRole("combobox", { name: "图片风格", exact: true });
    await direction.selectOption("spacing-direction");
    await imageStyle.selectOption("spacing-image");
    const description = direction.locator("..").locator("small");
    await expect(description).toHaveText("清晰说明");
    await description.evaluate((element) => {
      element.textContent =
        "根据已授权资料解释核心信息，并为首次了解产品的读者补充适用场景与使用说明。".repeat(8);
    });
    const [left, right, hint] = await Promise.all(
      [direction, imageStyle, description].map((control) =>
        control.evaluate((element) => {
          const { x, y, height, bottom } = element.getBoundingClientRect();
          return { x, y, height, bottom };
        }),
      ),
    );
    expect(hint.y - left.bottom).toBeGreaterThanOrEqual(6);
    if (Math.abs(left.x - right.x) > 1) {
      expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(left.height - right.height)).toBeLessThanOrEqual(1);
    } else {
      expect(right.y - hint.bottom).toBeGreaterThanOrEqual(6);
    }
    await expectNoHorizontalOverflow(page);
    await direction
      .locator("..")
      .locator("..")
      .screenshot({
        path: testInfo.outputPath(`campaign-style-help-${width}.png`),
      });
  });

  test(`campaign generation explains an expired schedule and submits after correction at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: new Date("2026-10-10T00:19:30Z") });
    await mockCampaignPlanning(page);
    const submissions: Record<string, unknown>[] = [];
    let finishSubmission = () => {};
    await page.route("**/workspace", (route) =>
      route.fulfill({
        json: {
          steps: [],

          capabilities: { imagesPerDistribution: 1 },
          counts: { effectiveMaterials: 1 },
        },
      }),
    );
    await page.route(/\/memberships(?:\?|$)/u, (route) =>
      route.fulfill({
        json: {
          items: [{ id: "employee", name: "测试员工", status: "ACTIVE", seatStatus: "ENABLED" }],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      }),
    );
    await page.route("**/campaign-planning/draft", (route) =>
      route.fulfill({
        json: {
          draft: {
            step: 4,
            updatedAt: "2026-10-10T00:19:30Z",
            payload: {
              title: "推广林院长全飞技术",
              prompt: "对林院长进行全飞秒技术的推广",
              visibleAt: "2026-10-10T00:20:00Z",

              audienceMode: "ALL",
              imageCount: 1,
              reminderOffsetsHours: [6],
            },
          },
        },
      }),
    );
    await page.route("**/preflight", (route) =>
      route.fulfill({
        json: {
          ready: true,
          serviceStatus: "AVAILABLE",
          checks: [],

          estimatedWaitLevel: "IMMEDIATE",
        },
      }),
    );
    await page.route("**/retrieval-preview", (route) =>
      route.fulfill({
        json: {
          images: [],
          hits: [
            {
              chunkId: "intro",
              materialTitle: "技术资料",
              materialType: "TEXT",
              materialVersion: 1,
            },
          ],
        },
      }),
    );
    await page.route(/\/campaigns$/u, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      submissions.push(route.request().postDataJSON());
      await new Promise<void>((resolve) => {
        finishSubmission = resolve;
      });
      return route.fulfill({ status: 503, json: { message: "测试服务暂不可用，请重试。" } });
    });
    await page.goto("/console/campaigns/new");
    const card = page.getByRole("complementary", { name: "确认生成" });
    const generate = card.getByRole("button", { name: "生成 1 份独立图文", exact: true });
    await expect(generate).toBeEnabled();
    await page.clock.fastForward(35_000);
    expect(
      await page
        .locator('input[type="datetime-local"]')
        .evaluate((input: HTMLInputElement) => input.validity.rangeUnderflow),
    ).toBe(true);
    await expect(card).toContainText("请选择当前或未来的开放时间。");
    await expect(generate).toBeDisabled();
    await page.screenshot({
      path: testInfo.outputPath(`campaign-schedule-expired-${width}.png`),
      fullPage: true,
    });
    expect(submissions).toHaveLength(0);
    await page
      .locator("form.campaignWizard")
      .evaluate((form: HTMLFormElement) => form.requestSubmit());
    const schedule = page.locator('input[type="datetime-local"]');
    await expect(schedule).toBeVisible();
    await expect(schedule).toHaveAccessibleName(/员工可查看素材的时间/u);
    await expect(schedule).toHaveCSS("min-height", "44px");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "请选择当前或未来的开放时间。" }),
    ).toBeVisible();
    await expect(schedule).toBeVisible();
    await schedule.fill("2026-10-10T16:30");
    await schedule.press("Enter");
    await expect(generate).toBeEnabled();
    expect(submissions).toHaveLength(0);
    await generate.click();
    await expect.poll(() => submissions.length).toBe(1);
    await expect(card.getByRole("button", { name: "正在创建生成任务…" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "上一步", exact: true })).toBeDisabled();
    await page
      .locator("form.campaignWizard")
      .evaluate((form: HTMLFormElement) => form.requestSubmit());
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      visibleAt: "2026-10-10T08:30:00.000Z",
    });
    finishSubmission();
    await expect(
      page.getByRole("alert").filter({ hasText: "测试服务暂不可用，请重试。" }),
    ).toBeVisible();
    await expect(generate).toBeEnabled();
    await expectNoHorizontalOverflow(page);
    await card.screenshot({ path: testInfo.outputPath(`campaign-submit-feedback-${width}.png`) });
  });

  test(`campaign final confirmation stays compact and keeps actionable failures at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockCampaignPlanning(page);
    let mode = "PASSED";
    let submitted = 0;
    const passed = [
      "活动准备时间",
      "内容安全服务",
      "企业状态",

      "活动受众",

      "每员工图片数",
      "授权素材",
      "素材检索服务",
      "平台模型路由",
      "生成服务资格",
    ].map((title, index) => ({
      code: `PASSED_${index}`,
      title,
      description: "已通过的检查不需要逐条展示。",
      status: "PASSED",
    }));
    const warning = {
      code: "MATERIAL_EXPIRING",
      title: "部分资料即将到期",
      description: "请确认活动使用期间资料仍然有效。",
      status: "WARNING",
    };
    const blocking = {
      code: "AUTHORIZED_MATERIALS",
      title: "需要授权素材",
      description: "请补充一份有效且已授权的品牌资料，再启动生成。",
      status: "BLOCKING",
    };
    await page.route(/\/memberships(?:\?|$)/u, (route) =>
      route.fulfill({
        json: {
          items: [{ id: "employee", name: "测试员工", status: "ACTIVE", seatStatus: "ENABLED" }],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      }),
    );
    await page.route("**/campaign-planning/draft", (route) =>
      route.fulfill({
        json: {
          draft: {
            step: 4,
            updatedAt: new Date().toISOString(),
            payload: {
              title: "全飞秒技术分享",
              prompt: "介绍全飞秒技术和规范术前评估，表达专业，不夸大效果。",
              visibleAt: new Date(Date.now() + 10 * 3600000).toISOString(),
              imageCount: 1,
              audienceMode: "ALL",
              reminderOffsetsHours: [6],
            },
          },
        },
      }),
    );
    await page.route("**/retrieval-preview", (route) =>
      route.fulfill({
        json: {
          images: [],
          hits:
            mode === "EMPTY"
              ? []
              : [
                  {
                    chunkId: "intro",
                    materialTitle: "技术资料",
                    materialType: "TEXT",
                    materialVersion: 1,
                    rank: 1,
                    score: 0.8,
                    snippet: "已授权技术介绍",
                  },
                ],
        },
      }),
    );
    await page.route("**/preflight", (route) =>
      mode === "ERROR"
        ? route.fulfill({ status: 503, json: { message: "生成准备检查失败，请稍后重试。" } })
        : route.fulfill({
            json: {
              ready: mode !== "BLOCKING" && mode !== "PLATFORM",
              serviceStatus: mode === "PLATFORM" ? "UNAVAILABLE" : "AVAILABLE",
              checks: [
                ...passed,
                ...(mode === "WARNING" || mode === "BLOCKING" ? [warning] : []),
                ...(mode === "BLOCKING" ? [blocking] : []),
              ],

              estimatedWaitLevel: mode === "WARNING" ? "DELAYED" : "IMMEDIATE",
            },
          }),
    );
    await page.route(/\/campaigns$/u, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      submitted++;
      return route.fulfill({
        status: 409,
        json: { message: "浏览器已捕获提交，未创建真实活动。" },
      });
    });
    await page.goto("/console/campaigns/new");
    const card = page.getByRole("complementary", { name: "确认生成" });
    const preparation = card.locator(".campaignPreflight");
    const generate = card.getByRole("button", { name: "生成 1 份独立图文", exact: true });
    await expect(generate).toBeEnabled();
    await expect(preparation).toContainText("可生成");
    await expect(preparation.locator("li")).toHaveCount(0);
    await expect(card.locator("dt")).toHaveCount(0);
    await expect(card).not.toContainText("平台模型路由");
    await expect(card.locator(".campaignGenerationActions button")).toHaveCount(2);
    await expectVerticalGap(generate, card.getByRole("button", { name: "上一步", exact: true }), 8);
    const cardBounds = await card.boundingBox();
    expect(cardBounds?.height).toBeLessThan(420);
    if (width === 1440) {
      const review = await page.locator(".campaignFinalReview").boundingBox();
      expect(Math.abs((cardBounds?.y ?? 0) - (review?.y ?? 0))).toBeLessThanOrEqual(1);
    }
    await expectNoHorizontalOverflow(page);
    await generate.hover();
    await generate.focus();
    await expect(generate).toBeFocused();
    await expect(generate).not.toHaveCSS("box-shadow", "none");
    await page.screenshot({
      path: testInfo.outputPath(`campaign-confirmation-ready-${width}.png`),
      fullPage: true,
    });
    await generate.click();
    await expect.poll(() => submitted).toBe(1);
    mode = "BLOCKING";
    await page.reload();
    await expect(preparation).toContainText(blocking.description);
    await expect(preparation.locator("li")).toHaveCount(2);
    await expect(generate).toBeDisabled();
    for (const row of await preparation.locator("li").all()) {
      const icon = await row.locator(":scope > span").boundingBox();
      const title = await row.locator("strong").boundingBox();
      const lineHeight = await row
        .locator("strong")
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
      if (!icon || !title) throw new Error("Missing check icon or title");
      expect(Math.abs(icon.y + icon.height / 2 - title.y - lineHeight / 2)).toBeLessThanOrEqual(1);
      await expect(row.locator("svg")).toHaveCount(1);
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`campaign-confirmation-blocked-${width}.png`),
      fullPage: true,
    });
    mode = "WARNING";
    await page.reload();
    await expect(preparation).toContainText(warning.description);
    await expect(preparation).toContainText("当前生成任务较多");
    await expect(preparation.locator("li")).toHaveCount(1);
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect.poll(() => submitted).toBe(2);
    mode = "PLATFORM";
    await page.reload();
    await expect(preparation).toContainText("生成服务暂不可用，请联系平台管理员处理。");
    await expect(preparation.locator("li")).toHaveCount(0);
    await expect(generate).toBeDisabled();
    mode = "EMPTY";
    await page.reload();
    await expect(preparation).toContainText("未找到可引用资料");
    await expect(generate).toBeDisabled();
    mode = "ERROR";
    await page.reload();
    await expect(preparation).toContainText("生成准备检查失败，请稍后重试。");
    await expect(preparation).toContainText("检查失败");
    await expect(generate).toBeDisabled();
    expect(submitted).toBe(2);
  });

  test(`campaign template actions are separated from the brief at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockCampaignPlanning(page);
    const templateWrites: Record<string, unknown>[] = [];
    await page.route(/\/campaign-planning\/campaign-templates$/u, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const input = route.request().postDataJSON();
      templateWrites.push(input);
      return route.fulfill({
        json: { ...input, id: `saved-${templateWrites.length}`, status: "ACTIVE" },
      });
    });
    await page.goto("/console/campaigns/new");
    const direction = page.getByRole("combobox", { name: "内容方向", exact: true });
    const imageStyle = page.getByRole("combobox", { name: "图片风格", exact: true });
    await direction.selectOption("spacing-direction");
    await imageStyle.selectOption("spacing-image");
    await page.getByRole("textbox", { name: "活动名称", exact: true }).fill("活动模板布局验收");
    await page
      .getByRole("textbox", { name: "主题和传播目标", exact: true })
      .fill("根据已授权资料说明产品特点和适用场景。");
    await expectVerticalGap(
      page.getByRole("textbox", { name: "主题和传播目标" }).locator(".."),
      page.locator(".templateSaveActions"),
      14,
    );
    await page.locator(".templateSaveActions").scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`campaign-template-actions-${width}.png`) });
    await expect(page.getByLabel("传播要求模板", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "保存传播要求模板", exact: true })).toBeVisible();
    await expect(page.locator(".campaignTemplatePicker select")).toHaveCount(2);
    await expect(page.locator(".templateSaveActions button")).toHaveCount(2);
    await expect(page.getByLabel("活动模板", { exact: true })).toHaveCSS("appearance", "none");
    await page.getByRole("button", { name: "保存为活动模板", exact: true }).click();
    const campaignDrawer = page.getByRole("dialog", { name: "保存活动模板", exact: true });
    await campaignDrawer
      .getByRole("textbox", { name: "模板名称", exact: true })
      .fill("简化活动模板");
    await campaignDrawer.screenshot({
      path: testInfo.outputPath(`campaign-template-drawer-${width}.png`),
    });
    await campaignDrawer.getByRole("button", { name: "保存并立即使用", exact: true }).click();
    await expect(campaignDrawer).toHaveCount(0);
    await expect(page.getByLabel("活动模板", { exact: true })).toHaveValue("saved-1");
    expect(templateWrites).toHaveLength(1);
    expect(templateWrites[0]).toEqual({
      contentDirection: "科普说明",
      contentDirectionPresetId: "spacing-direction",
      imageCount: 1,
      imageStyle: "自然摄影",
      imageStylePresetId: "spacing-image",
      name: "简化活动模板",
      prompt: "根据已授权资料说明产品特点和适用场景。",
      reminderOffsetsHours: [6, 18],
      title: "活动模板布局验收",
    });
    await direction.selectOption("");
    await imageStyle.selectOption("");
    await page.getByLabel("活动模板", { exact: true }).selectOption("");
    await page.getByLabel("活动模板", { exact: true }).selectOption("saved-1");
    await expect(direction).toHaveValue("spacing-direction");
    await expect(imageStyle).toHaveValue("spacing-image");
  });
}
