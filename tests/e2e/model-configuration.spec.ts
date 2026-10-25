import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("xhs-agentic:mvp-session:v1", JSON.stringify({ mode: "FORMAL" })),
  );
  // Every API call in this suite is mocked: no demo seeding, real credentials or billable calls.
  await page.route(/:3100\//, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked API" } }),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "mock-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/account", (route) =>
    route.fulfill({
      json: {
        name: "模型验收管理员",
        email: "models@example.test",
        emailVerifiedAt: "2026-10-13T00:00:00Z",
      },
    }),
  );
  await page.route("**/auth/admin/session", (route) =>
    route.fulfill({
      json: {
        userId: "mock-admin",
        phone: "13800000000",
        features: {},
        scopes: [
          {
            scopeType: "PLATFORM",
            permissions: ["platform.model.manage", "platform.monitor.read"],
          },
        ],
      },
    }),
  );
  await page.route("**/platform/operations/production-readiness", (route) =>
    route.fulfill({ json: { checks: [] } }),
  );
});

const model = (id: string, providerId: string, capabilities: string[]) => ({
  id,
  providerId,
  code: id,
  displayName: id,
  externalModelId: id,
  capabilities,
  status: "ACTIVE",
  synthetic: false,
});
const provider = (id: string, name = "企业模型服务") => ({
  id,
  name,
  code: `API_${id}`,
  baseUrl: "https://models.example/v1",
  status: "ACTIVE",
  protocol: "OPENAI_COMPATIBLE",
  synthetic: false,
  credentialConfigured: true,
  circuitState: "CLOSED",
  healthStatus: "UNKNOWN",
  lastHealthCheckedAt: null as string | null,
  models: [] as ReturnType<typeof model>[],
});
async function fixture(page: Page, discoveryFails = false) {
  const business = provider("business");
  business.models = [
    model("old-text", business.id, ["TEXT", "VISION"]),
    model("old-image", business.id, ["IMAGE"]),
  ];
  const second = provider("second", "第二供应商");
  const testProvider = {
    ...provider("test", "Sprint 6 Real Qualification Provider"),
    code: "S6_REAL_AB1234",
  };
  const catalog = {
    providers: [business, second, testProvider],
    routes: [
      {
        id: "default-route",
        scopeType: "PLATFORM",
        scopeId: "platform",
        textModel: business.models[0],
        imageModel: business.models[1],
        textFallbackModelIds: [],
        imageFallbackModelIds: [],
        maxAttemptsPerModel: 2,
        qualification: null as null | Record<string, unknown>,
        runtimeHealth: null as null | Record<string, unknown>,
      },
    ],
  };
  const policy = {
    providerHealthMaxAgeSeconds: 900,
    routeQualificationMaxAgeSeconds: 86400,
    materialAnalysisModelId: null as string | null,
    embeddingModelId: null as string | null,
  };
  const writes: Record<string, { providerId: string; externalModelId: string } | null>[] = [];
  const discoveries: string[] = [];
  await page.route("**/platform/model-catalog", (route) => route.fulfill({ json: catalog }));
  await page.route("**/platform/runtime-policy", (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: policy });
  });
  await page.route("**/platform/model-providers/*/available-models", (route) => {
    const id = route.request().url().split("/").at(-2) ?? "";
    discoveries.push(id);
    return discoveryFails
      ? route.fulfill({ status: 503, json: { message: "暂时无法读取模型列表" } })
      : route.fulfill({
          json: {
            providerId: id,
            models: [
              {
                externalModelId: "new-text",
                displayName: "new-text",
                suggestedCapabilities: ["TEXT"],
              },
              {
                externalModelId: "new-image",
                displayName: "new-image",
                suggestedCapabilities: ["IMAGE"],
              },
              {
                externalModelId: "BAAI/bge-m3",
                displayName: "BAAI/bge-m3",
                suggestedCapabilities: ["EMBEDDING"],
              },
              {
                externalModelId: "new-vision",
                displayName: "new-vision",
                suggestedCapabilities: ["TEXT", "VISION"],
              },
            ],
          },
        });
  });
  await page.route("**/platform/model-setup", async (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    const register = (
      selection: { providerId: string; externalModelId: string },
      capabilities: string[],
    ) => {
      const p = catalog.providers.find((p) => p.id === selection.providerId);
      if (!p) throw new Error("Unknown provider");
      let m = p.models.find((m) => m.externalModelId === selection.externalModelId);
      if (!m) {
        m = model(selection.externalModelId, p.id, capabilities);
        p.models.push(m);
      }
      return m;
    };
    catalog.routes[0].textModel = register(body.textModel, ["TEXT"]);
    catalog.routes[0].imageModel = register(body.imageModel, ["IMAGE"]);
    policy.embeddingModelId = body.embeddingModel
      ? register(body.embeddingModel, ["EMBEDDING"]).id
      : null;
    policy.materialAnalysisModelId = body.materialAnalysisModel
      ? register(body.materialAnalysisModel, ["TEXT", "VISION"]).id
      : null;
    await route.fulfill({ json: { route: catalog.routes[0], runtimePolicy: policy } });
  });
  return { catalog, writes, discoveries };
}

for (const width of [390, 1440]) {
  test(`empty provider guidance flows as one sentence and supports keyboard at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const { catalog } = await fixture(page);
    catalog.providers.length = 0;
    catalog.routes.length = 0;
    await page.goto("/platform/models");
    const form = page.getByRole("form", { name: "模型配置", exact: true });
    const action = form.getByRole("button", { name: "供应商", exact: true });
    const hint = form
      .locator("p")
      .filter({ has: page.getByRole("button", { name: "供应商", exact: true }) });
    await expect(hint).toBeVisible();
    expect((await hint.innerText()).replace(/\s/gu, "")).toBe("请先到供应商标签页添加供应商。");
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const lines = await hint.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.height / Number.parseFloat(getComputedStyle(element).lineHeight);
    });
    expect(lines).toBeLessThanOrEqual(width === 1440 ? 1.1 : 2.1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await form.screenshot({ path: testInfo.outputPath(`model-guidance-${width}.png`) });
    await action.click();
    await expect(page.getByRole("heading", { name: "模型供应商", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "模型选择", exact: true }).click();
    await page.keyboard.press("Tab");
    await action.focus();
    await expect(action).toBeFocused();
    await expect(action).toHaveCSS("outline-style", "solid");
    await action.press("Enter");
    await expect(page.getByRole("heading", { name: "模型供应商", exact: true })).toBeVisible();
  });
}

test("required model markers match validation and optional models can stay empty", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await page.goto("/platform/models");
  for (const [label, required] of [
    ["文案模型", true],
    ["生图模型", true],
    ["Embedding 模型", false],
    ["资料理解模型", false],
  ] as const) {
    const picker = page.getByRole("region", { name: label, exact: true });
    const title = picker.getByRole("heading", { level: 3 });
    await expect(title).toContainText(required ? "必填" : "可选");
    await expect(title.locator('[aria-hidden="true"]').filter({ hasText: /^\*$/u })).toHaveCount(
      required ? 1 : 0,
    );
    await expect(
      picker.getByRole("combobox", { name: `${label}供应商`, exact: true }),
    ).toHaveJSProperty("required", required);
    await expect(picker.getByRole("combobox", { name: label, exact: true })).toHaveJSProperty(
      "required",
      required,
    );
  }
  const embedding = page.getByRole("combobox", { name: "Embedding 模型", exact: true });
  await expect(embedding.locator("option:checked")).toHaveText("本地基础检索");
  await expect(
    page.getByRole("combobox", { name: "资料理解模型", exact: true }).locator("option:checked"),
  ).toHaveText("跟随文案模型");
  const embeddingProvider = page.getByLabel("Embedding 模型供应商", { exact: true });
  await embeddingProvider.selectOption("business");
  await expect(embedding).toHaveJSProperty("required", true);
  await expect(page.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
  await embeddingProvider.selectOption("");
  await page.getByRole("combobox", { name: "文案模型", exact: true }).selectOption("new-text");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("四项模型选择已统一生效");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ embeddingModel: null, materialAnalysisModel: null });
});

test("four models can be discovered, selected and saved together on one page", async ({ page }) => {
  const { writes, discoveries } = await fixture(page);
  await page.goto("/platform/models");
  for (const label of ["文案模型", "生图模型", "Embedding 模型", "资料理解模型"])
    await expect(
      page.getByRole("region", { name: label, exact: true }).getByRole("heading", { level: 3 }),
    ).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "模型供应商", exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "文案模型", exact: true }).selectOption("new-text");
  await page.getByRole("combobox", { name: "生图模型", exact: true }).selectOption("new-image");
  await page.getByLabel("Embedding 模型供应商", { exact: true }).selectOption("second");
  await page
    .getByRole("combobox", { name: "Embedding 模型", exact: true })
    .selectOption("BAAI/bge-m3");
  await page.getByLabel("资料理解模型供应商", { exact: true }).selectOption("business");
  await page
    .getByRole("combobox", { name: "资料理解模型", exact: true })
    .selectOption("new-vision");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("四项模型选择已统一生效");
  expect(writes).toEqual([
    {
      textModel: { providerId: "business", externalModelId: "new-text" },
      imageModel: { providerId: "business", externalModelId: "new-image" },
      embeddingModel: { providerId: "second", externalModelId: "BAAI/bge-m3" },
      materialAnalysisModel: { providerId: "business", externalModelId: "new-vision" },
    },
  ]);
  expect(discoveries).toContain("business");
  expect(discoveries).not.toContain("test");
  await expect(page).toHaveURL(/\/platform\/models$/u);
  await expect(
    page.getByRole("form", { name: "模型配置", exact: true }).getByRole("link"),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Embedding 模型", exact: true })).toHaveValue(
    "BAAI/bge-m3",
  );
  await expect(page.getByRole("combobox", { name: "资料理解模型", exact: true })).toHaveValue(
    "new-vision",
  );
});

test("switching supplier tabs keeps unsaved model selections", async ({ page }) => {
  const { writes } = await fixture(page);
  await page.goto("/platform/models");
  await page.getByRole("combobox", { name: "文案模型", exact: true }).selectOption("new-text");
  await page.getByRole("tab", { name: /^供应商/u }).click();
  await expect(page.getByRole("region", { name: "文案模型", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "模型供应商", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "模型选择", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "文案模型", exact: true })).toHaveValue(
    "new-text",
  );
  expect(writes).toHaveLength(0);
});

test("adding a provider immediately reads models without a registration step", async ({ page }) => {
  const { catalog, discoveries } = await fixture(page);
  await page.route("**/platform/model-providers", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.name).toBe("新的模型供应商");
    expect(body.apiKey).toBe("test-key-never-persisted");
    const p = provider("added", body.name);
    catalog.providers.push(p);
    await route.fulfill({ json: p });
  });
  await page.goto("/platform/models");
  await page.getByRole("tab", { name: /^供应商/u }).click();
  await page.getByRole("button", { name: "＋ 添加供应商", exact: true }).click();
  await page.getByLabel("供应商名称", { exact: true }).fill("新的模型供应商");
  await page.getByLabel("API 地址", { exact: true }).fill("https://new.example/v1");
  await page.getByLabel("API Key", { exact: true }).fill("test-key-never-persisted");
  await page.getByRole("button", { name: "连接并读取模型", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "模型选择", exact: true }).click();
  await page.getByLabel("Embedding 模型供应商", { exact: true }).selectOption("added");
  await page
    .getByRole("combobox", { name: "Embedding 模型", exact: true })
    .selectOption("BAAI/bge-m3");
  expect(discoveries).toContain("added");
  await expect(page.getByRole("combobox", { name: "文案模型", exact: true })).toHaveValue(
    "old-text",
  );
});

test("list failure retains configured choices and allows manual model IDs", async ({ page }) => {
  const { writes } = await fixture(page, true);
  await page.goto("/platform/models");
  await expect(page.getByRole("combobox", { name: "文案模型", exact: true })).toHaveValue(
    "old-text",
  );
  await page.getByLabel("Embedding 模型供应商", { exact: true }).selectOption("business");
  const picker = page.getByRole("region", { name: "Embedding 模型", exact: true });
  const manualToggle = picker.getByRole("button", { name: "找不到模型？手动输入 ID" });
  const modelField = await page
    .getByRole("combobox", { name: "Embedding 模型", exact: true })
    .boundingBox();
  const manualButton = await manualToggle.boundingBox();
  if (!modelField || !manualButton) throw new Error("Missing model picker controls");
  expect(manualButton.y).toBeGreaterThanOrEqual(modelField.y + modelField.height);
  await manualToggle.click();
  await page.getByLabel("Embedding 模型 ID", { exact: true }).fill("private-embedding");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已统一生效");
  expect(writes[0]?.embeddingModel?.externalModelId).toBe("private-embedding");
  expect(writes[0]?.materialAnalysisModel).toBeNull();
});

test("save failure keeps the draft and never reports a partial success", async ({ page }) => {
  await fixture(page);
  await page.route("**/platform/model-setup", (route) =>
    route.fulfill({ status: 409, json: { message: "所选供应商已停用" } }),
  );
  await page.goto("/platform/models");
  await page.getByRole("combobox", { name: "文案模型", exact: true }).selectOption("new-text");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "保存失败" })).toContainText(
    "原配置保持不变",
  );
  await expect(page.getByRole("combobox", { name: "文案模型", exact: true })).toHaveValue(
    "new-text",
  );
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("a lost save response does not claim that the previous configuration is unchanged", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/platform/model-setup", (route) => route.abort("failed"));
  await page.goto("/platform/models");
  await page.getByRole("combobox", { name: "文案模型", exact: true }).selectOption("new-text");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "暂未确认保存结果" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "文案模型", exact: true })).toHaveValue(
    "new-text",
  );
});

test("test records stay out of the main workflow and appear under advanced settings", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/platform/models");
  const testName = page.getByText("Sprint 6 Real Qualification Provider", { exact: true });
  await expect(testName).not.toBeVisible();
  await page.getByRole("tab", { name: /^供应商/u }).click();
  await page.getByText("开发与测试连接（1）", { exact: true }).click();
  await expect(testName).toBeVisible();
});

test("all four selectors and the provider drawer fit mobile and desktop", async ({ page }) => {
  await fixture(page);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/platform/models");
    await expect(page.getByRole("region", { name: "资料理解模型", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.getByRole("tab", { name: /^供应商/u }).click();
    await page.getByRole("button", { name: "＋ 添加供应商", exact: true }).click();
    await expect(page.getByLabel("API Key", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.getByRole("button", { name: "关闭添加供应商", exact: true }).click();
  }
});

test("discovery is not health; explicit checks update health and gate without paid calls", async ({
  page,
}) => {
  const { catalog } = await fixture(page);
  let calls = 0;
  let auditReads = 0;
  await page.route("**/platform/operations/production-readiness", (route) => {
    auditReads++;
    return route.fulfill({ json: { checks: [] } });
  });
  await page.route("**/platform/model-providers/*/test-connection", (route) => {
    calls++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().url()).toContain("/business/");
    catalog.providers[0].healthStatus = "HEALTHY";
    catalog.providers[0].lastHealthCheckedAt = new Date().toISOString();
    return route.fulfill({ json: { healthy: true } });
  });
  await page.goto("/platform/models");
  const connection = page.getByRole("region", { name: "连接检查", exact: true });
  await expect(connection.getByText("等待自动检查", { exact: true })).toBeVisible();
  expect(calls).toBe(0);
  await page.getByRole("button", { name: "检查已使用的供应商连接" }).click();
  await expect(connection.getByText("连接通过", { exact: true })).toBeVisible();
  await expect.poll(() => auditReads).toBeGreaterThan(1);
  expect(calls).toBe(1);
});

test("connection status refreshes automatically without manual or paid tests and preserves drafts", async ({
  page,
}) => {
  const { catalog } = await fixture(page);
  let reads = 0;
  let posts = 0;
  let connectionFails = false;
  catalog.providers[0].healthStatus = "HEALTHY";
  catalog.providers[0].lastHealthCheckedAt = new Date(Date.now() - 901_000).toISOString();
  await page.route("**/platform/model-catalog", (route) => {
    reads++;
    if (connectionFails) {
      catalog.providers[0].healthStatus = "UNHEALTHY";
      catalog.providers[0].lastHealthCheckedAt = new Date().toISOString();
    }
    return route.fulfill({ json: catalog });
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && /test-connection|qualify/u.test(request.url())) posts++;
  });
  await page.clock.install();
  await page.goto("/platform/models");
  const connection = page.getByRole("region", { name: "连接检查", exact: true });
  await expect(connection.getByText("连接通过", { exact: true })).toBeVisible();
  await expect(connection).toContainText("无需定时手动测试");
  await expect(connection).not.toContainText("900");
  connectionFails = true;
  await page.clock.fastForward(60_000);
  await expect(connection.getByText("未通过", { exact: true })).toBeVisible();
  const textModel = page.getByRole("combobox", { name: "文案模型", exact: true });
  await textModel.selectOption("new-text");
  const before = reads;
  await page.clock.fastForward(120_000);
  await expect(textModel).toHaveValue("new-text");
  expect(reads).toBe(before);
  expect(posts).toBe(0);
});

test("qualification requires saved configuration and confirmation, displays failure then success", async ({
  page,
}) => {
  const { catalog } = await fixture(page);
  let calls = 0;
  await page.route("**/platform/model-routes/*/qualify", async (route) => {
    calls++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    const result = {
      status: calls === 1 ? "FAILED" : "PASSED",
      errorCode: calls === 1 ? "HTTP_403" : null,
      errorMessage: calls === 1 ? "图片模型无访问权限" : null,
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      deliveryMode: "DEVELOPMENT",
      textLatencyMs: 2300,
      imageLatencyMs: calls === 1 ? null : 1500,
      storageVerified: calls !== 1,
      diagnostics:
        calls === 1
          ? {
              steps: { CONNECTION: "PASSED", TEXT: "PASSED", IMAGE: "FAILED", STORAGE: "NOT_RUN" },
              request: {
                requestPath: "/images/generations",
                httpStatus: 404,
                upstreamStage: "cpa_absorption_pending",
                requestId: "request-diagnostic-1",
              },
            }
          : {},
    };
    catalog.routes[0].qualification = result;
    await route.fulfill({ json: result });
  });
  await page.goto("/platform/models");
  const button = page.getByRole("button", { name: "执行功能验证（可能计费）" });
  await expect(button).toBeEnabled();
  expect(calls).toBe(0);
  await page.getByRole("combobox", { name: "文案模型", exact: true }).selectOption("new-text");
  await expect(button).toBeDisabled();
  await page.getByRole("combobox", { name: "文案模型", exact: true }).selectOption("old-text");
  page.once("dialog", (dialog) => dialog.dismiss());
  await button.click();
  expect(calls).toBe(0);
  page.once("dialog", (dialog) => dialog.accept());
  await button.click();
  await expect(page.getByRole("status")).toContainText("功能验证未通过（HTTP_403）");
  await expect(
    page.getByText("连接：通过；文案：通过；生图：失败；存储回读：未执行", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("供应商请求编号：request-diagnostic-1", { exact: true }),
  ).toBeVisible();
  await expect(button).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await button.click();
  await expect(page.getByRole("status")).toContainText("功能验证通过");
  expect(calls).toBe(2);
  await page.reload();
  await expect(page.getByText(/最近验证：通过/)).toBeVisible();
});

for (const width of [390, 1440]) {
  test(`text-only qualification sends its scope and keeps AI images unqualified at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const { catalog } = await fixture(page);
    catalog.routes[0].imageModel.status = "DISABLED";
    const bodies: unknown[] = [];
    await page.route("**/platform/model-routes/default-route/qualify", (route) => {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          status: "PASSED",
          checkedAt: new Date().toISOString(),
          expiresAt: null,
          deliveryMode: "PRODUCTION",
          errorCode: null,
          errorMessage: null,
          textLatencyMs: 10,
          imageLatencyMs: null,
          storageVerified: false,
          diagnostics: {
            requiredCapabilities: ["TEXT"],
            textConfigurationFingerprint: "verified-text-only",
            steps: { CONNECTION: "PASSED", TEXT: "PASSED", IMAGE: "NOT_RUN", STORAGE: "NOT_RUN" },
          },
        },
      });
    });
    await page.goto("/platform/models#verification");
    const button = page.getByRole("button", { name: "仅验收文案（可能计费）", exact: true });
    await expect(button).toBeEnabled();
    await button.focus();
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS("outline-style", "solid");
    page.once("dialog", (dialog) => dialog.accept());
    await button.click();
    expect(bodies).toEqual([{ requiresImage: false }]);
    await expect(page.getByRole("status")).toContainText("仅文案验收通过");
    const section = page.getByRole("region", { name: "模型连接与功能验证" });
    await expect(section).toContainText("验收范围：仅文案（TEXT）");
    await expect(section).toContainText("AI 插画未验收");
    await expect(section).toContainText("存储回读：未执行");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await section.screenshot({ path: testInfo.outputPath(`text-only-qualification-${width}.png`) });
  });
}

for (const width of [390, 1440]) {
  test(`dynamic gate and email retry are clear at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const { catalog } = await fixture(page);
    catalog.routes[0].runtimeHealth = {
      state: "REVALIDATION_REQUIRED",
      failureThreshold: 3,
      textFailures: 0,
      imageFailures: 3,
      notificationStatus: "EXHAUSTED",
      lastSuccessAt: null,
      lastFailureAt: new Date().toISOString(),
    };
    let retries = 0;
    let qualifications = 0;
    await page.route("**/platform/model-routes/default-route/retry-notification", (route) => {
      retries++;
      catalog.routes[0].runtimeHealth = {
        ...catalog.routes[0].runtimeHealth,
        notificationStatus: "PENDING",
      };
      return route.fulfill({ json: { queued: true } });
    });
    await page.route("**/platform/model-routes/default-route/qualify", (route) => {
      qualifications++;
      return route.fulfill({ status: 500 });
    });
    await page.goto("/platform/models#verification");
    await expect(page.getByText("连续失败 · 需要功能复验", { exact: true })).toBeVisible();
    await expect(page.getByText("管理员邮件：多次发送失败", { exact: false })).toBeVisible();
    const button = page.getByRole("button", { name: "重试邮件通知", exact: true });
    await expect(button).toBeEnabled();
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    if (!box) throw new Error("Missing button bounds");
    expect(box.height).toBeGreaterThanOrEqual(36);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await button.focus();
    await expect(button).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`dynamic-gate-${width}.png`),
      fullPage: true,
    });
    await button.click();
    await expect(page.getByText("管理员邮件：等待发送", { exact: true })).toBeVisible();
    expect(retries).toBe(1);
    expect(qualifications).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  });
}
