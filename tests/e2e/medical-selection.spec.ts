import { expect, type Page, test } from "@playwright/test";
import {
  type MedicalOptions,
  newMedicalSelection,
} from "../../apps/admin-web/app/lib/medical-selection";
import { defaultGenerationStyles } from "../../packages/ai-gateway/src/generation-style";

const medicalOptions: MedicalOptions = {
  enabled: true,
  objective: "GEO_AND_TRANSACTION",
  priorities: ["GEO_ACCUMULATION", "TRANSACTION", "BALANCED"],
  readerSituations: [
    "FIRST_UNDERSTANDING",
    "LONG_CONSIDERATION",
    "TIME_PLANNING",
    "BUDGET_QUESTIONS",
    "WORK_OBSERVATION",
    "LIFE_INCONVENIENCE",
  ],
  noteForms: ["QUESTION_LIST", "PREPARATION", "WORK_RECORD", "PERSONAL_RECORD", "SERVICE_INFO"],
  imageModes: ["ORIGINAL_EDIT", "QUESTION_CARD", "ILLUSTRATION"],
  conversionPaths: ["NONE", "OFFICIAL_PROFILE", "PLATFORM_CONSULTATION"],
  topics: [
    {
      id: "topic-1",
      question: "第一次了解眼部检查，需要提前确认什么？",
      intent: "prepare",
      entityId: null,
      entityName: null,
    },
    {
      id: "topic-2",
      question: "异地到院时，应向官方核对哪些时间安排？",
      intent: "schedule",
      entityId: null,
      entityName: null,
    },
  ],
  disabledNoteForms: [{ value: "PERSONAL_RECORD", reason: "尚未建立本人经历与素材归属证据" }],
  approvedAdAssets: { enabled: false, reason: "缺少已审成品及冻结样件，暂不可分发" },
  enterprise: { name: "测试眼科企业", brandName: "眼科品牌", city: "郑州" },
};

async function fixture(page: Page, medical = true) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const styles = defaultGenerationStyles();
  let labRun: Record<string, unknown> | null = null;
  await page.addInitScript(() =>
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
    ),
  );
  // All business calls are fixtures; this suite never creates paid jobs or writes real memberships.
  await page.route(/:3100\//u, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const post = request.method() === "POST";
    if (post) writes.push({ path, body: request.postDataJSON() ?? {} });
    let json: unknown;
    if (path === "/auth/admin/refresh")
      json = { accessToken: "fixture-token", expiresInSeconds: 3600 };
    else if (path === "/auth/admin/account")
      json = {
        name: "方案验收管理员",
        email: "fixture@example.test",
        emailVerifiedAt: "2026-10-13T00:00:00Z",
      };
    else if (path === "/auth/admin/session")
      json = {
        userId: "fixture-admin",
        phone: "13800000000",
        features: {},
        scopes: [
          {
            scopeType: "PLATFORM",
            permissions: ["platform.model.manage", "platform.settings.manage"],
          },
          {
            scopeType: "ENTERPRISE",
            role: { code: "ENTERPRISE_ADMIN", name: "企业管理员" },
            tenant: { id: "tenant", name: "测试集团" },
            enterprise: { id: "enterprise", name: "测试企业", tenantId: "tenant" },
            permissions: [
              "campaign.read",
              "campaign.manage",
              "campaign.approve",
              "material.manage",
              "enterprise.membership.read",
              "enterprise.membership.manage",
              "enterprise.membership.participation.manage",
            ],
          },
        ],
      };
    else if (path.endsWith("/generation-status"))
      json = { affectedEnterpriseCount: 0, notices: [] };
    else if (path.endsWith("/medical-options"))
      json = {
        ...medicalOptions,
        enabled: medical,
        members: [{ id: "employee", name: "拟发布员工", publisherContext: null }],
      };
    else if (path.endsWith("/workspace"))
      json = {
        steps: [],

        counts: { effectiveMaterials: 1 },
        capabilities: { imagesPerDistribution: 2 },
      };
    else if (path.endsWith("/memberships"))
      json = {
        items: [
          {
            id: "employee",
            name: "企业员工",
            phone: "13800000001",
            status: "ACTIVE",
            seatStatus: "ENABLED",
            directoryManaged: false,
          },
        ],
        pageInfo: { nextCursor: null, hasNextPage: false, totalCount: 1 },
      };
    else if (path.endsWith("/departments") || path.endsWith("/memberships/import-batches"))
      json = [];
    else if (path.endsWith("/personnel-policy"))
      json = { allowEnterpriseParticipationManagement: true };
    else if (path.endsWith("/publisher-context"))
      json = { id: "employee", publisherContext: request.postDataJSON() };
    else if (path.endsWith("/materials"))
      json = [
        {
          id: "material",
          title: "已核准必要流程",
          status: "ACTIVE",
          authorizationStatus: "AUTHORIZED",
          ingestionStatus: "READY",
          type: "TEXT",
          tags: [],
          effectiveVersion: { version: 1 },
        },
      ];
    else if (path.endsWith("/campaign-planning/generation-styles"))
      json = { ...styles, version: 1 };
    else if (path.endsWith("/campaign-planning/prompt-templates")) json = [];
    else if (path.endsWith("/campaign-planning/campaign-templates"))
      json = post
        ? {
            ...request.postDataJSON(),
            selectionSnapshot: request.postDataJSON().selection,
            id: "saved",
            status: "ACTIVE",
          }
        : [
            {
              id: "legacy",
              name: "旧版医疗宣传模板",
              title: "旧活动",
              prompt: "宣传专家设备",
              selectionSnapshot: newMedicalSelection(),
              imageCount: 1,
              reminderOffsetsHours: [6],
              status: "ACTIVE",
            },
          ];
    else if (path.endsWith("/campaign-planning/draft")) json = { draft: null };
    else if (path.endsWith("/copy-input"))
      json = {
        title: "历史活动",
        prompt: "医院医生设备推荐",
        selectionSnapshot: newMedicalSelection(),
        visibleAt: new Date(Date.now() + 36_000_000).toISOString(),
        imageCount: 1,
        audienceMode: "ALL",
        membershipIds: [],
        reminderOffsetsHours: [6],
      };
    else if (path.endsWith("/preflight")) {
      const input = request.postDataJSON();
      if (
        input.selection?.imageMode === "ORIGINAL_EDIT" &&
        (!input.referenceArtifactIds?.length || !input.selection.originalImageConfirmed)
      )
        return route.fulfill({ status: 409, json: { message: "请选择授权照片并确认隐私" } });
      json = {
        ready: true,
        checks: [],
        serviceStatus: "AVAILABLE",
        estimatedWaitLevel: "IMMEDIATE",
      };
    } else if (path.endsWith("/retrieval-preview"))
      json = {
        hits: [
          {
            chunkId: "chunk",
            materialTitle: "已核准必要流程",
            materialType: "TEXT",
            materialVersion: 1,
            snippet: "具体安排以官方有效资料为准",
          },
        ],
        images: [
          {
            artifactId: "original",
            materialId: "material",
            enterpriseId: "enterprise",
            fileName: "授权工作照片",
            usage: "REFERENCE",
            score: 1,
            description: "授权场景照片",
          },
        ],
      };
    else if (path.endsWith("/preview") && path.includes("/artifacts/"))
      json = {
        optimizedDataUrl: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#ddd"/></svg>')}`,
      };
    else if (path.endsWith("/campaigns") && post)
      return route.fulfill({ status: 503, json: { message: "已捕获选择请求，未创建真实活动" } });
    else if (path === "/platform/generation-lab/options")
      json = {
        enterprises: [{ id: "enterprise", name: "测试眼科企业", tenant: { name: "测试集团" } }],
        styles: { ...styles, version: 1 },
      };
    else if (path === "/platform/generation-lab") json = [];
    else if (path === "/platform/generation-lab/check") {
      const body = request.postDataJSON();
      labRun = {
        id: "test-run",
        title: body.title,
        enterpriseId: "enterprise",
        status: "DRAFT",
        action: "COPY",
        reviewStatus: "NONE",
        createdAt: "2026-10-13T00:00:00Z",
        parentId: null,
        error: null,
        assets: [],
        calls: [],
        result: null,
        review: null,
        input: {
          brief: body.brief,
          keywords: "",
          enterpriseName: "测试眼科企业",
          selectionSnapshot: body.selection,

          imageAssets: [],
          generationStyle: {
            configurationVersion: 1,
            copyBasePrompt: "",
            imageBasePrompt: "",
            contentDirection: styles.contentDirections[0],
            imageStyle: styles.imageStyles[0],
          },
          retrieval: { query: "问题", hits: [], images: [] },
          route: {
            text: { primary: { externalModelId: "fixture" } },
            image: { primary: { externalModelId: "fixture" } },
          },
        },
      };
      json = labRun;
    } else if (path === "/platform/generation-lab/test-run/execute") {
      json = {
        ...labRun,
        status: "SUCCEEDED",
        result: {
          copy: {
            title: "检查前需要确认什么",
            body: "准备问题，向官方核对。",
            hashtags: [],
            imagePrompt: "问题卡",
          },
        },
      };
    } else if (path === "/platform/branding") json = { name: "企声共创" };
    else return route.fulfill({ status: 404, json: { message: `Unmocked fixture: ${path}` } });
    return route.fulfill({ json });
  });
  return writes;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

for (const width of [1440, 390]) {
  test(`all industries use the generic campaign brief and preserve full width at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    const writes = await fixture(page);
    await page.goto("/console/campaigns/new");
    const name = page.getByLabel("活动名称", { exact: true });
    const brief = page.getByLabel("主题和传播目标", { exact: true });
    await expect(name).toHaveValue("");
    await expect(brief).toHaveValue("");
    await expect(page.getByRole("region", { name: "医疗活动内容选择" })).toHaveCount(0);
    await name.fill("秋季新品分享");
    await brief.fill("分享本季新品的日常使用场景和品牌特点，表达自然，信息以已授权资料为准。");
    const layout = await page.evaluate(() => {
      const wizard = document.querySelector("form.campaignWizard");
      const steps = document.querySelector(".campaignWizardSteps");
      const panel = document.querySelector(".campaignWizardStep:not([hidden])");
      const title = panel?.querySelector(".field input");
      const prompt = panel?.querySelector(".field textarea");
      if (!wizard || !steps || !panel || !title || !prompt) throw new Error("Missing generic form");
      return {
        width: wizard.getBoundingClientRect().width,
        stepsWidth: steps.getBoundingClientRect().width,
        panelWidth: panel.getBoundingClientRect().width,
        gap: prompt.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
      };
    });
    expect(Math.abs(layout.width - layout.stepsWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.width - layout.panelWidth)).toBeLessThanOrEqual(1);
    expect(layout.gap).toBeGreaterThanOrEqual(16);
    const templateSelect = page.getByRole("combobox", { name: "活动模板" });
    await expect(templateSelect).toHaveCSS("appearance", "none");
    await templateSelect.focus();
    await expect(templateSelect).toBeFocused();
    await page.getByRole("button", { name: "保存为活动模板", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "保存活动模板", exact: true });
    await drawer.getByLabel("模板名称").fill("新品分享模板");
    await drawer.getByRole("button", { name: "保存并立即使用" }).click();
    await expect(drawer).toHaveCount(0);
    for (let step = 0; step < 3; step++)
      await page.getByRole("button", { name: "下一步", exact: true }).click();
    const generate = page.getByRole("button", { name: "生成 1 份独立图文", exact: true });
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect(page.getByRole("alert").filter({ hasText: "已捕获选择请求" })).toBeVisible();
    const calls = writes.filter(({ path }) =>
      /preflight|retrieval-preview|campaign-templates|\/campaigns$/u.test(path),
    );
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const { body } of calls) {
      expect(body.prompt).toContain("本季新品");
      expect(body).not.toHaveProperty("selection");
    }
    expect(requested.some((url) => url.includes("medical-options"))).toBe(false);
    await noOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`generic-campaign-${width}.png`),
      fullPage: true,
    });
  });

  test(`new generation lab checks use generic styles for a medical enterprise at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    const writes = await fixture(page);
    await page.goto("/platform/generation-lab");
    await page.getByRole("combobox", { name: "测试企业" }).selectOption("enterprise");
    await page.getByLabel("测试名称", { exact: true }).fill("通用品牌测试");
    await page.getByLabel("活动需求", { exact: true }).fill("根据企业资料介绍品牌的日常服务场景");
    await expect(page.getByRole("combobox", { name: "内容方向" })).toBeEnabled();
    await expect(page.getByRole("combobox", { name: "图片风格" })).toBeEnabled();
    await expect(page.getByRole("region", { name: "医疗活动内容选择" })).toHaveCount(0);
    await page.getByRole("button", { name: "检查素材", exact: true }).click();
    await expect(page.getByText("03 / 提示词微调（仅本版本生效）")).toBeVisible();
    const checked = writes.find(({ path }) => path.endsWith("/check"))?.body;
    expect(checked).toMatchObject({
      brief: "根据企业资料介绍品牌的日常服务场景",
      enterpriseId: "enterprise",
    });
    expect(checked?.contentDirectionPresetId).toBeTruthy();
    expect(checked?.imageStylePresetId).toBeTruthy();
    expect(checked).not.toHaveProperty("selection");
    await noOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`generic-lab-${width}.png`),
      fullPage: true,
    });
  });
}

test("opening a medical draft preserves it until the user writes a new generic brief", async ({
  page,
}) => {
  const writes = await fixture(page);
  await page.route("**/campaign-planning/draft", async (route) => {
    if (route.request().method() === "POST") {
      writes.push({ path: "/campaign-planning/draft", body: route.request().postDataJSON() });
      return route.fulfill({ json: {} });
    }
    return route.fulfill({
      json: {
        draft: {
          step: 4,
          updatedAt: "2026-10-14T00:00:00Z",
          payload: {
            title: "旧问题活动",
            prompt: "内部医疗计划",
            selection: newMedicalSelection(),
          },
        },
      },
    });
  });
  await page.goto("/console/campaigns/new");
  const brief = page.getByLabel("主题和传播目标", { exact: true });
  await expect(brief).toHaveValue("");
  await expect(page.getByText(/已保留历史草稿设置/u)).toBeVisible();
  await page.waitForTimeout(1200);
  expect(writes.filter(({ path }) => path.endsWith("/draft"))).toHaveLength(0);
  await brief.fill("重新使用通用品牌生成方式组织本次内容");
  await expect.poll(() => writes.filter(({ path }) => path.endsWith("/draft")).length).toBe(1);
  const saved = writes.find(({ path }) => path.endsWith("/draft"))?.body;
  expect(saved?.prompt).toBe("重新使用通用品牌生成方式组织本次内容");
  expect(saved).not.toHaveProperty("selection");
});

test("copying historical medical activities and templates requires a new brief", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/console/campaigns/new?copyFrom=medical-history");
  await expect(page.getByLabel("主题和传播目标", { exact: true })).toHaveValue("");
  await expect(page.getByText(/已保留历史活动设置/u)).toBeVisible();
  await page.getByRole("combobox", { name: "活动模板" }).selectOption("legacy");
  await expect(page.getByLabel("主题和传播目标", { exact: true })).toHaveValue("");
  await expect(page.getByText(/已带入历史模板设置/u)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "活动模板" })).toHaveValue("");
});

test("a rejected historical medical copy still opens a usable generic form without replacing the saved draft", async ({
  page,
}) => {
  const writes = await fixture(page);
  await page.route("**/campaigns/medical-history/copy-input", (route) =>
    route.fulfill({ status: 409, json: { message: "历史医疗计划不能直接复制，请新建通用活动。" } }),
  );
  await page.route("**/campaign-planning/draft", (route) =>
    route.fulfill({
      json: {
        draft: {
          step: 1,
          updatedAt: "2026-10-14T00:00:00Z",
          payload: { title: "其他保留草稿", prompt: "原有传播目标不能被自动覆盖" },
        },
      },
    }),
  );
  await page.goto("/console/campaigns/new?copyFrom=medical-history");
  await expect(page.getByLabel("主题和传播目标", { exact: true })).toHaveValue("");
  await expect(
    page.getByText("历史医疗计划不能直接复制，请新建通用活动。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "内容方向", exact: true })).toBeEnabled();
  await page.waitForTimeout(1200);
  expect(writes.filter(({ path }) => path.endsWith("/draft"))).toHaveLength(0);
  await page.getByLabel("活动名称", { exact: true }).fill("通用新活动");
  await page.getByLabel("主题和传播目标", { exact: true }).fill("根据企业资料介绍日常产品体验");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "选择收到本期内容的员工", exact: true }),
  ).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`only existing publisher profiles offer historical maintenance at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    const writes = await fixture(page);
    await page.route(/\/memberships(?:\?.*)?$/u, (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: "employee",
              name: "通用员工",
              phone: "13800000001",
              status: "ACTIVE",
              seatStatus: "ENABLED",
              directoryManaged: false,
              smsNotificationStatus: null,
              publisherContext: null,
            },
            {
              id: "historical",
              name: "历史员工",
              phone: "13800000002",
              status: "ACTIVE",
              seatStatus: "ENABLED",
              directoryManaged: false,
              smsNotificationStatus: null,
              publisherContext: {
                schemaVersion: "medical-publisher-v1",
                category: "ORDINARY",
                authorId: "staff_old",
                role: "门店工作人员",
                evidence: "企业已核实的历史归属记录",
                validUntil: "2099-01-01T00:00:00Z",
              },
            },
          ],
          pageInfo: { nextCursor: null, hasNextPage: false, totalCount: 2 },
        },
      }),
    );
    await page.goto("/console/employees");
    await expect(page.getByRole("button", { name: "发布安排", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "历史发布安排", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "历史发布安排", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "维护历史发布安排", exact: true });
    await expect(drawer).toContainText("新活动使用通用生成方式");
    await expect(drawer.getByRole("combobox", { name: "实际发布条件", exact: true })).toHaveValue(
      "ORDINARY",
    );
    await drawer.getByLabel("真实岗位", { exact: true }).fill("门店接待工作人员");
    await expect(
      drawer.getByRole("checkbox", { name: "本次核实范围允许品牌归属表达", exact: true }),
    ).toBeDisabled();
    await expect(
      drawer.getByRole("checkbox", { name: "本次核实范围允许品牌归属表达", exact: true }),
    ).toHaveCSS("appearance", "none");
    const save = drawer.getByRole("button", { name: "确认并保存发布安排", exact: true });
    await save.scrollIntoViewIfNeeded();
    expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`historical-publisher-${width}.png`) });
    await save.click();
    await expect(drawer).toHaveCount(0);
    expect(writes.find(({ path }) => path.endsWith("/publisher-context"))?.body.role).toBe(
      "门店接待工作人员",
    );
  });
}
