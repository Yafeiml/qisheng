import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("xhs-agentic:mvp-session:v1", JSON.stringify({ mode: "FORMAL" })),
  );
  await page.route(/:3100\//, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked API" } }),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "mock-token", expiresInSeconds: 3600 } }),
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
            permissions: [
              "platform.settings.manage",
              "platform.model.manage",
              "platform.monitor.read",
            ],
          },
        ],
      },
    }),
  );
  await page.route("**/platform/settings", (route) =>
    route.fulfill({
      json: {
        groups: [
          {
            group: "CONTENT_SAFETY",
            slug: "content-safety",
            label: "内容安全",
            description: "图文审核",
            configuredCount: 0,
            totalCount: 0,
            settings: [],
          },
        ],
      },
    }),
  );
});
async function fixture(page: Page, verified = false, discoveryFails = false) {
  const config = {
    mode: verified ? "MODEL" : "DISABLED",
    modelProviderId: verified ? "p1" : "",
    model: verified ? "vision-model" : "",
    provider: "example-safety",
    endpoint: "https://safety.example.com/v1",
    apiKeyConfigured: true,
    timeoutMs: 90000,
    verified,
    checkedAt: null,
    providers: [{ id: "p1", name: "示例审核供应商" }],
  };
  const saves: Record<string, unknown>[] = [];
  let tests = 0;
  await page.route("**:3100/platform/settings/content-safety", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      saves.push(body);
      Object.assign(config, body, { verified: false });
    }
    await route.fulfill({ json: config });
  });
  await page.route("**/platform/model-providers/p1/available-models", (route) =>
    route.fulfill(
      discoveryFails
        ? { status: 502, json: { message: "unavailable" } }
        : {
            json: {
              models: [
                { externalModelId: "vision-model", suggestedCapabilities: ["TEXT"] },
                { externalModelId: "image-generator", suggestedCapabilities: ["IMAGE"] },
              ],
            },
          },
    ),
  );
  await page.route("**/platform/settings/content-safety/test", (route) => {
    tests++;
    config.verified = true;
    return route.fulfill({ json: { imageRiskDetected: true, decision: "PASS" } });
  });
  return { config, saves, testCount: () => tests };
}
test("selects a provider and model without asking for credentials and tests only saved settings", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/platform/settings/content-safety");
  await expect(page.getByRole("button", { name: "测试图文审核", exact: true })).toBeDisabled();
  await page.getByLabel("审核模型供应商", { exact: true }).selectOption("p1");
  await expect(page.locator('#content-safety-model-list option[value="vision-model"]')).toHaveCount(
    1,
  );
  await expect(
    page.locator('#content-safety-model-list option[value="image-generator"]'),
  ).toHaveCount(0);
  await page.getByLabel("图文审核模型", { exact: true }).fill("vision-model");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("配置已保存");
  expect(f.saves).toEqual([
    { mode: "MODEL", modelProviderId: "p1", model: "vision-model", timeoutMs: 90000 },
  ]);
  await page.getByRole("button", { name: "测试图文审核", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("图片中的危险医疗宣传已识别");
  expect(f.testCount()).toBe(1);
  await page.screenshot({ path: ".artifacts/model-safety/settings-desktop.png", fullPage: true });
});
test("invalidates the displayed success while a changed model remains unsaved", async ({
  page,
}) => {
  await fixture(page, true);
  await page.goto("/platform/settings/content-safety");
  await expect(page.getByText("测试已通过", { exact: true })).toBeVisible();
  await page.getByLabel("图文审核模型", { exact: true }).fill("another-vision-model");
  await expect(page.getByText("配置未保存", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "测试图文审核", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByText("待配置或测试", { exact: true })).toBeVisible();
});
test("supports manual model entry if discovery is unavailable", async ({ page }) => {
  await fixture(page, false, true);
  await page.goto("/platform/settings/content-safety");
  await page.getByLabel("审核模型供应商", { exact: true }).selectOption("p1");
  await expect(page.getByText("暂时无法读取模型列表", { exact: false })).toBeVisible();
  await page.getByLabel("图文审核模型", { exact: true }).fill("manual-vision-model");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("配置已保存");
});
