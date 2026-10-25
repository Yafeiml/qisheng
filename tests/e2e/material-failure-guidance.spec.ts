import { expect, type Locator, type Page, test } from "@playwright/test";

const rawProviderError =
  "upstream https://private-provider.invalid token=secret-do-not-render stack: internal failure";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          Reflect.set(window, "materialCopiedDiagnostics", text);
        },
      },
    });
  });
  await page.route(/:3100\//u, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked material failure fixture" } }),
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
            permissions: ["material.read", "material.manage", "tenant.shared-material.manage"],
          },
        ],
      },
    }),
  );
  await page.route("**/generation-status", (route) =>
    route.fulfill({ json: { affectedEnterpriseCount: 0, notices: [] } }),
  );
});

function failedMaterial(overrides: Record<string, unknown> = {}) {
  return {
    id: "material-failed",
    seriesId: "series-failed",
    tenantId: "tenant",
    enterpriseId: "enterprise",
    version: 1,
    title: "全飞秒资料",
    content: "全飞秒手术的流程介绍。",
    sourceText: "全飞秒手术的流程介绍。",
    supplement: null,
    status: "ACTIVE",
    authorizationStatus: "AUTHORIZED",
    ingestionStatus: "FAILED",
    usabilityStatus: "PENDING",
    type: "TEXT",
    tags: [],
    validFrom: null,
    expiresAt: null,
    sourceUrl: null,
    ingestionErrorCode: "MATERIAL_ANALYSIS_AUTH_FAILED",
    ingestionErrorMessage: rawProviderError,
    artifacts: [],
    ingestionJobs: [
      {
        id: "job-failed",
        status: "FAILED",
        attemptCount: 5,
        maxAttempts: 5,
        queueVersion: 1,
        createdAt: "2026-10-06T01:00:00.000Z",
        finishedAt: "2026-10-06T01:01:00.000Z",
        errorCode: "MATERIAL_ANALYSIS_AUTH_FAILED",
        errorMessage: rawProviderError,
      },
    ],
    _count: { chunks: 0 },
    analysis: null,
    ...overrides,
  };
}

async function mockMaterials(page: Page, materials: Record<string, unknown>[]) {
  await page.route("**/console/tenants/**/materials", (route) =>
    route.fulfill({ json: materials }),
  );
}

function cardFor(page: Page, title = "全飞秒资料") {
  return page.locator(".materialLibrary article").filter({ hasText: title });
}

async function expectContainedControl(control: Locator) {
  const dimensions = await control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const card = element.closest("article")?.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      right: rect.right,
      left: rect.left,
      cardRight: card?.right,
      cardLeft: card?.left,
      fontSize: getComputedStyle(element).fontSize,
    };
  });
  expect(dimensions.width).toBeGreaterThan(65);
  expect(dimensions.height).toBeGreaterThanOrEqual(28);
  expect(dimensions.height).toBeLessThan(60);
  expect(dimensions.right).toBeLessThanOrEqual((dimensions.cardRight ?? 0) + 1);
  expect(dimensions.left).toBeGreaterThanOrEqual((dimensions.cardLeft ?? 0) - 1);
  expect(Number.parseFloat(dimensions.fontSize)).toBeGreaterThanOrEqual(12);
}

for (const code of [
  "MATERIAL_ANALYSIS_AUTH_FAILED",
  "EMBEDDING_MODEL_NOT_CONFIGURED",
  "MATERIAL_ANALYSIS_TIMEOUT",
  "UNKNOWN_PROVIDER_FAILURE",
] as const) {
  test(`${code} directs users to the platform administrator and keeps raw errors private`, async ({
    page,
  }) => {
    let row = failedMaterial({ ingestionErrorCode: code });
    await page.route("**/console/tenants/**/materials", (route) => route.fulfill({ json: [row] }));
    let finishRetry: (() => void) | undefined;
    let retryRequested = false;
    if (code === "MATERIAL_ANALYSIS_AUTH_FAILED") {
      await page.route("**/materials/material-failed/ingestion/retry", async (route) => {
        expect(route.request().method()).toBe("POST");
        retryRequested = true;
        await new Promise<void>((resolve) => {
          finishRetry = resolve;
        });
        row = failedMaterial({
          ingestionStatus: "PENDING",
          ingestionErrorCode: null,
          ingestionErrorMessage: null,
          ingestionJobs: [
            {
              id: "job-user-retry",
              status: "PENDING",
              attemptCount: 0,
              maxAttempts: 5,
              queueVersion: 1,
              createdAt: "2026-10-06T01:02:00.000Z",
              finishedAt: null,
              errorCode: null,
              errorMessage: null,
            },
          ],
        });
        await route.fulfill({ json: { materialId: "material-failed", job: {} } });
      });
    }
    await page.goto("/console/materials");
    const card = cardFor(page);
    const inline = card.locator(".materialFailureInline");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(inline).toHaveText("发生错误，请联系平台协助处理。");
      const presentation = await inline.evaluate((element) => ({
        tag: element.tagName,
        height: element.getBoundingClientRect().height,
        background: getComputedStyle(element).backgroundColor,
      }));
      expect(presentation.tag).toBe("P");
      expect(presentation.height).toBeLessThanOrEqual(width === 390 ? 44 : 28);
      expect(presentation.background).toBe("rgba(0, 0, 0, 0)");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      const retry = card.getByRole("button", { name: "重新处理", exact: true });
      await expect(retry).toBeEnabled();
      await expectContainedControl(retry);
    }
    await expect(
      card.locator(".materialFailureNotice, .materialFailureTitle, .materialFailureSteps, details"),
    ).toHaveCount(0);
    await expect(card.getByRole("button", { name: /复制排查信息|更新内容/u })).toHaveCount(0);
    await expect(card).not.toContainText(rawProviderError);
    await expect(card).not.toContainText("private-provider.invalid");
    if (code === "MATERIAL_ANALYSIS_AUTH_FAILED") {
      const retry = card.getByRole("button", { name: "重新处理", exact: true });
      await retry.click();
      await expect.poll(() => retryRequested).toBe(true);
      await expect(retry).toBeDisabled();
      finishRetry?.();
      await expect(
        page.getByRole("status").getByText("资料已重新进入 AI 处理队列。", { exact: true }),
      ).toBeVisible();
      await expect(card.getByText("排队中", { exact: true })).toBeVisible();
      await expect(card.locator(".materialFailureInline")).toHaveCount(0);
    }
  });
}

test("a retryable failed job remains in AI processing and prevents duplicate submissions", async ({
  page,
}) => {
  await mockMaterials(page, [
    failedMaterial({
      ingestionErrorCode: "MATERIAL_ANALYSIS_TIMEOUT",
      ingestionJobs: [
        {
          id: "job-auto-retry",
          status: "FAILED",
          attemptCount: 1,
          maxAttempts: 5,
          errorCode: "MATERIAL_ANALYSIS_TIMEOUT",
          errorMessage: rawProviderError,
        },
      ],
    }),
  ]);
  await page.goto("/console/materials");
  await page.getByRole("tab", { name: /^AI 处理中/u }).click();
  const card = cardFor(page);
  await expect(card.getByText("正在自动重试", { exact: true })).toBeVisible();
  await expect(card.locator(".materialFailureInline")).toHaveText("发生错误，请联系平台协助处理。");
  await expect(card.locator(".materialFailureNotice, .materialRetryNotice")).toHaveCount(0);
  await expect(card).not.toContainText("系统正在自动重试，无需重复提交。");
  await expect(card.getByRole("button", { name: "重新处理", exact: true })).toBeDisabled();
  await expect(card.getByRole("button", { name: "更新内容", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: /^处理失败/u }).click();
  await expect(card).toHaveCount(0);
});

test("a quarantined latest job is stopped even when its attempt budget remains", async ({
  page,
}) => {
  await mockMaterials(page, [
    failedMaterial({
      ingestionErrorCode: "UNKNOWN_PROVIDER_FAILURE",
      ingestionJobs: [
        {
          id: "job-stopped",
          status: "QUARANTINED",
          attemptCount: 1,
          maxAttempts: 5,
          errorCode: "UNKNOWN_PROVIDER_FAILURE",
        },
      ],
    }),
  ]);
  await page.goto("/console/materials");
  await page.getByRole("tab", { name: /^处理失败/u }).click();
  const card = cardFor(page);
  await expect(card.locator(".materialFailureInline")).toHaveText("发生错误，请联系平台协助处理。");
  await expect(card.locator(".materialFailureNotice")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "重新处理", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: "更新内容", exact: true })).toHaveCount(0);
  await expect(card).not.toContainText("系统正在自动重试，无需重复提交。");
});

test("quarantined files require correction instead of retrying unchanged content", async ({
  page,
}) => {
  await mockMaterials(page, [
    failedMaterial({
      title: "无法解析的扫描件",
      type: "DOCUMENT",
      ingestionStatus: "QUARANTINED",
      ingestionErrorCode: "EMPTY_EXTRACTED_TEXT",
      ingestionJobs: [
        {
          id: "job-quarantined",
          status: "QUARANTINED",
          attemptCount: 1,
          maxAttempts: 5,
          errorCode: "EMPTY_EXTRACTED_TEXT",
        },
      ],
      artifacts: [
        {
          id: "artifact-quarantined",
          originalFileName: "扫描件.pdf",
          status: "STORED",
          description: "扫描件",
          usage: "REFERENCE",
          kind: "UPLOAD",
          mimeType: "application/pdf",
          usabilityStatus: "PENDING",
          analysis: {},
        },
      ],
    }),
  ]);
  await page.goto("/console/materials");
  await page.getByRole("tab", { name: /^处理失败/u }).click();
  const card = cardFor(page, "无法解析的扫描件");
  await expect(card.locator(".materialFailureNotice")).toBeVisible();
  await expect(card.locator(".materialFailureTitle")).toHaveText("未读取到可用文字");
  await expect(card.locator(".materialFailureSteps")).toContainText(/文字|文件|重新上传/u);
  await expect(card.getByRole("button", { name: "重新处理", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "检查并更新内容", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "更新品牌资料" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("扫描件.pdf", { exact: true })).toBeVisible();
});

test("terminal failure guidance, diagnostics and controls work at desktop and narrow widths", async ({
  page,
}, testInfo) => {
  let rows: Record<string, unknown>[] = [
    failedMaterial({
      type: "DOCUMENT",
      ingestionStatus: "QUARANTINED",
      ingestionErrorCode: "EMPTY_EXTRACTED_TEXT",
      artifacts: [
        {
          id: "artifact-file",
          originalFileName: "全飞秒扫描件.pdf",
          status: "STORED",
          description: "待识别文档",
          usage: "REFERENCE",
          kind: "UPLOAD",
          mimeType: "application/pdf",
          usabilityStatus: "PENDING",
          analysis: {},
        },
      ],
    }),
    failedMaterial({
      id: "material-shared",
      seriesId: "series-shared",
      enterpriseId: null,
      title: "集团全飞秒说明",
    }),
  ];
  await page.route("**/console/tenants/**/materials", (route) => route.fulfill({ json: rows }));
  let finishUpdate: (() => void) | undefined;
  let updateRequested = false;
  await page.route("**/materials/material-failed/revision", async (route) => {
    updateRequested = true;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON().supplement).toBe(
      "已核实的全飞秒资料正文。方案说明完整。",
    );
    await new Promise<void>((resolve) => {
      finishUpdate = resolve;
    });
    await route.fulfill({ json: { materialId: "material-failed", intents: [] } });
  });
  await page.route("**/materials/material-failed/revision/finalize", async (route) => {
    rows = rows.map((row) =>
      row.id === "material-failed"
        ? {
            ...row,
            ingestionStatus: "PENDING",
            ingestionErrorCode: null,
            ingestionErrorMessage: null,
            ingestionJobs: [
              { id: "job-manual-retry", status: "PENDING", attemptCount: 0, maxAttempts: 5 },
            ],
          }
        : row,
    );
    await route.fulfill({ json: { materialId: "material-failed", job: {} } });
  });
  await page.goto("/console/materials");
  const card = cardFor(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(card.locator(".materialFailureNotice")).toBeVisible();
    await expect(card.locator(".materialFailureTitle")).toHaveText("未读取到可用文字");
    await expectContainedControl(card.getByRole("button", { name: "检查并更新内容", exact: true }));
    await expect(card.getByRole("button", { name: /重新处理/u })).toHaveCount(0);
    await card.locator("details > summary").click();
    const copy = card.getByRole("button", { name: "复制排查信息", exact: true });
    await expectContainedControl(copy);
    await copy.focus();
    await expect(copy).toBeFocused();
    await copy.click();
    const copied = await page.evaluate(() => Reflect.get(window, "materialCopiedDiagnostics"));
    expect(copied).toContain("EMPTY_EXTRACTED_TEXT");
    expect(copied).toContain("material-failed");
    expect(copied).toContain("job-failed");
    expect(copied).not.toContain("secret-do-not-render");
    expect(copied).not.toContain("private-provider.invalid");
    await card.locator("details > summary").click();
    await page.getByLabel("资料范围", { exact: true }).selectOption("SHARED");
    await expect(card).toHaveCount(0);
    await expect(cardFor(page, "集团全飞秒说明")).toBeVisible();
    await page.getByLabel("资料范围", { exact: true }).selectOption("ALL");
    await page.getByLabel("仅看即将到期", { exact: true }).check();
    await expect(page.locator(".materialLibrary article")).toHaveCount(0);
    await page.getByLabel("仅看即将到期", { exact: true }).uncheck();
    await expect(card).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`material-failure-guidance-${width}.png`),
      fullPage: true,
    });
  }
  await card.getByRole("button", { name: "检查并更新内容", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "更新品牌资料" });
  const submit = drawer.getByRole("button", { name: "提交资料", exact: true });
  await expect(submit).toBeDisabled();
  await drawer
    .getByRole("textbox", { name: "资料说明（适用于所有附件）" })
    .fill("已核实的全飞秒资料正文。方案说明完整。");
  await drawer
    .getByRole("checkbox", { name: "我确认拥有资料的使用权，并获准用于本企业内容" })
    .check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => updateRequested).toBe(true);
  await expect(drawer.getByRole("button", { name: "正在提交…", exact: true })).toBeDisabled();
  finishUpdate?.();
  await expect(drawer).toHaveCount(0);
  await expect(card.getByText("排队中", { exact: true })).toBeVisible();
  await expect(card.locator(".materialFailureNotice")).toHaveCount(0);
  await expect(card.getByRole("button", { name: /重新处理|更新内容/u })).toHaveCount(0);
});
