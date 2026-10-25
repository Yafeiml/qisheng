import { expect, type Page, test } from "@playwright/test";
import { defaultGenerationStyles } from "../../packages/ai-gateway/src/generation-style";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
    ),
  );
  await page.route(/:3100\//u, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked API" } }),
  );
  await page.route("**/campaign-planning/medical-options", (route) =>
    route.fulfill({ json: { enabled: false } }),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "mock-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/account", (route) =>
    route.fulfill({
      json: {
        name: "生成风格验收管理员",
        email: "styles@example.test",
        emailVerifiedAt: "2026-10-09T00:00:00Z",
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
          { scopeType: "PLATFORM", permissions: ["platform.settings.manage"] },
          {
            scopeType: "ENTERPRISE",
            role: { name: "企业管理员", code: "ENTERPRISE_ADMIN" },
            tenant: { id: "tenant", name: "测试集团" },
            enterprise: { id: "enterprise", name: "测试企业", tenantId: "tenant" },
            permissions: ["campaign.read", "campaign.manage"],
          },
        ],
      },
    }),
  );
});

async function adminFixture(page: Page) {
  let config = { ...defaultGenerationStyles(), version: 0 };
  const writes: (typeof config)[] = [];
  await page.route("**/platform/generation-styles", (route) => {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON();
      writes.push(input);
      config = { ...input, version: config.version + 1 };
    }
    return route.fulfill({ json: config });
  });
  return { writes };
}

test("failed initial loads stop the loading indicator and can be retried", async ({ page }) => {
  let failRequests = true;
  await page.route("**/platform/generation-styles", (route) => {
    return failRequests
      ? route.fulfill({ status: 500, json: { message: "Internal server error" } })
      : route.fulfill({ json: { ...defaultGenerationStyles(), version: 0 } });
  });
  await page.goto("/platform/settings/content-style");
  await expect(page.getByRole("alert").filter({ hasText: "Internal server error" })).toBeVisible();
  await expect(page.getByText("正在加载预设…", { exact: true })).toHaveCount(0);
  failRequests = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.getByRole("button", { name: "新增内容方向", exact: true })).toBeVisible();
  await expect(page.getByText("Internal server error", { exact: true })).toHaveCount(0);
});

test("administrator adds, edits, sorts, defaults and disables presets", async ({ page }) => {
  const { writes } = await adminFixture(page);
  await page.goto("/platform/settings/content-style");
  await page.getByRole("button", { name: "新增内容方向", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel("预设名称", { exact: true }).fill("理性选择指南");
  await drawer.getByLabel("简短说明", { exact: true }).fill("帮助读者做好选择前的功课");
  await drawer
    .getByLabel("生成提示词", { exact: true })
    .fill("从决策前需要了解的问题出发，提供具体、理性、有依据的建议。");
  await drawer.getByRole("button", { name: "保存预设", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  const card = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "理性选择指南", exact: true }) });
  await card.getByRole("button", { name: "设为默认", exact: true }).click();
  await expect(card.getByText("默认", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "停用", exact: true })).toBeDisabled();
  await card.getByRole("button", { name: "上移理性选择指南" }).click();
  await expect.poll(() => writes.at(-1)?.contentDirections[2]?.name).toBe("理性选择指南");
  await card.getByRole("button", { name: "编辑", exact: true }).click();
  await drawer
    .getByLabel("生成提示词", { exact: true })
    .fill("更新后的选择指南，必须以品牌事实为依据，使用自然的小红书口吻。");
  await drawer.getByRole("button", { name: "保存预设", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  const old = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "专业科普", exact: true }) });
  await old.getByRole("button", { name: "停用", exact: true }).click();
  await expect(old.getByText("已停用", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "理性选择指南", exact: true })).toBeVisible();
  expect(writes.at(-1)?.contentDirections.find((p) => p.name === "理性选择指南")?.prompt).toContain(
    "更新后",
  );
});

test("both preset drawers keep checkboxes and save buttons usable at desktop and mobile widths", async ({
  page,
}, testInfo) => {
  await adminFixture(page);
  await page.goto("/platform/settings/content-style");
  await expect(page.getByRole("heading", { level: 1, name: "生成风格" })).toBeVisible();
  for (const kind of ["内容方向", "图片风格"] as const) {
    if (kind === "图片风格") await page.getByRole("tab", { name: /图片风格/u }).click();
    await page.getByRole("button", { name: `新增${kind}`, exact: true }).click();
    const drawer = page.getByRole("dialog");
    const enabled = drawer.getByRole("checkbox", { name: "启用，供新活动选择" });
    const defaultOption = drawer.getByRole("checkbox", { name: "设为默认" });
    const saveButton = drawer.getByRole("button", { name: "保存预设" });
    await enabled.scrollIntoViewIfNeeded();
    await expect(enabled).toBeChecked();
    await expect(defaultOption).toBeEnabled();
    await enabled.uncheck();
    await expect(defaultOption).toBeDisabled();
    await enabled.check();
    await defaultOption.check();
    await expect(enabled).toBeDisabled();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await expect(page.getByRole("heading", { level: 1, name: "生成风格" })).toBeVisible();
      await saveButton.scrollIntoViewIfNeeded();
      const checkboxBox = await enabled.boundingBox();
      const buttonBox = await saveButton.boundingBox();
      const drawerBox = await drawer.boundingBox();
      expect(checkboxBox?.width).toBe(16);
      expect(checkboxBox?.height).toBe(16);
      expect(buttonBox?.width).toBeLessThan(260);
      expect(buttonBox?.x ?? 0).toBeGreaterThanOrEqual(drawerBox?.x ?? 0);
      expect((buttonBox?.x ?? 0) + (buttonBox?.width ?? 0)).toBeLessThanOrEqual(
        (drawerBox?.x ?? 0) + (drawerBox?.width ?? 0),
      );
      await page.screenshot({ path: testInfo.outputPath(`${kind}-${width}.png`) });
    }
    await drawer.getByRole("button", { name: `关闭编辑${kind}` }).click();
  }
});

test("base prompts save separately and both tabs fit small screens", async ({ page }) => {
  const { writes } = await adminFixture(page);
  await page.goto("/platform/settings/content-style");
  await page.getByText("文案基础要求", { exact: false }).click();
  await page
    .getByLabel("文案基础提示词", { exact: true })
    .fill("新文案基础要求：自然口语化，短段落，适量使用 Emoji。");
  await page.getByRole("tab", { name: /图片风格/u }).click();
  await page.getByRole("button", { name: "新增图片风格", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel("预设名称", { exact: true }).fill("柔和暖光摄影");
  await drawer
    .getByLabel("生成提示词", { exact: true })
    .fill("柔和自然的暖光摄影，突出主题，构图简洁。");
  await drawer.getByRole("button", { name: "保存预设", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  expect(writes[0]?.copyBasePrompt).not.toContain("新文案基础要求");
  await page.getByRole("tab", { name: /内容方向/u }).click();
  await expect(page.getByLabel("文案基础提示词", { exact: true })).toHaveValue(/新文案基础要求/u);
  await page.getByRole("button", { name: "保存基础要求", exact: true }).click();
  await expect.poll(() => writes.at(-1)?.copyBasePrompt).toContain("新文案基础要求");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("failed saves keep the editor draft and never report success", async ({ page }) => {
  await adminFixture(page);
  await page.goto("/platform/settings/content-style");
  await page
    .getByRole("article")
    .first()
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await page.route("**/platform/generation-styles", (route) =>
    route.fulfill({ status: 409, json: { message: "配置已被其他管理员修改，请刷新后重新编辑" } }),
  );
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel("生成提示词", { exact: true }).fill("待保存但未成功的提示词内容。");
  await drawer.getByRole("button", { name: "保存预设", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "其他管理员修改" })).toBeVisible();
  await expect(drawer.getByLabel("生成提示词", { exact: true })).toHaveValue(
    "待保存但未成功的提示词内容。",
  );
  await expect(page.getByRole("status")).toHaveCount(0);
});

async function campaignFixture(page: Page, disabledDraft = false) {
  await page.route("**/auth/admin/account", (route) =>
    route.fulfill({
      json: {
        name: "活动验收管理员",
        email: "campaign@example.test",
        emailVerifiedAt: "2026-10-09T00:00:00.000Z",
      },
    }),
  );
  let payload: Record<string, unknown> = disabledDraft
    ? {
        title: "已保存的活动草稿",
        prompt: "介绍品牌产品特点与真实使用场景",
        contentDirectionPresetId: "removed",
        imageStylePresetId: "image-documentary",
        promptTemplateId: "retired-prompt-template",
      }
    : {};
  const writes: Record<string, unknown>[] = [];
  const templateWrites: { path: string; body: Record<string, unknown> }[] = [];
  let promptTemplates: Record<string, unknown>[] = [];
  let campaignTemplates: Record<string, unknown>[] = [];
  await page.route("**/console/tenants/tenant/enterprises/enterprise/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = [];
    if (path.endsWith("/workspace"))
      json = {
        steps: [],

        capabilities: { imagesPerDistribution: 1 },
        counts: { effectiveMaterials: 1 },
      };
    else if (path.endsWith("/memberships"))
      json = { items: [], pageInfo: { hasNextPage: false, nextCursor: null } };
    else if (path.endsWith("/generation-status"))
      json = { checkedAt: new Date().toISOString(), affectedEnterpriseCount: 0, notices: [] };
    else if (path.endsWith("/generation-styles"))
      json = { ...defaultGenerationStyles(), version: 1 };
    else if (path.endsWith("/prompt-templates")) {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        templateWrites.push({ path, body });
        const created = { ...body, id: "saved-prompt", status: "ACTIVE" };
        promptTemplates = [created];
        return route.fulfill({ json: created });
      }
      json = promptTemplates;
    } else if (path.endsWith("/campaign-templates")) {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        templateWrites.push({ path, body });
        const created = { ...body, id: "saved-campaign", status: "ACTIVE" };
        campaignTemplates = [created];
        return route.fulfill({ json: created });
      }
      json = campaignTemplates;
    } else if (path.endsWith("/draft")) {
      if (route.request().method() === "POST") {
        payload = route.request().postDataJSON();
        writes.push(payload);
      }
      json = {
        draft: Object.keys(payload).length
          ? { payload, step: 1, updatedAt: new Date().toISOString() }
          : null,
      };
    }
    return route.fulfill({ json });
  });
  return { writes, templateWrites };
}

for (const width of [1440, 390]) {
  test(`campaign style and prompt templates survive save, restore and copy at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const { writes, templateWrites } = await campaignFixture(page);
    await page.goto("/console/campaigns/new");
    await page.getByLabel("活动名称", { exact: true }).fill("品牌新品分享");
    const brief = page.getByRole("textbox", { name: "主题和传播目标", exact: true });
    await brief.fill("用朋友聊天的语气介绍产品使用场景，配简洁插画");
    const direction = page.getByRole("combobox", { name: "内容方向", exact: true });
    const image = page.getByRole("combobox", { name: "图片风格", exact: true });
    await direction.selectOption("direction-questions");
    await image.selectOption("image-illustration");
    await expect(direction).toHaveCSS("appearance", "none");
    await expect(image).toHaveCSS("appearance", "none");
    await page.getByRole("button", { name: "保存传播要求模板", exact: true }).click();
    let drawer = page.getByRole("dialog", { name: "保存传播要求模板", exact: true });
    await drawer.getByLabel("模板名称", { exact: true }).fill("聊天式分享");
    const save = drawer.getByRole("button", { name: "保存并立即使用", exact: true });
    expect((await save.boundingBox())?.width).toBeLessThan(300);
    await save.click();
    await expect(drawer).toHaveCount(0);
    expect(templateWrites[0]?.body).toMatchObject({
      contentDirectionPresetId: "direction-questions",
      content: "用朋友聊天的语气介绍产品使用场景，配简洁插画",
    });
    await expect(page.getByRole("combobox", { name: "传播要求模板" })).toHaveValue("saved-prompt");
    await expect.poll(() => writes.at(-1)?.contentDirectionPresetId).toBe("direction-questions");
    expect(writes.at(-1)?.imageStylePresetId).toBe("image-illustration");
    expect(writes.at(-1)?.promptTemplateId).toBe("saved-prompt");
    await page.getByRole("button", { name: "保存为活动模板", exact: true }).click();
    drawer = page.getByRole("dialog", { name: "保存活动模板", exact: true });
    await drawer.getByLabel("模板名称", { exact: true }).fill("每月品牌活动");
    await drawer.getByRole("button", { name: "保存并立即使用", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    expect(templateWrites[1]?.body).toMatchObject({
      contentDirectionPresetId: "direction-questions",
      imageStylePresetId: "image-illustration",
      promptTemplateId: "saved-prompt",
    });
    await expect.poll(() => writes.at(-1)?.campaignTemplateId).toBe("saved-campaign");
    await page.reload();
    await expect(brief).toHaveValue("用朋友聊天的语气介绍产品使用场景，配简洁插画");
    await expect(direction).toHaveValue("direction-questions");
    await expect(image).toHaveValue("image-illustration");
    await brief.fill("手动调整后再套用传播要求");
    await page.getByRole("combobox", { name: "传播要求模板" }).selectOption("");
    await page.getByRole("combobox", { name: "传播要求模板" }).selectOption("saved-prompt");
    await expect(brief).toHaveValue("用朋友聊天的语气介绍产品使用场景，配简洁插画");
    await page.route("**/campaigns/history/copy-input", (route) =>
      route.fulfill({
        json: {
          title: "复制品牌活动",
          prompt: "复制保留本期内容目标",
          visibleAt: new Date(Date.now() + 10 * 3600000).toISOString(),
          imageCount: 1,
          audienceMode: "ALL",
          membershipIds: [],
          reminderOffsetsHours: [6],
          contentDirectionPresetId: "direction-questions",
          imageStylePresetId: "image-illustration",
        },
      }),
    );
    await page.goto("/console/campaigns/new?copyFrom=history");
    await expect(brief).toHaveValue("复制保留本期内容目标");
    await expect(direction).toHaveValue("direction-questions");
    await expect(image).toHaveValue("image-illustration");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`generic-styles-${width}.png`),
      fullPage: true,
    });
  });
}

test("a retired preset remains visible in a restored draft and must be reselected", async ({
  page,
}) => {
  const { writes } = await campaignFixture(page, true);
  await page.goto("/console/campaigns/new");
  await expect(page.getByRole("textbox", { name: "主题和传播目标", exact: true })).toHaveValue(
    "介绍品牌产品特点与真实使用场景",
  );
  const direction = page.getByRole("combobox", { name: "内容方向", exact: true });
  await expect(direction).toHaveValue("removed");
  await expect(direction.locator('option[value="removed"]')).toHaveAttribute("disabled", "");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "请重新选择可用" })).toBeVisible();
  await direction.selectOption("direction-questions");
  await page.getByRole("combobox", { name: "传播要求模板" }).selectOption("");
  await expect.poll(() => writes.at(-1)?.contentDirectionPresetId).toBe("direction-questions");
  expect(writes.at(-1)).not.toHaveProperty("promptTemplateId");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "选择收到本期内容的员工", exact: true }),
  ).toBeVisible();
});
