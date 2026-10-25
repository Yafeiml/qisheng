import { expect, type Page, test } from "@playwright/test";

async function reviewFixture(page: Page, canApprove = true) {
  await page.addInitScript(() =>
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
    ),
  );
  await page.route(/:3100\//u, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked regeneration fixture request" } }),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "isolated-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/account", (route) =>
    route.fulfill({
      json: {
        name: "审核管理员",
        email: "review@example.test",
        emailVerifiedAt: new Date().toISOString(),
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
            tenant: { id: "tenant", name: "测试集团", customerType: "GROUP" },
            inheritedEnterprises: [{ id: "enterprise", name: "测试企业" }],
            permissions: canApprove
              ? ["campaign.read", "campaign.manage", "campaign.approve"]
              : ["campaign.read"],
          },
        ],
      },
    }),
  );
  await page.route("**/generation-status", (route) =>
    route.fulfill({ json: { affectedEnterpriseCount: 0, notices: [] } }),
  );
  const snapshot = {
    id: "snapshot",
    membershipId: "member",
    employeeName: "王亚飞",
    employeePhone: "13800000001",
    departmentName: "信息科",
  };
  const workItem = { id: "work", membershipId: "member", status: "SUCCEEDED" };
  const assessment = {
    passed: true,
    warnings: [] as string[],
    replacedBlocks: [] as string[],
    notices: [] as string[],
    unresolvedBlocks: [] as string[],
    reviewDisposition: null as Record<string, unknown> | null,
  };
  const campaign = {
    selectionSnapshot: undefined as Record<string, unknown> | undefined,
    id: "review",
    title: "规范介绍全飞秒技术",
    prompt: "对林院长进行全飞秒技术的推广",
    status: "REVIEW_PENDING",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    visibleAt: new Date(Date.now() + 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 172800000).toISOString(),
    audienceCount: 1,
    generatedCount: 1,
    imageCount: 1,
    audienceSnapshots: [snapshot],
    distributionTasks: [],
    retrievalEvidence: [],
    blueprint: null,
    generationRuns: [
      {
        id: "run",
        status: "SUCCEEDED",
        createdAt: new Date().toISOString(),
        completedCount: 1,
        failedCount: 0,
        requestedCount: 1,
        workItems: [workItem],
      },
    ],
    employeeContents: [
      {
        id: "content",
        membershipId: "member",
        audienceSnapshot: snapshot,
        title: "全飞秒怎么挑？先把关注力放在医生",
        body: "了解技术特点，结合完整的术前检查与个体情况，由专业医生进行评估。",
        hashtags: ["全飞秒科普"],
        status: "GENERATED",
        revision: 1,
        revisions: [],
        riskAssessment: assessment,
        images: [
          {
            id: "image",
            width: 300,
            height: 400,
            imageUrl: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#d7e6f2"/><text x="20" y="90" font-size="25">全飞秒科普海报</text></svg>')}`,
          },
        ],
      },
    ],
  };
  const writes: { feedback?: string; reasonCode?: string; target: string }[] = [];
  const manualChecks: { reason: string }[] = [];
  let failNext = false;
  await page.route(
    "**/console/tenants/tenant/enterprises/enterprise/campaigns/review**",
    (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/timeline")) return route.fulfill({ json: { events: [] } });
      if (url.pathname.endsWith("/work-items"))
        return route.fulfill({
          json: { items: [], pageInfo: { hasNextPage: false, nextCursor: null } },
        });
      if (url.pathname.endsWith("/regenerate")) {
        writes.push(route.request().postDataJSON());
        if (failNext) {
          failNext = false;
          return route.fulfill({
            status: 409,
            json: {
              code: "MODEL_CAPACITY_UNAVAILABLE",
              message: "生成服务暂不可用，本次未开始生成",
            },
          });
        }
        campaign.status = "GENERATING";
        workItem.status = "QUEUED";
        return route.fulfill({ json: campaign });
      }
      if (url.pathname.endsWith("/accept-review")) {
        const body = route.request().postDataJSON() as { reason: string };
        manualChecks.push(body);
        assessment.passed = true;
        assessment.reviewDisposition = { type: "WARNING_ACCEPTED", reason: body.reason };
        const content = campaign.employeeContents.at(0);
        if (content) content.status = "GENERATED";
        return route.fulfill({ json: campaign });
      }
      return route.fulfill({ json: campaign });
    },
  );
  return {
    campaign,
    workItem,
    assessment,
    manualChecks,
    block: (warnings: string[], blocks: string[] = []) => {
      assessment.passed = false;
      assessment.warnings = warnings;
      assessment.unresolvedBlocks = blocks;
      const content = campaign.employeeContents.at(0);
      if (content) content.status = "REVIEW_BLOCKED";
    },
    writes,
    fail: () => {
      failNext = true;
    },
  };
}

for (const width of [1440, 390]) {
  test(`campaign cancellation previews task impact and preserves the reason at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const fixture = await reviewFixture(page);
    const requests: { reason: string }[] = [];
    await page.route("**/campaigns/review/cancel-preview", (route) =>
      route.fulfill({
        json: {
          cancelledDistributionTasks: 2,
          cancelledGenerationRuns: 1,
          cancelledWorkItems: 3,
        },
      }),
    );
    await page.route("**/campaigns/review/cancel", (route) => {
      const input = route.request().postDataJSON() as { reason: string };
      requests.push(input);
      Object.assign(fixture.campaign, {
        status: "CANCELLED",
        cancellationReason: input.reason,
        cancelledAt: new Date().toISOString(),
        cancellationSummary: {
          cancelledDistributionTasks: 2,
          cancelledGenerationRuns: 1,
          cancelledWorkItems: 3,
        },
      });
      return route.fulfill({ json: fixture.campaign });
    });
    await page.goto("/console/campaigns/review");
    await page.getByRole("button", { name: "取消活动", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("停止 2 个员工任务、1 个生成任务和 3 个生成工作项");
    await expect(dialog).not.toContainText(/点数|钱包|余额/u);
    await expect(dialog.locator("textarea, select")).toHaveCount(0);
    const confirm = dialog.getByRole("button", { name: "确认取消", exact: true });
    await expect(confirm).toBeEnabled();
    await confirm.hover();
    await confirm.focus();
    await expect(confirm).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await dialog.screenshot({ path: testInfo.outputPath(`campaign-cancellation-${width}.png`) });
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: "活动已取消", exact: true })).toBeVisible();
    await expect(page.getByText("本期活动停止执行", { exact: true })).toBeVisible();
    expect(requests).toEqual([{ reason: "本期活动停止执行" }]);
  });

  test(`GEO and verified transaction snapshots stay separate at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await reviewFixture(page);
    const rows: Record<string, unknown>[] = [];
    const writes: Record<string, unknown>[] = [];
    await page.route("**/campaigns/review/effect-observations", (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        writes.push(body);
        const payload = body.payload;
        const row = {
          ...body,
          id: `observation-${rows.length}`,
          createdAt: new Date().toISOString(),
          metrics:
            body.kind === "TRANSACTION" && payload.dataStatus === "VERIFIED"
              ? {
                  netReceivedMinor: payload.receivedMinor - payload.refundMinor,
                  costPerTransactionMinor: payload.transactionPeople
                    ? payload.costMinor / payload.transactionPeople
                    : null,
                  transactionRate: payload.leadCount
                    ? payload.transactionPeople / payload.leadCount
                    : null,
                  windowComplete: false,
                }
              : null,
        };
        rows.push(row);
        return route.fulfill({ json: row });
      }
      return route.fulfill({ json: { items: rows } });
    });
    await page.goto("/console/campaigns/review");
    await page.getByRole("tab", { name: "GEO 与成交", exact: true }).click();
    const panel = page.getByRole("region", { name: "GEO 与成交结果" });
    await expect(panel).toContainText("结果未知");
    await panel.getByRole("button", { name: "录入观察", exact: true }).click();
    let drawer = page.getByRole("dialog", { name: "录入 GEO 或成交观察" });
    await drawer.getByLabel("实际查询或问题").fill("第一次了解眼部检查需要确认什么");
    await drawer.getByLabel("实际产品或入口").fill("点点");
    await drawer.getByLabel("观察方式").selectOption("AI");
    await drawer.getByLabel("目标品牌是否正确出现").selectOption("YES");
    await drawer
      .getByLabel("实际引用的具体内容 URL（可空）")
      .fill("https://www.xiaohongshu.com/explore/verified-source");
    await drawer
      .getByLabel("来源与企业复核依据")
      .fill("企业核验观察记录：实际入口与条件，未运行真实查询");
    await drawer.screenshot({ path: testInfo.outputPath(`geo-observation-${width}.png`) });
    await drawer.getByRole("button", { name: "保存观察快照" }).click();
    await expect(panel).toContainText("点点 · AI 回答");
    await panel.getByRole("button", { name: "录入观察", exact: true }).click();
    drawer = page.getByRole("dialog", { name: "录入 GEO 或成交观察" });
    await drawer.getByRole("tab", { name: "成交快照", exact: true }).click();
    await drawer.getByLabel("同批线索统计开始").fill("2026-10-01T00:00");
    await drawer.getByLabel("同批线索统计结束").fill("2026-10-12T23:59");
    await drawer.getByLabel("成交转化观察截止").fill("2027-01-01T00:00");
    await drawer.getByLabel("数据核实状态").selectOption("VERIFIED");
    await drawer.getByLabel("同范围去重有效线索人数").fill("12");
    await drawer.getByLabel("咨询人数（过程）").fill("11");
    await drawer.getByLabel("核实成交人数").fill("2");
    await drawer.getByLabel("成交订单数").fill("3");
    await drawer.getByLabel("实收金额（元）").fill("18000.25");
    await drawer.getByLabel("退款金额（元）").fill("1000.10");
    await drawer.getByLabel("同范围成本（元）").fill("600.50");
    await drawer
      .getByLabel("来源与企业复核依据")
      .fill("企业聚合业务记录，按同批去重交易人数核验，无患者个人资料");
    await drawer.screenshot({ path: testInfo.outputPath(`transaction-observation-${width}.png`) });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await drawer.getByRole("button", { name: "保存观察快照" }).click();
    expect(writes[0]).toMatchObject({ kind: "GEO", payload: { surface: "AI", brandSeen: true } });
    expect(writes[1]).toMatchObject({
      kind: "TRANSACTION",
      payload: {
        leadCount: 12,
        consultationCount: 11,
        transactionPeople: 2,
        orderCount: 3,
        receivedMinor: 1800025,
        refundMinor: 100010,
        costMinor: 60050,
      },
    });
    await expect(panel).toContainText("17,000.15");
    await expect(panel).toContainText("观察中 / 窗口未结束");
    await expect(panel).toContainText("11 / 未知 / 未知");
    await expect(panel).toContainText("历史记录不会相加");
    await panel.screenshot({ path: testInfo.outputPath(`effect-history-${width}.png`) });
    await panel.getByRole("button", { name: "录入观察", exact: true }).click();
    drawer = page.getByRole("dialog", { name: "录入 GEO 或成交观察" });
    await drawer.getByLabel("数据核实状态").selectOption("UNKNOWN");
    await drawer.getByRole("button", { name: "保存观察快照" }).click();
    expect(writes[2]).toMatchObject({
      kind: "TRANSACTION",
      payload: {
        dataStatus: "UNKNOWN",
        leadCount: null,
        transactionPeople: null,
        orderCount: null,
        receivedMinor: null,
        refundMinor: null,
        costMinor: null,
      },
    });
  });

  test(`medical regeneration selects a fixed reason without a prompt at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const fixture = await reviewFixture(page);
    fixture.campaign.selectionSnapshot = {
      schemaVersion: "medical-selection-v1",
      objective: "GEO_AND_TRANSACTION",
    };
    await page.goto("/console/campaigns/review");
    await page.getByRole("tab", { name: "内容审核", exact: true }).click();
    await page.getByRole("button", { name: "重生成文案", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    const reasons = dialog.getByRole("combobox", { name: "重新生成的原因" });
    await expect(reasons).toHaveCSS("appearance", "none");
    await reasons.focus();
    await expect(reasons).toBeFocused();
    await reasons.selectOption("TOO_MUCH_INFORMATION");
    await dialog.screenshot({ path: testInfo.outputPath(`medical-regenerate-${width}.png`) });
    await dialog.getByRole("button", { name: "确认重生成文案" }).click();
    expect(fixture.writes).toEqual([{ target: "COPY", reasonCode: "TOO_MUCH_INFORMATION" }]);
  });

  test(`incomplete automatic review offers clear manual choices at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const fixture = await reviewFixture(page);
    fixture.block(["REVIEW_UNAVAILABLE: 本次整体审核未完成，请人工确认；未自动重复生成或审核。"]);
    await page.goto("/console/campaigns/review");
    await page.getByRole("tab", { name: "内容审核", exact: true }).click();
    const explanation = page.getByRole("region", { name: "自动审核说明" });
    await expect(explanation).toContainText("当前还没有自动审核结论");
    await expect(explanation).toContainText("无法判断时，先保留待审核");
    await expect(page.getByText(/REVIEW_UNAVAILABLE/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "带原因接受警告" })).toHaveCount(0);
    const confirm = page.getByRole("button", { name: "人工确认可用", exact: true });
    const keep = page.getByRole("button", { name: "暂时保留待审核", exact: true });
    await page.keyboard.press("Tab");
    await confirm.focus();
    await expect(confirm).toHaveCSS("outline-style", "solid");
    const buttons = await Promise.all([confirm.boundingBox(), keep.boundingBox()]);
    expect(buttons.every((button) => button && button.height >= 40)).toBe(true);
    if (width === 390) expect(buttons[0]?.width).toBeCloseTo(buttons[1]?.width ?? 0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page
      .locator(".reviewCopy")
      .screenshot({ path: testInfo.outputPath(`incomplete-review-${width}.png`) });
    await keep.click();
    await expect(page.getByRole("tab", { name: "概览与下一步" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(fixture.assessment.passed).toBe(false);
    expect(fixture.manualChecks).toHaveLength(0);
    expect(fixture.writes).toHaveLength(0);
    await page.getByRole("tab", { name: "内容审核", exact: true }).click();
    await confirm.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("不会重新生成");
    await expect(dialog).toContainText("活动仍需完成整体审核");
    const submit = dialog.getByRole("button", { name: "确认人工检查通过" });
    await expect(submit).toBeDisabled();
    const reason = "已核对人物身份、引用资料和文案事实，未发现夸大表述";
    await dialog.getByRole("textbox").fill(reason);
    if (width === 390)
      await page.screenshot({ path: testInfo.outputPath("manual-confirm-390.png") });
    await submit.click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText("已人工确认可用", { exact: true })).toBeVisible();
    await expect(page.getByText("自动检查通过", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "人工确认可用", exact: true })).toHaveCount(0);
    expect(fixture.manualChecks).toEqual([{ reason }]);
    expect(fixture.writes).toHaveLength(0);
  });

  test(`review regeneration targets and layout at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const fixture = await reviewFixture(page);
    await page.goto("/console/campaigns/review");
    await page.getByRole("tab", { name: "内容审核", exact: true }).click();
    const toolbar = page.getByRole("region", { name: "重生成当前员工内容" });
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toContainText("旧版本保留");
    const buttons = toolbar.getByRole("button");
    await expect(buttons).toHaveCount(3);
    const box = await toolbar.boundingBox();
    const preview = await page.locator(".reviewPreview").boundingBox();
    expect(box && preview && box.y + box.height <= preview.y).toBeTruthy();
    await page.keyboard.press("Tab");
    for (const button of await buttons.all()) {
      await expect(button).toHaveCSS("min-height", "38px");
      await button.focus();
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS("outline-style", "solid");
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`review-actions-${width}.png`),
      fullPage: true,
    });

    await toolbar.getByRole("button", { name: "重生成图片", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "返回检查" }).click();
    expect(fixture.writes).toHaveLength(0);
    for (const [target, label] of [
      ["COPY", "文案"],
      ["IMAGE", "图片"],
      ["BOTH", "图文"],
    ]) {
      await toolbar.getByRole("button", { name: `重生成${label}`, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("保留原稿历史，为该员工重新生成当前选择的内容");
      await expect(dialog).toContainText("旧版本完整保留，新版本仍需审核后才能向员工开放");
      if (target !== "BOTH")
        await expect(dialog).toContainText(target === "COPY" ? "保留现有图片" : "保留现有文案");
      const confirm = dialog.getByRole("button", { name: `确认重生成${label}` });
      await expect(confirm).toBeDisabled();
      await dialog.getByRole("textbox").fill("太短");
      await expect(confirm).toBeDisabled();
      await dialog.getByRole("textbox").fill(`${label}补充关键信息并保持简洁`);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      if (target === "COPY")
        await page.screenshot({
          path: testInfo.outputPath(`review-confirm-${width}.png`),
          fullPage: true,
        });
      await confirm.click();
      await expect(dialog).not.toBeVisible();
      expect(fixture.writes.at(-1)).toEqual({ target, feedback: `${label}补充关键信息并保持简洁` });
      await expect(
        page.getByText("正在生成新版本，以下为上次内容；完成后请重新审核。"),
      ).toBeVisible();
      await expect(toolbar).not.toBeVisible();
      fixture.campaign.status = "REVIEW_PENDING";
      fixture.workItem.status = "SUCCEEDED";
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      await expect(toolbar).toBeVisible();
    }
    expect(fixture.writes.map(({ target }) => target)).toEqual(["COPY", "IMAGE", "BOTH"]);
    fixture.fail();
    await toolbar.getByRole("button", { name: "重生成文案", exact: true }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("请精简文案内容");
    await page.getByRole("dialog").getByRole("button", { name: "确认重生成文案" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "生成服务暂不可用" })).toBeVisible();
    await expect(toolbar).toBeVisible();
  });
}

test("a blocked finding cannot be accepted while the automatic review is unavailable", async ({
  page,
}) => {
  const fixture = await reviewFixture(page);
  fixture.block(
    ["REVIEW_UNAVAILABLE: 自动审核未完成", "MEDICAL_CLAIM: 请核对是否存在效果承诺"],
    ["BLOCKED: 请修改不准确的表述"],
  );
  await page.goto("/console/campaigns/review");
  await page.getByRole("tab", { name: "内容审核", exact: true }).click();
  await expect(page.getByText("内容需要修改", { exact: true })).toBeVisible();
  await expect(page.getByText("请修改不准确的表述", { exact: true })).toBeVisible();
  await expect(page.getByText(/MEDICAL_CLAIM|REVIEW_UNAVAILABLE|BLOCKED:/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "人工确认可用", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "暂时保留待审核", exact: true })).toBeEnabled();
  expect(fixture.manualChecks).toHaveLength(0);
});

test("review regeneration is unavailable to read-only users", async ({ page }) => {
  const fixture = await reviewFixture(page, false);
  fixture.block(["REVIEW_UNAVAILABLE: 自动审核未完成"]);
  await page.goto("/console/campaigns/review");
  await page.getByRole("tab", { name: "内容审核", exact: true }).click();
  await expect(page.getByRole("region", { name: "重生成当前员工内容" })).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "全飞秒怎么挑？先把关注力放在医生" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "自动审核说明" })).toContainText(
    "请由负责审核的同事",
  );
  await expect(page.getByRole("button", { name: "人工确认可用", exact: true })).toHaveCount(0);
});

test("approved content must return to review before regeneration", async ({ page }) => {
  const fixture = await reviewFixture(page);
  fixture.campaign.status = "APPROVED";
  await page.goto("/console/campaigns/review");
  await page.getByRole("tab", { name: "内容审核", exact: true }).click();
  await expect(page.getByRole("region", { name: "重生成当前员工内容" })).not.toBeVisible();
  expect(fixture.writes).toHaveLength(0);
});
