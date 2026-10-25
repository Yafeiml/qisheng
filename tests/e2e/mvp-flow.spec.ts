import { expect, type Page, test } from "@playwright/test";

const API_BASE_URL = "http://127.0.0.1:3100";

test.describe
  .serial("live local MVP flow", () => {
    let generatedCampaignTitle = "";
    let manualPublicationMarker = "";

    test("operator generates, approves and unlocks unique employee content", async ({ page }) => {
      const title = `E2E 全飞秒内容 ${Date.now()}`;
      generatedCampaignTitle = title;
      await page.goto("/console/campaigns/new");
      await expect(page.getByRole("heading", { level: 1, name: "创建营销活动" })).toBeVisible();
      await page.getByRole("button", { name: /活动内容/u }).click();
      await page.getByLabel("活动名称").fill(title);
      await page
        .getByLabel("主题和传播目标")
        .fill("生成全飞秒 Pro 的小红书风格科普，侧重设备、规范评估与个体差异。禁止绝对承诺。");
      await page.getByRole("button", { name: "下一步" }).click();
      await page.getByRole("button", { name: "下一步" }).click();
      const localPast = localDateTime(new Date(Date.now() - 60_000));
      await page
        .getByLabel("员工可查看素材的时间")
        .fill(localDateTime(new Date(Date.now() + 120_000)));
      await page.getByRole("button", { name: "下一步" }).click();
      await page.getByRole("button", { name: /生成 3 份独立图文/u }).click();

      await expect(page).toHaveURL(/\/console\/campaigns\/[0-9a-f-]+$/u, { timeout: 30_000 });
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(page.getByText("等待审核", { exact: true }).first()).toBeVisible();
      await page.getByRole("tab", { name: "内容审核" }).click();
      await expect(page.getByAltText(/独立生成图/u)).toBeVisible();
      await page.getByRole("tab", { name: "记录与诊断" }).click();
      await expect(page.getByText(/3\/3 名员工已生成 · 0 名未成功生成/u)).toBeVisible();
      await page.getByRole("tab", { name: "员工执行" }).click();
      await expect(page.getByRole("table", { name: "员工级生成任务" })).toBeVisible();
      await expect(page.getByRole("columnheader", { name: "失败分类" })).toBeVisible();
      await expect(page.getByText("套餐生成能力")).not.toBeVisible();
      await expect(page.locator("body")).not.toContainText(/Provider|模型调用/u);

      await page.getByRole("tab", { name: "概览与下一步" }).click();
      await page.getByLabel("员工可查看素材的时间").fill(localPast);
      await page.getByRole("button", { name: "确认排期发布" }).click();
      await page
        .getByRole("dialog", { name: "确认本期内容排期发布？" })
        .getByRole("button", { exact: true, name: "确认排期发布" })
        .click();
      await expect(
        page.getByRole("heading", { exact: true, level: 2, name: "活动已批准" }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: "本期发布墙" })).toBeVisible();
      await expect(page.locator(".publicationWall .publicationPerson")).toHaveCount(3);
      await expect(page.locator(".approvalCard").getByText("员工素材开放时间")).toBeVisible();
      await expect(page.getByRole("link", { name: "返回活动列表" })).toHaveClass(/backButton/u);
      await expect(page.getByRole("button", { exact: true, name: "刷新" })).toHaveClass(
        /refreshButton/u,
      );
      await expect(page.locator(".campaignMeta .statusBadge")).toHaveText("员工执行中");
    });

    test("employee sees only their package and completes development verification", async ({
      page,
    }) => {
      await page.goto("/prototype/employee");
      await expect(page.getByRole("heading", { level: 1, name: "明澈内容助手" })).toBeVisible();
      const generatedTask = page
        .locator(".employeeTaskList > button")
        .filter({ hasText: generatedCampaignTitle });
      await generatedTask.click();
      await expect(page.getByAltText("本员工独立生成图片")).toBeVisible();
      await page.getByRole("button", { name: "复制完整文案" }).click();
      await expect(page.getByText("文案已复制，并记录复制事件")).toBeVisible();

      await page.getByText("开发测试工具").click();
      await page.getByRole("button", { name: "生成本机测试链接" }).click();
      await expect(page.getByText(/本机测试链接已生成/u)).toBeVisible();
      await expect(page.getByLabel("小红书发布链接或分享文本")).toHaveValue(
        /https:\/\/fixture\.xhs\.local\/explore\//u,
      );
      await page.getByRole("button", { exact: true, name: "提交发布链接" }).click();
      await expect(page.getByRole("heading", { level: 3, name: "发布已验证" })).toBeVisible();
      await expect(page.getByText("发布内容已通过链接去重、正文与独立图片匹配")).toBeVisible();
    });

    test("a second employee can submit a real-looking link for manual review", async ({ page }) => {
      await page.goto("/prototype/employee");
      await expect(page.getByRole("heading", { level: 1, name: "明澈内容助手" })).toBeVisible();
      await page.getByLabel("绑定 / 加入其他企业").fill("13600000002");
      const reboundTasks = page.waitForResponse(
        (response) =>
          response.url().endsWith("/employee/tasks") &&
          response.request().method() === "GET" &&
          response.ok(),
      );
      await page.getByRole("button", { name: "重新绑定" }).click();
      await expect(page.getByText(/手机号已重新绑定/u)).toBeVisible();
      await reboundTasks;
      const generatedTask = page
        .locator(".employeeTaskList > button")
        .filter({ hasText: generatedCampaignTitle });
      await expect(generatedTask).toBeVisible();
      await generatedTask.click();
      await expect(
        page.locator(".employeeTaskDetail").getByRole("heading", {
          level: 2,
          name: generatedCampaignTitle,
        }),
      ).toBeVisible();
      manualPublicationMarker = crypto.randomUUID().replaceAll("-", "");
      await page
        .getByLabel("小红书发布链接或分享文本")
        .fill(`https://www.xiaohongshu.com/explore/${manualPublicationMarker}`);
      await page.getByRole("button", { exact: true, name: "提交发布链接" }).click();
      await expect(page.getByRole("heading", { level: 3, name: "链接正在核实" })).toBeVisible();
      await expect(
        page.getByText("你已按时提交，无需重复提交；系统或人工核实期间不会被记为未完成。"),
      ).toBeVisible();
    });

    test("core workspace excludes deferred publication operations and review queue handles them", async ({
      page,
    }) => {
      await page.goto("/console");
      await expect(page.getByRole("heading", { level: 1, name: "管理总览" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: "企业运营基础正常" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: "今日工作优先级" })).toBeVisible();
      await expect(page.getByText("运营准备", { exact: true })).toBeVisible();
      await expect(page.getByText("自动生成", { exact: true })).toBeVisible();
      await expect(page.getByText("人工批准", { exact: true })).toBeVisible();
      await expect(page.getByText("安排开放", { exact: true })).toBeVisible();
      await expect(page.getByText("发布链接人工复核", { exact: true })).toHaveCount(0);
      await expect(page.getByText("最新阅读排名", { exact: true })).toHaveCount(0);

      const session = await browserSession(page);
      const base = `/console/tenants/${session.tenantId}/enterprises/${session.enterpriseId}`;
      const headers = { authorization: `Bearer ${session.adminToken}` };
      const reviewPage = (await (
        await page.request.get(`${API_BASE_URL}${base}/publication-reviews`, { headers })
      ).json()) as { items: Array<{ id: string; normalizedUrl: string }> };
      const review = reviewPage.items.find(({ normalizedUrl }) =>
        normalizedUrl.includes(manualPublicationMarker),
      );
      if (!review) throw new Error("Expected the deferred publication review fixture");

      await page.goto("/console/publications");
      await expect(page.getByRole("heading", { level: 1, name: "发布验真" })).toBeVisible();
      const reviewCard = page.locator(".reviewQueue > article").filter({
        hasText: manualPublicationMarker,
      });
      await expect(reviewCard).toBeVisible();
      await expect(reviewCard.getByText("公开内容暂不可用", { exact: true })).toBeVisible();
      await reviewCard.getByLabel("复核或重试依据").fill("E2E 人工核对公开内容通过");
      await reviewCard.getByRole("button", { name: "核实有效" }).click();
      await expect(page.getByText("该发布已核实为有效", { exact: true })).toBeVisible();

      await page.goto("/console/analytics");
      await expect(page.getByRole("heading", { level: 1, name: "经营分析" })).toBeVisible();
      await expect(page.getByText("有效发布", { exact: true })).toBeVisible();
    });

    test("expired task can be corrected through analytics without changing on-time completion", async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const title = `E2E 逾期纠错 ${Date.now()}`;
      const marker = crypto.randomUUID().replaceAll("-", "");
      const expiredVisibleAt = localDateTime(new Date(Date.now() - 25 * 60 * 60 * 1000));

      await page.goto("/console/campaigns/new");
      await page.getByRole("button", { name: /活动内容/u }).click();
      await page.getByLabel("活动名称").fill(title);
      await page.getByRole("button", { name: "下一步" }).click();
      await page.getByRole("button", { name: /指定员工/u }).click();
      await page
        .locator(".audienceMemberPicker label")
        .filter({ hasText: "周宁" })
        .getByRole("checkbox")
        .check();
      await page.getByRole("button", { name: "下一步" }).click();
      await page.getByLabel("员工可查看素材的时间").fill(expiredVisibleAt);
      await page.getByRole("button", { name: "下一步" }).click();
      await page.getByRole("button", { name: "生成 1 份独立图文" }).click();

      await expect(page).toHaveURL(/\/console\/campaigns\/[0-9a-f-]+$/u, { timeout: 30_000 });
      const campaignId = page.url().split("/").at(-1);
      if (!campaignId) throw new Error("Expected the late-correction campaign id");
      await expect(page.getByText("等待审核", { exact: true }).first()).toBeVisible();
      await page.getByRole("tab", { name: "概览与下一步" }).click();
      await page.getByLabel("员工可查看素材的时间").fill(expiredVisibleAt);
      await page.getByRole("button", { name: "确认排期发布" }).click();
      await page
        .getByRole("dialog", { name: "确认本期内容排期发布？" })
        .getByRole("button", { exact: true, name: "确认排期发布" })
        .click();

      const session = await browserSession(page);
      const base = `/console/tenants/${session.tenantId}/enterprises/${session.enterpriseId}`;
      const headers = { authorization: `Bearer ${session.adminToken}` };
      await expect
        .poll(
          async () => {
            const response = await page.request.get(
              `${API_BASE_URL}${base}/campaigns/${campaignId}`,
              { headers },
            );
            const detail = (await response.json()) as {
              distributionTasks: Array<{ status: string }>;
            };
            return detail.distributionTasks[0]?.status ?? "MISSING";
          },
          { intervals: [1_000, 2_000, 5_000], timeout: 45_000 },
        )
        .toBe("EXPIRED");

      await page.goto("/console/analytics");
      await page.getByRole("tab", { name: /未完成员工/u }).click();
      const incomplete = page.locator(".incompleteList > div").filter({ hasText: title });
      await expect(incomplete).toBeVisible();
      await incomplete.getByRole("button", { name: "逾期核实" }).click();
      await page
        .getByLabel("小红书发布链接或分享文本")
        .fill(`https://www.xiaohongshu.com/explore/${marker}`);
      await page
        .getByLabel("纠正原因")
        .fill("员工已完成真实发布但逾期补交链接，运营人员发起补充验真");
      await page.getByRole("button", { name: "提交逾期验真" }).click();
      await expect(page.getByText(/逾期发布已提交验真/u)).toBeVisible();

      await page.goto("/console/publications");
      const lateReview = page.locator(".reviewQueue > article").filter({ hasText: marker });
      await expect(lateReview).toBeVisible();
      await lateReview.getByLabel("复核或重试依据").fill("运营已核对逾期公开图文与专属内容一致");
      await lateReview.getByRole("button", { name: "核实有效" }).click();
      await expect(page.getByText("该发布已核实为有效", { exact: true })).toBeVisible();

      const corrected = await page.request.get(`${API_BASE_URL}${base}/campaigns/${campaignId}`, {
        headers,
      });
      const correctedDetail = (await corrected.json()) as {
        distributionTasks: Array<{ status: string }>;
      };
      expect(correctedDetail.distributionTasks[0]?.status).toBe("LATE_CORRECTED");

      await page.goto("/console/analytics");
      await expect(page.locator(".metricCard").filter({ hasText: "有效发布" })).toContainText(
        /逾期纠正\s+[1-9]\d*/u,
      );
      await page.getByRole("tab", { name: /未完成员工/u }).click();
      await expect(page.locator(".incompleteList > div").filter({ hasText: title })).toHaveCount(0);
    });

    test("the legacy publication settings entry opens the readback control plane", async ({
      page,
    }) => {
      await page.goto("/platform/settings/publication");
      await expect(page).toHaveURL(/\/platform\/readback$/u);
      const initialize = page.getByRole("button", { name: "初始化本机演示数据" });
      await expect(
        page.getByRole("heading", { level: 1, name: "发布复核与回读" }).or(initialize),
      ).toBeVisible();
      if (await initialize.isVisible()) await initialize.click();
      await expect(page.getByRole("heading", { level: 1, name: "发布复核与回读" })).toBeVisible();
    });

    test("task center and production gates occupy separate platform menus", async ({ page }) => {
      await page.goto("/platform/operations");
      const initialize = page.getByRole("button", { name: "初始化本机演示数据" });
      await expect(
        page.getByRole("heading", { level: 1, name: "任务中心" }).or(initialize),
      ).toBeVisible();
      if (await initialize.isVisible()) await initialize.click();
      await expect(page.getByRole("heading", { level: 1, name: "任务中心" })).toBeVisible();
      await expect(page.locator('.appNav a[href="/platform/operations"]')).toContainText(
        "任务中心",
      );
      await expect(page.locator(".productionReadinessList > article")).toHaveCount(0);
      await page.locator('.appNav a[href="/platform/gates"]').click();
      await expect(page).toHaveURL(/\/platform\/gates$/u);
      await expect(page.getByRole("heading", { level: 1, name: "门禁状态" })).toBeVisible();
      await expect(page.locator(".productionReadinessList > article")).toHaveCount(13);
      await expect(page.getByText("P-014 真实样本证据", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "刷新门禁" }).click();
      await expect(page.locator(".productionReadinessList > article")).toHaveCount(13);

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("heading", { level: 1, name: "门禁状态" })).toBeVisible();
      expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
      await page.getByRole("link", { name: "任务中心" }).last().click();
      await page.getByRole("button", { name: "失败", exact: true }).click();
      await expect(page.getByRole("button", { name: "失败", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    test("campaign wizard freezes a department audience", async ({ page }) => {
      await page.goto("/console/campaigns/new");
      await expect(page.getByRole("heading", { level: 1, name: "创建营销活动" })).toBeVisible();
      const departmentId = await prepareDepartmentAudience(page);
      const title = `E2E 部门活动 ${Date.now()}`;
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "创建营销活动" })).toBeVisible();
      await page.getByRole("button", { name: /活动内容/u }).click();
      await page.getByLabel("活动名称").fill(title);
      await page.getByRole("button", { name: "下一步" }).click();
      await page.getByRole("button", { name: /按部门/u }).click();
      await page.getByLabel("部门").selectOption(departmentId);
      await page.getByRole("button", { name: "下一步" }).click();
      await page.getByRole("button", { name: "下一步" }).click();
      await expect(page.getByRole("button", { name: "生成 2 份独立图文" })).toBeEnabled();
      await page.getByRole("button", { name: "生成 2 份独立图文" }).click();

      await expect(page).toHaveURL(/\/console\/campaigns\/[0-9a-f-]+$/u, { timeout: 30_000 });
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(
        page.locator(".metricCard").filter({ hasText: "目标成员" }).getByText("2", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".workItemTable tbody tr")).toHaveCount(2);
    });

    test("campaign wizard freezes an explicitly selected employee", async ({ page }) => {
      const title = `E2E 指定员工 ${Date.now()}`;
      await page.goto("/console/campaigns/new");
      await page.getByRole("button", { name: /活动内容/u }).click();
      await page.getByLabel("活动名称").fill(title);
      await page.getByRole("button", { name: "下一步" }).click();
      await page.getByRole("button", { name: /指定员工/u }).click();
      await page
        .locator(".audienceMemberPicker label")
        .filter({ hasText: "林晓" })
        .getByRole("checkbox")
        .check();
      await page.getByRole("button", { name: "下一步" }).click();
      await page.getByRole("button", { name: "下一步" }).click();
      await expect(page.getByRole("button", { name: "生成 1 份独立图文" })).toBeEnabled();
      await page.getByRole("button", { name: "生成 1 份独立图文" }).click();

      await expect(page).toHaveURL(/\/console\/campaigns\/[0-9a-f-]+$/u, { timeout: 30_000 });
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(
        page.locator(".metricCard").filter({ hasText: "目标成员" }).getByText("1", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".workItemTable tbody tr")).toHaveCount(1);
    });

    test("campaign wizard blocks submission when no authorized material is effective", async ({
      page,
    }) => {
      await mockWorkspace(page, (workspace) => ({
        ...workspace,
        campaignReady: false,
        counts: { ...workspace.counts, effectiveMaterials: 0 },
        nextAction: {
          code: "ADD_MATERIAL",
          description: "系统需要至少一份生效授权素材。",
          href: "/console/materials",
          title: "建立首份授权素材",
        },
        steps: workspace.steps.map((step) =>
          step.code === "MATERIALS" ? { ...step, current: 0, status: "BLOCKING" as const } : step,
        ),
      }));
      await page.goto("/console/campaigns/new");
      await page.getByRole("button", { name: /活动内容/u }).click();
      await page.getByRole("button", { name: "下一步" }).click();
      await page.getByRole("button", { name: "下一步" }).click();

      await expect(page.getByText("当前企业尚未满足活动前置条件。")).toBeVisible();
      await expect(page.getByRole("link", { name: "建立首份授权素材" })).toBeVisible();
      await expect(page.getByText("当前可用 0 份生效素材")).toBeVisible();
      await page.getByRole("button", { name: "下一步" }).click();
      await expect(page.getByRole("button", { name: "生成 3 份独立图文" })).toBeDisabled();
      await expect(page.getByText("请先完成必要准备项", { exact: true })).toBeVisible();
    });
  });

type BrowserSession = Readonly<{
  adminToken: string;
  enterpriseId: string;
  platformToken: string;
  tenantId: string;
}>;

type Workspace = Readonly<{
  campaignReady: boolean;
  counts: Record<string, number>;
  nextAction: Readonly<{ code: string; description: string; href: string; title: string }>;

  steps: ReadonlyArray<
    Readonly<{
      code: string;
      current: number;
      required: number;
      status: "BLOCKING" | "COMPLETE" | "RECOMMENDED";
      [key: string]: unknown;
    }>
  >;
  [key: string]: unknown;
}>;

async function prepareDepartmentAudience(page: Page): Promise<string> {
  const session = await browserSession(page);
  const base = `/console/tenants/${session.tenantId}/enterprises/${session.enterpriseId}`;
  const headers = { authorization: `Bearer ${session.adminToken}` };
  let departments = (await (
    await page.request.get(`${API_BASE_URL}${base}/departments`, { headers })
  ).json()) as Array<{
    code: string;
    id: string;
  }>;
  let department = departments.find(({ code }) => code === "E2E_OPS");
  if (!department) {
    const response = await page.request.post(`${API_BASE_URL}${base}/departments`, {
      data: { code: "E2E_OPS", name: "E2E 运营部" },
      headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    });
    expect(response.ok()).toBe(true);
    department = (await response.json()) as { code: string; id: string };
    departments = [...departments, department];
  }
  const imported = await page.request.post(`${API_BASE_URL}${base}/memberships/import`, {
    data: {
      members: [
        {
          departmentCode: "E2E_OPS",
          employeeNo: "DEMO-1",
          name: "林晓",
          phone: "13600000001",
        },
        {
          departmentCode: "E2E_OPS",
          employeeNo: "DEMO-2",
          name: "陈雨",
          phone: "13600000002",
        },
        { employeeNo: "DEMO-3", name: "周宁", phone: "13600000003" },
      ],
    },
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
  });
  expect(imported.ok()).toBe(true);
  return department.id;
}

async function mockWorkspace(
  page: Page,
  transform: (workspace: Workspace) => Workspace,
): Promise<void> {
  await page.route("**/console/tenants/*/enterprises/*/workspace", async (route) => {
    const response = await route.fetch();
    const workspace = (await response.json()) as Workspace;
    await route.fulfill({ response, json: transform(workspace) });
  });
}

async function browserSession(page: Page): Promise<BrowserSession> {
  const session = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("xhs-agentic:mvp-session:v1") ?? "null"),
  );
  if (
    !session?.adminToken ||
    !session?.platformToken ||
    !session?.tenantId ||
    !session?.enterpriseId
  ) {
    throw new Error("Expected an initialized SaaS browser session");
  }
  return session as BrowserSession;
}

function localDateTime(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}
