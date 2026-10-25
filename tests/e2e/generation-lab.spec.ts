import { expect, type Page, test } from "@playwright/test";
import { newMedicalSelection } from "../../apps/admin-web/app/lib/medical-selection";
import type { Run } from "../../apps/admin-web/app/platform/generation-lab/types";
import { defaultGenerationStyles } from "../../packages/ai-gateway/src/generation-style";

async function fixture(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
    ),
  );
  await page.route(/:3100\//u, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked API" } }),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "mock-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/account", (route) =>
    route.fulfill({
      json: {
        name: "实验室验收管理员",
        email: "lab@example.test",
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
            scopeType: "PLATFORM",
            permissions: ["platform.model.manage", "platform.settings.manage"],
          },
          {
            scopeType: "ENTERPRISE",
            role: { name: "企业管理员", code: "ENTERPRISE_ADMIN" },
            tenant: { id: "tenant", name: "集团" },
            enterprise: { id: "enterprise", name: "测试企业", tenantId: "tenant" },
            permissions: ["campaign.read"],
          },
        ],
      },
    }),
  );
  const styles = { ...defaultGenerationStyles(), version: 3 };
  const direction = styles.contentDirections[0];
  const imageStyle = styles.imageStyles[0];
  if (!direction || !imageStyle) throw new Error("Missing default style fixture");
  const rows: Run[] = [];
  const writes: { action: string; copy?: { body: string } }[] = [];
  const checks: Record<string, unknown>[] = [];
  let reviews = 0;
  await page.route("**:3100/platform/generation-lab**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/platform/generation-lab", "");
    if (path === "/options")
      return route.fulfill({
        json: {
          enterprises: [{ id: "enterprise", name: "测试企业", tenant: { name: "测试集团" } }],
          styles,
        },
      });
    if (path === "/medical-options") return route.fulfill({ json: { enabled: false } });
    if (!path) return route.fulfill({ json: [...rows].reverse() });
    if (path === "/check") {
      const input = route.request().postDataJSON();
      checks.push(input);
      const run: Run = {
        id: `run-${rows.length + 1}`,
        title: input.title,
        status: "DRAFT",
        action: "COPY",
        enterpriseId: input.enterpriseId,
        parentId: null,
        createdAt: "2026-09-28T09:00:00.000Z",
        reviewStatus: "NONE",
        error: null,
        result: null,
        review: null,
        assets: [],
        calls: [],
        input: {
          brief: input.brief,
          keywords: input.keywords,
          enterpriseName: "测试企业",
          generationStyle: {
            configurationVersion: 3,
            copyBasePrompt: styles.copyBasePrompt,
            imageBasePrompt: styles.imageBasePrompt,
            contentDirection:
              styles.contentDirections.find(
                (preset) => preset.id === input.contentDirectionPresetId,
              ) ?? direction,
            imageStyle:
              styles.imageStyles.find((preset) => preset.id === input.imageStylePresetId) ??
              imageStyle,
          },
          retrieval: {
            query: "专家科普",
            hits: [
              {
                materialId: "m",
                materialTitle: "专家资料",
                snippet: "专家从业资料，规范科普知识。",
                score: 0.93,
              },
            ],
            images: [1, 2, 3, 4]
              .map((n) => ({
                artifactId: `ref-${n}`,
                title: `参考图 ${n}`,
                description: "人物主体照片",
                usage: "REFERENCE",
              }))
              .concat([
                {
                  artifactId: "logo",
                  title: "企业标识",
                  description: "原版品牌标识",
                  usage: "LOGO",
                },
              ]),
          },
          imageAssets: [
            { artifactId: "ref-1", usage: "REFERENCE", description: "人物" },
            { artifactId: "logo", usage: "LOGO", description: "标识" },
          ],
          route: {
            text: { primary: { externalModelId: "configured-text-model" } },
            image: { primary: { externalModelId: "configured-image-model" } },
          },
        },
      };
      rows.push(run);
      return route.fulfill({ json: run });
    }
    const [, id, action] = path.split("/");
    const run = rows.find((r) => r.id === id);
    if (!run) return route.fulfill({ status: 404, json: { message: "不存在" } });
    if (action === "images")
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480"><rect width="360" height="480" fill="#e8f0ed"/><circle cx="180" cy="200" r="90" fill="#c1d5cc"/><text x="70" y="360" font-size="24" fill="#246a59">品牌科普海报</text></svg>',
      });
    if (action === "execute") {
      const data = route.request().postDataJSON();
      writes.push(data);
      run.status = "SUCCEEDED";
      run.action = data.action;
      run.result = {
        copy: data.copy ?? {
          title: "专业科普知识",
          body: "从真实资料出发，讲清重要的科普知识，帮助读者理性了解。",
          hashtags: ["科普"],
          imagePrompt: "保留主体，简洁海报，留白充足",
        },
      };
      if (data.action !== "COPY")
        run.assets.push({
          id: `poster-${id}`,
          kind: "POSTER",
          description: "海报",
          checksum: "checksum",
        });
      run.calls.push({
        id: `call-${id}`,
        kind: data.action === "COPY" ? "TEXT" : "IMAGE",
        modelId: "configured-model",
        providerId: "p",
        request: {
          prompt: "实际发给模型的提示词",
          referenceImages: [{ checksum: "reference-checksum" }],
        },
        usage: { estimatedCost: null, inputUnits: 120, outputUnits: 90 },
        latencyMs: 1200,
        status: "SUCCEEDED",
      });
      return route.fulfill({ json: run });
    }
    if (action === "fork") {
      const next = structuredClone(run);
      next.id = `run-${rows.length + 1}`;
      next.parentId = run.id;
      next.status = "DRAFT";
      next.input.copy = run.result?.copy;
      next.result = null;
      next.reviewStatus = "NONE";
      next.review = null;
      next.assets = [];
      next.calls = [];
      rows.push(next);
      return route.fulfill({ json: next });
    }
    if (action === "review") {
      reviews++;
      run.reviewStatus = "DONE";
      run.review = { decision: "PASS", categories: [] };
      return route.fulfill({ json: run });
    }
    if (action === "promote") return route.fulfill({ json: { version: 4 } });
    if (action === "assets") {
      run.assets.push({
        id: "temporary",
        kind: "REFERENCE",
        description: "临时人物照片",
        checksum: "hash",
      });
      return route.fulfill({ json: run });
    }
    return route.fulfill({ json: run });
  });
  return { rows, writes, checks, styles, reviewCount: () => reviews };
}

async function create(page: Page) {
  await page.goto("/platform/generation-lab");
  await expect(page.getByRole("heading", { name: "生成测试台", exact: true })).toBeVisible();
  await page.getByLabel("测试企业", { exact: true }).selectOption("enterprise");
  await page.getByLabel("测试名称", { exact: true }).fill("专家科普海报测试");
  await page
    .getByLabel("活动需求", { exact: true })
    .fill("为专家生成一篇有依据的科普文案与简洁海报");
  await page
    .getByRole("combobox", { name: "内容方向", exact: true })
    .selectOption("direction-questions");
  await page
    .getByRole("combobox", { name: "图片风格", exact: true })
    .selectOption("image-illustration");
  await page.getByLabel("素材检索关键词", { exact: true }).fill("授权产品资料");
  await page.getByRole("button", { name: "检查素材", exact: true }).click();
  await expect(page.getByRole("button", { name: "完整测试", exact: true })).toBeVisible();
}

for (const width of [1440, 390])
  test(`selection, generation, reuse, comparison and save work at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixture(page);
    await create(page);
    expect(f.checks[0]).toMatchObject({
      contentDirectionPresetId: "direction-questions",
      imageStylePresetId: "image-illustration",
      keywords: "授权产品资料",
    });
    expect(f.checks[0]).not.toHaveProperty("selection");
    const checkboxes = page.getByRole("checkbox");
    await expect(checkboxes).toHaveCount(4);
    await checkboxes.nth(1).check();
    await checkboxes.nth(2).check();
    await expect(checkboxes.nth(3)).toBeDisabled();
    const metrics = await checkboxes.nth(0).evaluate((el) => {
      const box = el.getBoundingClientRect();
      if (!el.nextElementSibling) throw new Error("Missing selection label");
      const text = el.nextElementSibling.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        delta: Math.abs(box.y + box.height / 2 - text.y - text.height / 2),
      };
    });
    expect(metrics.width).toBe(17);
    expect(metrics.height).toBe(17);
    expect(metrics.delta).toBeLessThan(3);
    await page.getByRole("button", { name: "生成文案", exact: true }).click();
    await expect(page.getByRole("button", { name: "复制版本继续调整", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "审核一次", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "复制版本继续调整", exact: true }).click();
    await page
      .getByLabel("正文", { exact: true })
      .fill("用户调整后的文案，需要复用，不能重新调用文案模型。");
    await page.getByRole("button", { name: "生成海报", exact: true }).click();
    expect(f.writes.at(-1)?.action).toBe("IMAGE");
    expect(f.writes.at(-1)?.copy?.body).toContain("用户调整后的文案");
    await page.getByRole("button", { name: "审核一次", exact: true }).click();
    await expect(page.getByText("整体审核：通过", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "审核一次", exact: true })).toBeDisabled();
    expect(f.reviewCount()).toBe(1);
    await page.getByRole("button", { name: "与当前对比", exact: true }).last().click();
    const drawer = page.getByRole("dialog", { name: "版本对比" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("article")).toHaveCount(2);
    if (width > 1000) {
      const cards = await drawer
        .getByRole("article")
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().x));
      expect(Number(cards[1]) - Number(cards[0])).toBeGreaterThan(250);
    }
    await page.getByRole("button", { name: "关闭版本对比", exact: true }).click();
    await page.getByRole("button", { name: "保存为正式配置", exact: true }).click();
    const save = page.getByRole("dialog", { name: "保存为正式配置" });
    await save.getByLabel("保存类型", { exact: true }).selectOption("GLOBAL");
    await save.getByLabel("名称", { exact: true }).fill("验证后的基础提示词");
    await expect(save.getByText(/将更新所有企业/u)).toBeVisible();
    await save.getByRole("button", { name: "确认保存", exact: true }).click();
    await expect(save).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`lab-${width}.png`), fullPage: true });
  });

test("starting a generic test from medical history clears the frozen internal brief", async ({
  page,
}) => {
  const f = await fixture(page);
  await create(page);
  const historical = f.rows[0];
  if (!historical) throw new Error("Missing historical fixture");
  historical.input.selectionSnapshot = newMedicalSelection();
  historical.input.brief = "内部医疗计划，不能复制为新活动要求";
  historical.title = "旧医疗测试";
  await page.goto(`/platform/generation-lab?run=${historical.id}`);
  await expect(page.getByRole("textbox", { name: "活动需求", exact: true })).toHaveValue(
    historical.input.brief,
  );
  await page.getByRole("button", { name: "新建测试", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "活动需求", exact: true })).toHaveValue("");
  await expect(page.getByLabel("测试名称", { exact: true })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "内容方向", exact: true })).toHaveValue(
    f.styles.contentDirections.find((preset) => preset.isDefault)?.id ?? "",
  );
  await expect(page.getByRole("combobox", { name: "图片风格", exact: true })).toHaveValue(
    f.styles.imageStyles.find((preset) => preset.isDefault)?.id ?? "",
  );
  expect(f.checks).toHaveLength(1);
  expect(historical.input.selectionSnapshot).toEqual(newMedicalSelection());
});

test("temporary reference upload has an explicit description and styled action", async ({
  page,
}) => {
  await fixture(page);
  await create(page);
  await page.getByLabel("临时参考图说明", { exact: true }).fill("临时人物照片");
  await page.locator('input[type="file"]').setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: Buffer.from("fake-image-only-ui-test"),
  });
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByText("仅用于本次测试", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "移除 临时人物照片" })).toBeVisible();
});
