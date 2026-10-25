import { expect, type Page, test } from "@playwright/test";

const rightsLabel = "我确认拥有资料的使用权，并获准用于本企业内容";
const photo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=",
  "base64",
);

function material(overrides: Record<string, unknown> = {}) {
  return {
    id: "legacy",
    seriesId: "legacy-series",
    tenantId: "tenant",
    enterpriseId: "enterprise",
    version: 1,
    title: "医生历史简介",
    content: "历史医生履历资料保留。",
    sourceText: "历史医生履历资料保留。",
    supplement: null,
    status: "ACTIVE",
    authorizationStatus: "AUTHORIZED",
    ingestionStatus: "READY",
    usabilityStatus: "USABLE",
    type: "TEXT",
    tags: [],
    artifacts: [],
    ingestionJobs: [],
    structuredFacts: {},
    analysis: {},
    ...overrides,
  };
}

async function fixture(page: Page, materials: unknown[] = []) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.addInitScript(() =>
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
    ),
  );
  // Every API write and upload is intercepted; no real material or model job is created.
  await page.route(/:3100\//u, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") writes.push({ path, body: request.postDataJSON() ?? {} });
    let json: unknown = {};
    if (path === "/auth/admin/refresh")
      json = { accessToken: "fixture-token", expiresInSeconds: 3600 };
    else if (path === "/auth/admin/account")
      json = {
        name: "素材验收管理员",
        email: "fixture@example.test",
        emailVerifiedAt: "2026-10-14T00:00:00Z",
      };
    else if (path === "/auth/admin/session")
      json = {
        userId: "fixture-admin",
        phone: "13800000000",
        features: {},
        scopes: [
          {
            scopeType: "ENTERPRISE",
            role: { code: "ENTERPRISE_ADMIN", name: "企业管理员" },
            tenant: { id: "tenant", name: "测试集团" },
            enterprise: { id: "enterprise", name: "测试眼科", tenantId: "tenant" },
            permissions: ["material.read", "material.manage", "campaign.read", "campaign.manage"],
          },
        ],
      };
    else if (path.endsWith("/generation-status"))
      json = { affectedEnterpriseCount: 0, notices: [] };
    else if (path.endsWith("/materials/options")) json = { medical: true };
    else if (path.endsWith("/materials"))
      json = request.method() === "POST" ? material() : materials;
    else if (path.endsWith("/material-upload-intents"))
      json = {
        materialId: "uploaded",
        artifactId: "photo",
        uploadUrl: "https://upload.example.test/medical-photo",
        headers: { "Content-Type": "image/png" },
        expiresInSeconds: 900,
      };
    else if (path.endsWith("/versions")) json = material({ id: "classified", version: 2 });
    else
      return route.fulfill({ status: 404, json: { message: "Unmocked medical material fixture" } });
    return route.fulfill({ json });
  });
  await page.route("**/artifacts/*/complete", (route) => route.fulfill({ json: {} }));
  await page.route("https://upload.example.test/**", (route) => route.fulfill({ status: 200 }));
  return writes;
}

for (const width of [1440, 390]) {
  test(`medical enterprises use the generic material intake at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    const writes = await fixture(page);
    await page.goto("/console/materials");
    await page.getByRole("button", { name: "新增文字资料", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "新增文字资料", exact: true });
    await expect(drawer.getByRole("combobox", { name: "素材用途" })).toHaveCount(0);
    await drawer
      .getByRole("textbox", { name: "资料内容", exact: true })
      .fill("品牌背景：企业专注日常产品体验和客户服务，内容以真实资料为准。");
    const rights = drawer.getByRole("checkbox", { name: rightsLabel });
    await expect(rights).toHaveCSS("appearance", "none");
    await expect(drawer.getByRole("button", { name: "提交资料", exact: true })).toBeDisabled();
    await rights.check();
    const submit = drawer.getByRole("button", { name: "提交资料", exact: true });
    await expect(submit).toBeEnabled();
    await expect(submit).toHaveCSS("justify-self", "start");
    expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`generic-material-${width}.png`) });
    await submit.click();
    const created = writes.find(({ path }) => path.endsWith("/materials"))?.body;
    expect(created?.content).toContain("品牌背景");
    expect(created).not.toHaveProperty("medicalMaterial");
    expect(requested.some((url) => url.includes("/materials/options"))).toBe(false);
  });

  test(`generic image intake retains description and logo controls at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const writes = await fixture(page);
    await page.goto("/console/materials");
    await page.getByRole("button", { name: "上传图片素材", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "上传图片素材", exact: true });
    await drawer
      .getByRole("textbox", { name: "图片公共说明", exact: true })
      .fill("企业已授权的产品使用场景照片");
    await drawer
      .locator('input[type="file"]')
      .setInputFiles({ name: "product.png", mimeType: "image/png", buffer: photo });
    const logo = drawer.getByRole("checkbox", { name: "用作品牌 Logo（原图使用）" });
    await expect(logo).toHaveCSS("appearance", "none");
    await logo.check();
    await expect(logo).toBeChecked();
    await drawer.getByRole("checkbox", { name: rightsLabel }).check();
    expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`generic-photo-${width}.png`) });
    await drawer.getByRole("button", { name: "提交资料", exact: true }).click();
    await expect
      .poll(() => writes.filter(({ path }) => path.endsWith("/material-upload-intents")).length)
      .toBe(1);
    const upload = writes.find(({ path }) => path.endsWith("/material-upload-intents"))?.body;
    expect(upload).toMatchObject({ usage: "LOGO", authorizationConfirmed: true });
    expect(upload).not.toHaveProperty("medicalMaterial");
  });
}

test("legacy classified materials remain visible and keep their classification on edit", async ({
  page,
}) => {
  const classification = { schemaVersion: "medical-material-v1", purpose: "ARCHIVE" };
  const writes = await fixture(page, [
    material({ structuredFacts: { medicalMaterial: classification } }),
  ]);
  await page.goto("/console/materials");
  const row = page.locator(".materialLibrary article").filter({ hasText: "医生历史简介" });
  await expect(row).toContainText("已归档");
  await expect(row).toContainText("历史分类：历史 / 归档");
  await row.getByRole("button", { name: "更新内容", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "更新品牌资料" });
  await drawer
    .getByRole("textbox", { name: "资料内容", exact: true })
    .fill("历史资料保留，补充原有事实。");
  await drawer.getByRole("checkbox", { name: rightsLabel }).check();
  await drawer.getByRole("button", { name: /提交资料|保存新版本|提交新版本/u }).click();
  await expect.poll(() => writes.filter(({ path }) => path.endsWith("/versions")).length).toBe(1);
  expect(writes.find(({ path }) => path.endsWith("/versions"))?.body.medicalMaterial).toEqual(
    classification,
  );
});
