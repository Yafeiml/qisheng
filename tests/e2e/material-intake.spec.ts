import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
    ),
  );
  await page.route(/:3100\//u, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked material fixture" } }),
  );
  await page.route("**/materials/options", (route) => route.fulfill({ json: { medical: false } }));
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "material-fixture-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/account", (route) =>
    route.fulfill({
      json: {
        name: "素材验收管理员",
        email: "fixture@example.test",
        emailVerifiedAt: "2026-10-14T00:00:00Z",
      },
    }),
  );
  await page.route("**/auth/admin/session", (route) =>
    route.fulfill({
      json: {
        userId: "material-admin",
        phone: "13800000000",
        features: {},
        scopes: [
          {
            scopeType: "TENANT",
            role: { code: "TENANT_ADMIN", name: "集团管理员" },
            tenant: { id: "tenant", name: "测试集团", customerType: "GROUP" },
            inheritedEnterprises: [{ id: "enterprise", name: "测试企业" }],
            permissions: [
              "material.read",
              "material.manage",
              "tenant.shared-material.manage",
              "campaign.read",
              "campaign.manage",
            ],
          },
        ],
      },
    }),
  );
  await page.route("**/generation-status", (route) =>
    route.fulfill({ json: { affectedEnterpriseCount: 0, notices: [] } }),
  );
});

function material(overrides: Record<string, unknown> = {}) {
  return {
    id: "material-one",
    seriesId: "series-one",
    tenantId: "tenant",
    enterpriseId: "enterprise",
    version: 1,
    title: "人物照片",
    content: "一位人物的肖像。",
    sourceText: "",
    supplement: null,
    status: "ACTIVE",
    authorizationStatus: "AUTHORIZED",
    ingestionStatus: "READY",
    usabilityStatus: "NEEDS_INPUT",
    type: "IMAGE_REFERENCE",
    tags: ["人物照片"],
    validFrom: null,
    expiresAt: null,
    sourceUrl: null,
    ingestionErrorCode: null,
    ingestionErrorMessage: null,
    artifacts: [],
    ingestionJobs: [],
    _count: { chunks: 0 },
    analysis: {
      summary: "一位人物的肖像。",
      missingInformation: ["请补充照片中人物的姓名、身份和使用场景。"],
    },
    ...overrides,
  };
}

test("compact library hides explanations and images while active versions remain editable after archive", async ({
  page,
}, testInfo) => {
  const shared = material({
    enterpriseId: null,
    title: "当前启用肖像",
    version: 3,
    supplement: "已有说明仍可修改",
    usabilityStatus: "USABLE",
    analysis: {
      summary: "人物照片资料",
      missingInformation: [],
      suggestedUses: ["不在列表展示的用途说明"],
    },
    artifacts: [
      {
        id: "a",
        status: "VERIFIED",
        originalFileName: "肖像.jpg",
        usabilityStatus: "USABLE",
        analysis: {},
      },
    ],
  });
  await page.route("**/console/tenants/**/materials", (route) =>
    route.fulfill({
      json: [
        shared,
        material({ id: "archived", enterpriseId: null, version: 4, status: "DISABLED" }),
        material({ id: "pending", seriesId: "pending-series", title: "待补充资料" }),
      ],
    }),
  );
  let previews = 0;
  await page.route("**/artifacts/*/preview", (route) => {
    previews++;
    return route.fulfill({ json: {} });
  });
  let saved = "";
  await page.route("**/materials/material-one/supplement", (route) => {
    saved = route.request().postDataJSON().supplement;
    return route.fulfill({ json: { materialId: "new-version", job: {} } });
  });
  await page.goto("/console/materials");
  const list = page.locator(".materialLibrary");
  await expect(list.getByText(/^集团\s+共享$/u)).toBeVisible();
  await expect(list.getByText(/^企业\s+专属$/u)).toBeVisible();
  await expect(list.locator("img")).toHaveCount(0);
  await expect(list.getByText("已补充的说明")).toHaveCount(0);
  await expect(list.getByText("已有说明仍可修改")).toHaveCount(0);
  await expect(list.getByText("还需要补充")).toHaveCount(0);
  await expect(list.getByText("不在列表展示的用途说明")).toHaveCount(0);
  const card = list.getByRole("article").filter({ hasText: "当前启用肖像" });
  await expect(card.getByRole("button", { name: "编辑说明", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: "待补充说明", exact: true })).toHaveCount(0);
  const pending = list.getByRole("article").filter({ hasText: "待补充资料" });
  await expect(
    pending.locator(".materialTitleRow").getByRole("button", { name: "待补充说明", exact: true }),
  ).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const scopes = await list.locator(".materialScope > span").evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          text: element.textContent,
          whitespace: getComputedStyle(element).whiteSpace,
          background: getComputedStyle(element).backgroundColor,
          color: getComputedStyle(element).color,
        };
      }),
    );
    expect(scopes).toEqual([
      {
        width: 48,
        height: 48,
        text: "集团\n共享",
        whitespace: "pre-line",
        background: "rgb(234, 242, 235)",
        color: "rgb(70, 109, 82)",
      },
      {
        width: 48,
        height: 48,
        text: "企业\n专属",
        whitespace: "pre-line",
        background: "rgb(232, 239, 247)",
        color: "rgb(65, 98, 132)",
      },
    ]);
    await expect(page.locator(".materialKindTabs button svg")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`material-list-${width}.png`),
      fullPage: true,
    });
  }
  expect(previews).toBe(0);
  await card.getByRole("button", { name: "编辑说明", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "编辑资料说明" });
  const text = drawer.getByRole("textbox", { name: "补充说明", exact: true });
  await expect(text).toHaveValue("已有说明仍可修改");
  await text.fill("重新修改后的主体说明");
  await drawer.getByRole("button", { name: "保存并重新分析" }).click();
  await expect.poll(() => saved).toBe("重新修改后的主体说明");
});

test("text intake sends only content and moves into AI processing", async ({ page }) => {
  let created = false;
  await page.route("**/console/tenants/**/materials", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body).toMatchObject({ content: "林院长的专家介绍资料。", type: "TEXT" });
      expect(body).not.toHaveProperty("title");
      expect(body).not.toHaveProperty("tags");
      created = true;
      await route.fulfill({ json: material() });
    } else
      await route.fulfill({
        json: created
          ? [
              material({
                type: "TEXT",
                ingestionStatus: "PENDING",
                usabilityStatus: "PENDING",
                title: "正在整理文本资料",
              }),
            ]
          : [],
      });
  });
  await page.goto("/console/materials");
  await page.getByRole("button", { name: "新增文字资料", exact: true }).click();
  await page.getByLabel("资料内容", { exact: true }).fill("林院长的专家介绍资料。");
  await page
    .getByRole("checkbox", { name: "我确认拥有资料的使用权，并获准用于本企业内容" })
    .check();
  await page.getByRole("button", { name: "提交资料", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "新增文字资料" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^AI 处理中/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("排队中", { exact: true })).toBeVisible();
});

test("image edits keep a single visible preview and support per-file removal and descriptions", async ({
  page,
}) => {
  let revision: Record<string, unknown> | null = null;
  await page.route("**/console/tenants/**/materials", (route) =>
    route.fulfill({
      json: [
        material({
          supplement: "本企业的门头和大厅",
          usabilityStatus: "USABLE",
          artifacts: ["门头.png", "大厅.png"].map((fileName, index) => ({
            id: `photo-${index}`,
            originalFileName: fileName,
            status: "VERIFIED",
            description: fileName,
            usage: "REFERENCE",
            usabilityStatus: "USABLE",
            analysis: {},
          })),
        }),
      ],
    }),
  );
  await page.route("**/artifacts/*/preview", (route) =>
    route.fulfill({
      json: {
        optimizedDataUrl:
          "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        url: "https://original.invalid/photo.png",
      },
    }),
  );
  await page.route("**/materials/material-one/revision", (route) => {
    revision = route.request().postDataJSON();
    return route.fulfill({ json: { materialId: "revised", intents: [] } });
  });
  await page.route("**/materials/revised/revision/finalize", (route) =>
    route.fulfill({ json: {} }),
  );
  await page.goto("/console/materials");
  await page.getByRole("button", { name: "更新内容" }).click();
  let drawer = page.getByRole("dialog", { name: "更新品牌资料" });
  await drawer
    .getByRole("textbox", { name: "本图说明", exact: true })
    .first()
    .fill("上海门店门头，入口外景");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await drawer.getByRole("button", { name: "查看门头.png" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: "原始资料" }).getByRole("img")).toBeVisible();
    await page.getByRole("button", { name: "关闭原始资料" }).click();
    drawer = page.getByRole("dialog", { name: "更新品牌资料" });
    await expect(
      drawer.getByRole("textbox", { name: "本图说明", exact: true }).first(),
    ).toHaveValue("上海门店门头，入口外景");
    const check = drawer.getByRole("checkbox", { name: "用作品牌 Logo（原图使用）" }).first();
    await expect(check).toHaveCSS("width", "16px");
    await expect(check).toHaveCSS("appearance", "none");
    await check.check();
    expect(await check.evaluate((element) => getComputedStyle(element, "::after").content)).toBe(
      '""',
    );
    await check.uncheck();
    await page.keyboard.press("Tab");
    await check.focus();
    await expect(check).toHaveCSS("outline-style", "solid");
    expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(
      await drawer.evaluate((element) => Math.abs(element.getBoundingClientRect().top)),
    ).toBeLessThan(2);
    await page.screenshot({ path: `.artifacts/material-editor-${width}.png` });
  }
  await drawer.getByRole("button", { name: "移除", exact: true }).last().click();
  await page
    .getByRole("checkbox", { name: "我确认拥有资料的使用权，并获准用于本企业内容" })
    .check();
  await drawer.getByRole("button", { name: "提交资料", exact: true }).click();
  await expect
    .poll(() => revision)
    .toMatchObject({
      removeArtifactIds: ["photo-1"],
      attachmentDescriptions: [
        { artifactId: "photo-0", description: "上海门店门头，入口外景", usage: "REFERENCE" },
      ],
    });
});

test("image upload uses explicit descriptions and retains partial upload progress", async ({
  page,
}) => {
  const types: string[] = [];
  let uploads = 0;
  await page.route("**/console/tenants/**/materials", (route) => route.fulfill({ json: [] }));
  await page.route("**/material-upload-intents", async (route) => {
    const body = route.request().postDataJSON();
    types.push(body.type);
    expect(body.supplement).toContain("本企业门店实景");
    expect(body).not.toHaveProperty("title");
    expect(body).not.toHaveProperty("tags");
    await route.fulfill({
      json: {
        artifactId: `artifact-${types.length}`,
        materialId: `material-${types.length}`,
        uploadUrl: `https://upload.example/${types.length}`,
        headers: { "Content-Type": body.mimeType },
        expiresInSeconds: 900,
      },
    });
  });
  await page.route("https://upload.example/**", async (route) => {
    uploads++;
    await route.fulfill({ status: uploads === 1 ? 503 : 200, body: "" });
  });
  await page.route("**/artifacts/*/complete", (route) => route.fulfill({ json: {} }));
  await page.goto("/console/materials");
  await page.getByRole("button", { name: "上传图片素材", exact: true }).click();
  await page.getByLabel("图片公共说明").fill("本企业门店实景");
  await page.getByLabel("选择文件", { exact: true }).setInputFiles([
    { name: "IMG_1.png", mimeType: "image/png", buffer: Buffer.from("image fixture") },
    { name: "大厅.png", mimeType: "image/png", buffer: Buffer.from("second image") },
  ]);
  await page
    .getByRole("checkbox", { name: "我确认拥有资料的使用权，并获准用于本企业内容" })
    .check();
  await page.getByRole("button", { name: "提交资料", exact: true }).click();
  await expect(page.getByText("上传未完成", { exact: true })).toBeVisible();
  await expect(page.getByText("已提交 AI 处理", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重试未完成的文件" }).click();
  await expect(page.getByRole("dialog", { name: "上传图片素材" })).toHaveCount(0);
  expect(types).toEqual(["IMAGE_REFERENCE", "IMAGE_REFERENCE"]);
  expect(uploads).toBe(3);
});

test("clarification requires one sentence and automatically refreshes into usable materials", async ({
  page,
}) => {
  let state = "NEEDS_INPUT";
  let polls = 0;
  await page.route("**/console/tenants/**/materials", async (route) => {
    if (state === "PENDING" && ++polls > 1) state = "USABLE";
    await route.fulfill({
      json: [
        material({
          usabilityStatus: state,
          ingestionStatus: state === "PENDING" ? "PENDING" : "READY",
          ...(state === "USABLE"
            ? {
                title: "林院长介绍照片",
                tags: ["林院长", "专家介绍"],
                analysis: { summary: "林院长的人物介绍照片", missingInformation: [] },
              }
            : {}),
        }),
      ],
    });
  });
  await page.route("**/materials/*/supplement", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      supplement: "照片中是本院林院长，用于专家介绍。",
    });
    state = "PENDING";
    await route.fulfill({ json: { materialId: "material-one", job: {} } });
  });
  await page.goto("/console/materials");
  await page.getByRole("tab", { name: /^待补充/u }).click();
  await expect(page.getByText("待补充 · 暂不用于生成", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "待补充说明", exact: true }).click();
  await page.getByLabel("补充说明", { exact: true }).fill("照片中是本院林院长，用于专家介绍。");
  await page.getByRole("button", { name: "保存并重新分析" }).click();
  await expect(page.getByRole("tab", { name: /^AI 处理中/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("当前没有正在处理的资料", { exact: true })).toBeVisible({
    timeout: 12000,
  });
  await page.getByRole("tab", { name: /^可用资料/u }).click();
  await expect(page.getByText("林院长介绍照片", { exact: true })).toBeVisible();
  await expect(page.getByText("#林院长", { exact: true })).toBeVisible();
});

test("material preview stays inline on desktop and mobile, and only loads compressed bytes", async ({
  page,
}) => {
  const thumbnail =
    "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
  const signedOriginal = "https://files.example/original.jpg";
  let previews = 0;
  let originalRequests = 0;
  await page.route("**/console/tenants/**/materials", (route) =>
    route.fulfill({
      json: [
        material({
          title: "周示例-白衣.jpg",
          ingestionStatus: "PROCESSING",
          usabilityStatus: "PENDING",
          artifacts: [{ id: "artifact-1", status: "STORED", originalFileName: "周示例-白衣.jpg" }],
        }),
      ],
    }),
  );
  await page.route("**/materials/material-one/artifacts/artifact-1/preview", (route) => {
    previews++;
    return route.fulfill({
      json: { expiresInSeconds: 900, optimizedDataUrl: thumbnail, url: signedOriginal },
    });
  });
  await page.context().route("https://files.example/**", (route) => {
    originalRequests++;
    return route.fulfill({ status: 200, body: "" });
  });

  await page.goto("/console/materials");
  await page.getByRole("tab", { name: /^AI 处理中/u }).click();
  const button = page.getByRole("button", { name: "查看原文件" });
  await expect(button).toBeVisible();
  expect(previews).toBe(0);
  await expect(page.locator(".materialLibrary img")).toHaveCount(0);
  expect(originalRequests).toBe(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(button).toBeVisible();
    const dimensions = await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const card = element.closest("article")?.getBoundingClientRect();
      return { width: box.width, height: box.height, right: box.right, cardRight: card?.right };
    });
    expect(dimensions.width).toBeGreaterThan(70);
    expect(dimensions.height).toBeLessThan(42);
    expect(dimensions.right).toBeLessThanOrEqual(dimensions.cardRight ?? 0);
    await button.click();
    const drawer = page.getByRole("dialog", { name: "原始资料" });
    await expect(drawer.getByRole("img", { name: "周示例-白衣.jpg" })).toHaveAttribute(
      "src",
      thumbnail,
    );
    await expect(drawer.getByRole("link", { name: "打开原文件" })).toHaveCount(0);
    expect(originalRequests).toBe(0);
    await drawer.getByRole("button", { name: "关闭原始资料" }).click();
  }
  expect(previews).toBe(2);
  expect(originalRequests).toBe(0);
  await page.getByLabel("资料范围").selectOption("SHARED");
  await expect(button).toHaveCount(0);
  await page.getByLabel("资料范围").selectOption("ALL");
  await page.getByLabel("仅看即将到期").check();
  await expect(button).toHaveCount(0);
});

test("archived material versions stay out of the library and its counts", async ({ page }) => {
  const rows = [
    material({ id: "old", title: "旧版肖像", status: "DISABLED", version: 1 }),
    material({
      id: "current",
      title: "当前人物肖像",
      version: 2,
      ingestionStatus: "READY",
      usabilityStatus: "USABLE",
    }),
    material({
      id: "retired",
      seriesId: "series-retired",
      title: "已停用的单版资料",
      status: "DISABLED",
    }),
  ];
  await page.route("**/console/tenants/**/materials", (route) => route.fulfill({ json: rows }));
  await page.goto("/console/materials");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(page.getByRole("tab", { name: /^全部资料\s*1$/u })).toBeVisible();
    await expect(page.getByRole("tab", { name: /^可用资料\s*1$/u })).toBeVisible();
    await expect(page.getByText("当前人物肖像", { exact: true })).toBeVisible();
    await expect(page.getByText("旧版肖像", { exact: true })).toHaveCount(0);
    await expect(page.getByText("已停用的单版资料", { exact: true })).toHaveCount(0);
  }
  await page.getByLabel("搜索品牌资料").fill("旧版肖像");
  await expect(page.getByText("没有符合条件的资料")).toBeVisible();
  await page.getByLabel("搜索品牌资料").clear();
  await page.getByRole("tab", { name: /^可用资料\s*1$/u }).click();
  await expect(page.getByText("当前人物肖像", { exact: true })).toBeVisible();

  // Until the new version is ready, the older ACTIVE version is still used for generation.
  rows.push(
    material({
      id: "pending",
      title: "新版正在处理",
      version: 3,
      ingestionStatus: "PENDING",
      usabilityStatus: "PENDING",
    }),
  );
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("tab", { name: /^全部资料\s*2$/u }).click();
  await expect(page.getByText("当前人物肖像", { exact: true })).toBeVisible();
  await expect(page.getByText("新版正在处理", { exact: true })).toBeVisible();
  await expect(page.getByText("旧版肖像", { exact: true })).toHaveCount(0);
});

test("updating a file material retains historical attachments and submits new files as one revision", async ({
  page,
}) => {
  let revisionCalls = 0;
  let uploads = 0;
  let completed = 0;
  let finalized = 0;
  await page.route("**/console/tenants/**/materials", (route) =>
    route.fulfill({
      json: [
        material({
          id: "older",
          status: "DISABLED",
          title: "已归档照片",
          artifacts: [
            {
              id: "prior-artifact",
              status: "VERIFIED",
              checksum: "a",
              originalFileName: "旧照片.png",
            },
          ],
        }),
        material({
          title: "人物资料",
          version: 2,
          supplement: "原来的资料说明",
          usabilityStatus: "USABLE",
          artifacts: [
            {
              id: "current-artifact",
              status: "VERIFIED",
              checksum: "b",
              originalFileName: "现有照片.png",
            },
          ],
        }),
      ],
    }),
  );
  await page.route("**/materials/material-one/revision", (route) => {
    revisionCalls++;
    const body = route.request().postDataJSON();
    expect(body.files).toHaveLength(2);
    expect(body.restoreArtifactIds).toEqual(["prior-artifact"]);
    expect(body.supplement).toBe("更新后的资料说明");
    expect(body.files.map((file: { fileName: string }) => file.fileName)).toEqual([
      "新照片1.png",
      "新照片2.png",
    ]);
    return route.fulfill({
      json: {
        materialId: "revision-one",
        intents: body.files.map((file: { mimeType: string }, index: number) => ({
          artifactId: `new-${index}`,
          materialId: "revision-one",
          headers: { "Content-Type": file.mimeType },
          uploadUrl: `https://upload.example/revision-${index}`,
        })),
      },
    });
  });
  await page.route("https://upload.example/revision-*", (route) => {
    uploads++;
    return route.fulfill({ status: 200 });
  });
  await page.route("**/materials/revision-one/artifacts/*/complete", (route) => {
    completed++;
    return route.fulfill({ json: { job: null } });
  });
  await page.route("**/materials/revision-one/revision/finalize", (route) => {
    finalized++;
    return route.fulfill({ json: { materialId: "revision-one", job: { status: "PENDING" } } });
  });

  await page.goto("/console/materials");
  await page.getByRole("button", { name: "更新内容" }).click();
  const drawer = page.getByRole("dialog", { name: "更新品牌资料" });
  await expect(drawer.getByLabel("已上传附件").getByText("旧照片.png")).toBeVisible();
  await expect(drawer.getByLabel("已上传附件").getByText("现有照片.png")).toBeVisible();
  await drawer.getByLabel("加入本次更新").check();
  await expect(drawer.getByLabel("图片公共说明")).toHaveValue("原来的资料说明");
  await drawer.getByLabel("图片公共说明").fill("更新后的资料说明");
  await expect(drawer.getByLabel("选择文件")).toHaveAttribute("multiple", "");
  await drawer.getByLabel("选择文件").setInputFiles([
    { name: "新照片1.png", mimeType: "image/png", buffer: Buffer.from("image one") },
    { name: "新照片2.png", mimeType: "image/png", buffer: Buffer.from("image two") },
  ]);
  await page.setViewportSize({ width: 390, height: 850 });
  await expect(drawer.getByRole("button", { name: "提交资料" })).toBeVisible();
  const alignment = await drawer.getByLabel("加入本次更新").evaluate((input) => {
    const control = input.getBoundingClientRect();
    const row = input.closest("label")?.getBoundingClientRect();
    return {
      size: control.width,
      verticalOffset: row
        ? Math.abs(control.top + control.height / 2 - (row.top + row.height / 2))
        : 100,
    };
  });
  expect(alignment.size).toBeLessThan(24);
  expect(alignment.verticalOffset).toBeLessThan(4);
  expect(
    (await drawer.getByRole("button", { name: "查看现有照片.png" }).boundingBox())?.width,
  ).toBeLessThan(90);
  expect(
    (await drawer.getByRole("button", { name: "提交资料" }).boundingBox())?.width,
  ).toBeLessThan(190);
  await page
    .getByRole("checkbox", { name: "我确认拥有资料的使用权，并获准用于本企业内容" })
    .check();
  await drawer.getByRole("button", { name: "提交资料" }).click();
  await expect(drawer).toHaveCount(0);
  expect({ revisionCalls, uploads, completed, finalized }).toEqual({
    revisionCalls: 1,
    uploads: 2,
    completed: 2,
    finalized: 1,
  });
});

test("an unfinished material revision can resume after reopening the page", async ({ page }) => {
  let resumed = 0;
  let finalized = 0;
  await page.route("**/console/tenants/**/materials", (route) =>
    route.fulfill({
      json: [
        material({
          id: "pending-revision",
          title: "更新中的人物资料",
          parserVersion: "material-ai-bundle-v1",
          ingestionStatus: "PENDING",
          usabilityStatus: "PENDING",
          supplement: "之前的资料说明",
          artifacts: [
            { id: "kept", status: "STORED", checksum: "old", originalFileName: "保留照片.png" },
            { id: "pending-file", status: "PENDING_UPLOAD", originalFileName: "待补传.png" },
          ],
        }),
      ],
    }),
  );
  await page.route("**/materials/pending-revision/revision/resume", (route) => {
    resumed++;
    expect(route.request().postDataJSON().files[0].fileName).toBe("待补传.png");
    return route.fulfill({
      json: {
        materialId: "pending-revision",
        intents: [
          {
            artifactId: "pending-file",
            headers: { "Content-Type": "image/png" },
            uploadUrl: "https://upload.example/resumed",
          },
        ],
      },
    });
  });
  await page.route("https://upload.example/resumed", (route) => route.fulfill({ status: 200 }));
  await page.route("**/materials/pending-revision/artifacts/pending-file/complete", (route) =>
    route.fulfill({ json: { job: null } }),
  );
  await page.route("**/materials/pending-revision/revision/finalize", (route) => {
    finalized++;
    return route.fulfill({ json: { materialId: "pending-revision", job: { status: "PENDING" } } });
  });
  await page.goto("/console/materials");
  await page.getByRole("button", { name: "继续上传附件" }).click();
  const drawer = page.getByRole("dialog", { name: "更新品牌资料" });
  await expect(drawer.getByText("保留照片.png")).toBeVisible();
  await expect(drawer.getByText("待补传.png")).toBeVisible();
  await expect(drawer.getByLabel("图片公共说明")).toHaveValue("之前的资料说明");
  await drawer.getByLabel("选择文件").setInputFiles({
    name: "待补传.png",
    mimeType: "image/png",
    buffer: Buffer.from("resume file"),
  });
  await page
    .getByRole("checkbox", { name: "我确认拥有资料的使用权，并获准用于本企业内容" })
    .check();
  await drawer.getByRole("button", { name: "提交资料" }).click();
  await expect(drawer).toHaveCount(0);
  expect({ resumed, finalized }).toEqual({ resumed: 1, finalized: 1 });
});

test("a description-only revision keeps its existing attachment", async ({ page }) => {
  let submittedFiles: unknown[] | null = null;
  let finalized = 0;
  await page.route("**/console/tenants/**/materials", (route) =>
    route.fulfill({
      json: [
        material({
          title: "机构资料",
          type: "DOCUMENT",
          supplement: "之前的说明",
          usabilityStatus: "USABLE",
          artifacts: [{ id: "original", status: "VERIFIED", originalFileName: "机构介绍.pdf" }],
        }),
      ],
    }),
  );
  await page.route("**/materials/material-one/revision", (route) => {
    submittedFiles = route.request().postDataJSON().files;
    return route.fulfill({ json: { materialId: "notes-revision", intents: [] } });
  });
  await page.route("**/materials/notes-revision/revision/finalize", (route) => {
    finalized++;
    return route.fulfill({ json: { materialId: "notes-revision", job: {} } });
  });
  await page.goto("/console/materials");
  await page.getByRole("button", { name: "更新内容" }).click();
  const drawer = page.getByRole("dialog", { name: "更新品牌资料" });
  await expect(drawer.getByText("机构介绍.pdf")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "提交资料" })).toBeDisabled();
  await drawer.getByLabel("资料说明（适用于所有附件）").fill("更新机构介绍的说明");
  await page
    .getByRole("checkbox", { name: "我确认拥有资料的使用权，并获准用于本企业内容" })
    .check();
  await drawer.getByRole("button", { name: "提交资料" }).click();
  await expect(drawer).toHaveCount(0);
  expect(submittedFiles).toEqual([]);
  expect(finalized).toBe(1);
});

test("a partial attachment failure retries only the missing upload before finalizing", async ({
  page,
}) => {
  let revisionCalls = 0;
  let failedOnce = false;
  const uploadPaths: string[] = [];
  let finalized = 0;
  await page.route("**/console/tenants/**/materials", (route) =>
    route.fulfill({
      json: [
        material({
          usabilityStatus: "USABLE",
          artifacts: [
            { id: "original", status: "VERIFIED", checksum: "old", originalFileName: "保留.png" },
          ],
        }),
      ],
    }),
  );
  await page.route("**/materials/material-one/revision", (route) => {
    revisionCalls++;
    return route.fulfill({
      json: {
        materialId: "retry-revision",
        intents: [0, 1].map((index) => ({
          artifactId: `retry-${index}`,
          headers: { "Content-Type": "image/png" },
          uploadUrl: `https://upload.example/retry-${index}`,
        })),
      },
    });
  });
  await page.route("https://upload.example/retry-*", (route) => {
    const path = new URL(route.request().url()).pathname;
    uploadPaths.push(path);
    if (path.endsWith("retry-0") && !failedOnce) {
      failedOnce = true;
      return route.fulfill({ status: 503 });
    }
    return route.fulfill({ status: 200 });
  });
  await page.route("**/materials/retry-revision/artifacts/*/complete", (route) =>
    route.fulfill({ json: { job: null } }),
  );
  await page.route("**/materials/retry-revision/revision/finalize", (route) => {
    finalized++;
    return route.fulfill({ json: { materialId: "retry-revision", job: {} } });
  });
  await page.goto("/console/materials");
  await page.getByRole("button", { name: "更新内容" }).click();
  const drawer = page.getByRole("dialog", { name: "更新品牌资料" });
  await drawer.getByLabel("选择文件").setInputFiles([
    { name: "追加1.png", mimeType: "image/png", buffer: Buffer.from("first") },
    { name: "追加2.png", mimeType: "image/png", buffer: Buffer.from("second") },
  ]);
  await page
    .getByRole("checkbox", { name: "我确认拥有资料的使用权，并获准用于本企业内容" })
    .check();
  await drawer.getByRole("button", { name: "提交资料" }).click();
  await expect(
    page.getByRole("alert").getByText("部分新附件尚未完成上传", { exact: false }),
  ).toBeVisible();
  expect(finalized).toBe(0);
  await drawer.getByRole("button", { name: "重试未完成的文件" }).click();
  await expect(drawer).toHaveCount(0);
  expect(revisionCalls).toBe(1);
  expect(uploadPaths).toEqual(["/retry-0", "/retry-1", "/retry-0"]);
  expect(finalized).toBe(1);
});

test("a multi-attachment material lists every original file from its card", async ({ page }) => {
  await page.route("**/console/tenants/**/materials", (route) =>
    route.fulfill({
      json: [
        material({
          title: "人物组合资料",
          usabilityStatus: "USABLE",
          artifacts: [
            { id: "first", status: "VERIFIED", originalFileName: "第一张.png" },
            { id: "second", status: "VERIFIED", originalFileName: "第二张.png" },
          ],
        }),
      ],
    }),
  );
  await page.goto("/console/materials");
  await page.getByRole("button", { name: "查看附件" }).click();
  const drawer = page.getByRole("dialog", { name: "资料附件" });
  await expect(drawer.getByText("第一张.png")).toBeVisible();
  await expect(drawer.getByText("第二张.png")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 850 });
  await expect(drawer.getByRole("button", { name: "查看第二张.png" })).toBeVisible();
});
