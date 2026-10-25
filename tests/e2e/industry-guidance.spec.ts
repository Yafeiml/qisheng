import { expect, type Page, test } from "@playwright/test";

async function fixture(page: Page, canManage = true, failSave = false) {
  await page.addInitScript(() =>
    localStorage.setItem("xhs-agentic:mvp-session:v1", JSON.stringify({ mode: "FORMAL" })),
  );
  await page.route(/:3100\//u, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked industry fixture request" } }),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "isolated-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/account", (route) =>
    route.fulfill({
      json: {
        name: "行业管理员",
        email: "industry@example.test",
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
            scopeType: "PLATFORM",
            role: { code: "PLATFORM_ADMIN", name: "平台管理员" },
            permissions: canManage
              ? ["platform.tenant.read", "platform.tenant.manage"]
              : ["platform.tenant.read"],
          },
        ],
      },
    }),
  );
  await page.route("**/generation-status", (route) =>
    route.fulfill({ json: { affectedEnterpriseCount: 0, notices: [] } }),
  );
  const date = "2026-10-10T08:00:00.000Z";
  const industries = [
    {
      id: "medical",
      name: "医疗健康",
      sortOrder: 100,
      createdAt: date,
      updatedAt: date,
      generationGuidance:
        "优先核对正式身份、设备型号和诊疗流程。手术量保留统计时间和主体，不作疗效保证。",
    },
    {
      id: "food",
      name: "餐饮",
      sortOrder: 200,
      createdAt: date,
      updatedAt: date,
      generationGuidance: "",
    },
  ];
  const saves: Array<Record<string, unknown>> = [];
  await page.route("**/api/platform/industries", (route) => route.fulfill({ json: industries }));
  await page.route("**/api/platform/industries/medical/generation-guidance", async (route) => {
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    saves.push(body);
    if (failSave) {
      await route.fulfill({
        status: 409,
        json: { message: "行业规则已被其他管理员修改，请刷新后重新编辑" },
      });
      return;
    }
    Object.assign(industries[0], {
      generationGuidance: body.generationGuidance,
      updatedAt: new Date(Date.parse(industries[0].updatedAt) + 1000).toISOString(),
    });
    await route.fulfill({ json: industries[0] });
  });
  return { saves, industries };
}

for (const width of [1440, 390, 320]) {
  test(`edits, persists and clears industry guidance at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixture(page);
    await page.goto("/platform/industries");
    await expect(page.getByRole("heading", { name: "行业管理", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "编辑医疗健康的补充规则" }).click();
    const dialog = page.getByRole("dialog");
    const rules = dialog.getByRole("textbox", { name: "行业补充规则", exact: true });
    await expect(rules).toHaveValue(f.industries[0].generationGuidance);
    await expect(dialog.getByRole("button", { name: "保存规则" })).toBeDisabled();
    await rules.fill(
      "展示准确主体身份和两三个可核对的重点，认证保留正式名称，不扩大技术与数据口径。",
    );
    const save = dialog.getByRole("button", { name: "保存规则" });
    await expect(save).toBeEnabled();
    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    const [saveBox, cancelBox, footerBox] = await Promise.all([
      save.boundingBox(),
      cancel.boundingBox(),
      dialog.locator(".workspaceDrawerFooter").boundingBox(),
    ]);
    if (!saveBox || !cancelBox || !footerBox) throw new Error("Drawer actions did not render");
    const gap = Math.max(
      saveBox.x - cancelBox.x - cancelBox.width,
      saveBox.y - cancelBox.y - cancelBox.height,
    );
    expect(gap).toBeGreaterThanOrEqual(8);
    for (const box of [cancelBox, saveBox]) {
      expect(box.x).toBeGreaterThanOrEqual(footerBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(footerBox.x + footerBox.width);
      expect(box.height).toBeGreaterThanOrEqual(40);
    }
    await cancel.focus();
    await page.keyboard.press("Tab");
    await expect(save).toBeFocused();
    expect((await save.boundingBox())?.height).toBeGreaterThanOrEqual(40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`industry-editor-${width}.png`) });
    await save.click();
    await expect(dialog).toHaveCount(0);
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0].expectedUpdatedAt).toBe("2026-10-10T08:00:00.000Z");
    await page.reload();
    await page.getByRole("button", { name: "编辑医疗健康的补充规则" }).click();
    await expect(rules).toHaveValue(
      "展示准确主体身份和两三个可核对的重点，认证保留正式名称，不扩大技术与数据口径。",
    );
    await rules.fill("");
    await save.click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.locator(".industryOption").filter({ has: page.getByText("医疗健康", { exact: true }) }),
    ).toContainText("通用规则");
    expect(f.saves).toHaveLength(2);
  });
}

test("preserves edited text on a concurrent update conflict", async ({ page }) => {
  await fixture(page, true, true);
  await page.goto("/platform/industries");
  await page.getByRole("button", { name: "编辑医疗健康的补充规则" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "行业补充规则", exact: true })
    .fill("我正在编辑的行业要求");
  await dialog.getByRole("button", { name: "保存规则" }).click();
  await expect(dialog.getByRole("alert")).toContainText("已被其他管理员修改");
  await expect(dialog.getByRole("textbox", { name: "行业补充规则", exact: true })).toHaveValue(
    "我正在编辑的行业要求",
  );
});

test("allows a viewer to read rules without offering save or create", async ({ page }) => {
  const f = await fixture(page, false);
  await page.goto("/platform/industries");
  await expect(page.getByRole("button", { name: "添加行业" })).toBeDisabled();
  await page.getByRole("button", { name: "查看医疗健康的补充规则" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: "行业补充规则", exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(dialog.getByRole("button", { name: "保存规则" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  expect(f.saves).toHaveLength(0);
});
