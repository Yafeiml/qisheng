import { expect, type Page, test } from "@playwright/test";

const endpoint = "https://api.example.com/notes/detail";
const sampleUrl = "https://www.xiaohongshu.com/explore/66ab1234567890abcdef1234";
const secret = "readback-ui-fixture-token-not-a-real-secret";
type Configuration = {
  enabled: boolean;
  endpoint: string;
  tokenConfigured: boolean;
  verified: boolean;
  managedNodeConfigured: boolean;
  externalMode: boolean;
};
const operations = () => ({
  paused: true,
  reason: "READBACK_DISABLED" as string | null,
  today: "2026-10-25",
  dailyLimit: 100,
  total: 0,
  queued: 0,
  retrying: 0,
  leased: 0,
  completed: 0,
  needsReview: 0,
  budget: [] as { day: string; used: number }[],
  jobs: [] as {
    id: string;
    status: string;
    attempts: number;
    dueAt: string;
    updatedAt: string;
    errorCode: string | null;
    leaseOwner: string | null;
  }[],
  onlineNodes: 0,
  nodes: [] as {
    id: string;
    online: boolean;
    panelHost: string | null;
    panelUrl: string | null;
    lastSeenAt: string | null;
  }[],
});
async function fixture(
  page: Page,
  options: {
    manage?: boolean;
    configuration?: Partial<Configuration>;
    state?: Partial<ReturnType<typeof operations>>;
    failSave?: boolean;
    sampleSuccess?: boolean;
  } = {},
) {
  const configuration: Configuration = {
    enabled: false,
    endpoint: "",
    tokenConfigured: false,
    verified: false,
    managedNodeConfigured: true,
    externalMode: false,
    ...options.configuration,
  };
  const state = { ...operations(), ...options.state };
  const requests: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
  await page.addInitScript(() =>
    localStorage.setItem("xhs-agentic:mvp-session:v1", JSON.stringify({ mode: "FORMAL" })),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "mock-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/account", (route) =>
    route.fulfill({
      json: {
        name: "回读验收管理员",
        email: "readback@example.test",
        emailVerifiedAt: "2026-10-25T00:00:00Z",
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
            permissions: [
              "platform.monitor.read",
              ...(options.manage === false ? [] : ["platform.settings.manage"]),
            ],
          },
        ],
      },
    }),
  );
  // Supplier requests are never sent by the browser; every application API call below is a fixture.
  await page.route("**/platform/publication-readback/**", async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname.replace(/^\/api/u, "");
    const body =
      method === "POST" ? (route.request().postDataJSON() as Record<string, unknown>) : null;
    requests.push({ path, method, body });
    if (path.endsWith("/configuration")) {
      if (method === "POST" && body) {
        if (options.failSave)
          return route.fulfill({ status: 503, json: { message: "配置保存暂时失败" } });
        if (
          body.enabled &&
          !configuration.externalMode &&
          (!configuration.verified || !configuration.managedNodeConfigured)
        )
          return route.fulfill({
            status: 409,
            json: { message: "请先部署采集服务并验证当前配置" },
          });
        if (body.endpoint !== configuration.endpoint || body.token) configuration.verified = false;
        configuration.enabled = body.enabled === true;
        configuration.endpoint = String(body.endpoint);
        if (body.token) configuration.tokenConfigured = true;
        if (body.token) configuration.externalMode = false;
        state.paused = !configuration.enabled;
        state.reason = configuration.enabled ? null : "READBACK_DISABLED";
        if (configuration.enabled) state.onlineNodes = 1;
      }
      return route.fulfill({ json: configuration });
    }
    if (path.endsWith("/test")) {
      configuration.verified = options.sampleSuccess !== false;
      return route.fulfill({
        json: {
          success: configuration.verified,
          checkedAt: new Date().toISOString(),
          message: configuration.verified ? "样本验证通过" : "样本响应缺少互动指标",
        },
      });
    }
    if (path.endsWith("/daily-limit") && body) state.dailyLimit = Number(body.dailyLimit);
    if (path.endsWith("/operations") || path.endsWith("/daily-limit"))
      return route.fulfill({ json: state });
    return route.fulfill({ status: 404, json: { message: "Unknown readback fixture" } });
  });
  return { configuration, state, requests };
}
async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth),
  );
}

for (const width of [1440, 390]) {
  test(`manual review is the quiet default and technical details are collapsed at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const { requests } = await fixture(page);
    await page.goto("/platform/readback");
    await expect(page.getByRole("heading", { name: "发布复核与回读", exact: true })).toBeVisible();
    await expect(page.locator('.appNav a[href="/platform/readback"]')).toContainText("发布回读");
    await expect(page.getByText("人工复核（默认）", { exact: true })).toBeVisible();
    await expect(page.getByText("自动回读未启用（可选）", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: /\S/u })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "采集节点", exact: true })).not.toBeVisible();
    const endpointField = page.getByRole("textbox", { name: "笔记数据接口", exact: true });
    await expect(endpointField).toHaveValue("");
    await expect(
      page.getByText("填写部署者自己的兼容 HTTPS 笔记数据接口地址；Token 单独配置。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("供应商 Token", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "启用自动回读", exact: true })).toBeDisabled();
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
    await expectNoOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`readback-manual-${width}.png`),
      fullPage: true,
    });
    await page.getByText("高级设置与任务记录", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "采集节点", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "最近任务", exact: true })).toBeVisible();
    await expectNoOverflow(page);
    await endpointField.fill(endpoint);
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(endpointField).toHaveValue("");
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  });

  test(`save, explicit sample confirmation, activation and manual fallback at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const { configuration, requests } = await fixture(page);
    await page.goto("/platform/readback");
    const token = page.getByLabel("供应商 Token", { exact: true });
    const reason = page.getByRole("textbox", { name: "配置变更原因", exact: true });
    await token.fill(secret);
    await reason.fill("配置企业自动回读");
    await expect(page.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
    await page.getByRole("textbox", { name: "笔记数据接口", exact: true }).fill(endpoint);
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(token).toHaveValue("");
    expect(requests.filter(({ path }) => path.endsWith("/test"))).toHaveLength(0);
    await expect(page.getByRole("button", { name: "启用自动回读", exact: true })).toBeDisabled();
    await page.getByRole("textbox", { name: "样本笔记链接", exact: true }).fill(sampleUrl);
    const sample = page.getByRole("button", { name: "验证样本（可能产生费用）", exact: true });
    await sample.click();
    const confirmation = page.getByRole("dialog", { name: "确认样本验证费用", exact: true });
    await expect(confirmation).toContainText("可能产生供应商费用");
    await expect(confirmation).not.toContainText(secret);
    await expect(confirmation.getByRole("textbox", { name: "验证原因", exact: true })).toHaveValue(
      "配置企业自动回读",
    );
    expect(requests.filter(({ path }) => path.endsWith("/test"))).toHaveLength(0);
    for (const button of await confirmation.getByRole("button").all()) {
      const bounds = await button.boundingBox();
      if (!bounds) throw new Error("Confirmation button is not visible");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(1000);
    }
    await expectNoOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`readback-sample-confirm-${width}.png`) });
    await confirmation.getByRole("button", { name: "返回检查", exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    expect(requests.filter(({ path }) => path.endsWith("/test"))).toHaveLength(0);
    await sample.click();
    const validationReason = confirmation.getByRole("textbox", { name: "验证原因", exact: true });
    await validationReason.fill("验".repeat(161));
    await confirmation.getByRole("button", { name: "确认验证", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "验证原因须为 2–160 个字" }),
    ).toBeVisible();
    expect(requests.filter(({ path }) => path.endsWith("/test"))).toHaveLength(0);
    await validationReason.fill("确认本次样本验证");
    await confirmation.getByRole("button", { name: "确认验证", exact: true }).evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) throw new Error("Expected confirmation button");
      button.click();
      button.click();
    });
    await expect(page.getByText("当前配置的样本验证已通过。", { exact: true })).toBeVisible();
    expect(requests.filter(({ path }) => path.endsWith("/test"))).toHaveLength(1);
    expect(requests.find(({ path }) => path.endsWith("/test"))?.body).toMatchObject({
      reason: "确认本次样本验证",
    });
    await expect(confirmation).not.toBeVisible();
    await page.getByRole("button", { name: "启用自动回读", exact: true }).click();
    await expect(page.getByText("自动回读运行中", { exact: true })).toBeVisible();
    expect(configuration.enabled).toBe(true);
    const modeRequest = requests.filter(({ method }) => method === "POST").at(-1);
    expect(modeRequest?.body).toMatchObject({ enabled: true, endpoint });
    expect(modeRequest?.body).not.toHaveProperty("token");
    await expect(page.locator("body")).not.toContainText(secret);
    expect(
      await page.evaluate(
        (value) => Object.values(localStorage).some((entry) => entry.includes(value)),
        secret,
      ),
    ).toBe(false);
    expect(page.url()).not.toContain(secret);
    await expectNoOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`readback-enabled-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "切换为人工复核", exact: true }).click();
    await expect(page.getByText("人工复核（默认）", { exact: true })).toBeVisible();
    expect(configuration.enabled).toBe(false);
    await token.fill(`${secret}-replacement`);
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(
      page.getByText("启用前需要验证当前配置的真实样本。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "启用自动回读", exact: true })).toBeDisabled();
    expect(configuration.verified).toBe(false);
    expect(requests.filter(({ path }) => path.endsWith("/test"))).toHaveLength(1);
  });
}

test("monitor-only accounts never read managed credentials or show configuration controls", async ({
  page,
}) => {
  const { requests } = await fixture(page, { manage: false });
  await page.goto("/platform/readback");
  await expect(page.getByText("人工复核（默认）", { exact: true })).toBeVisible();
  await expect(
    page.getByText("当前账号可查看运行状态；仅系统设置管理员可修改自动回读配置。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("供应商 Token", { exact: true })).toHaveCount(0);
  expect(requests.filter(({ path }) => path.endsWith("/configuration"))).toHaveLength(0);
  await expect(page.getByRole("alert").filter({ hasText: /\S/u })).toHaveCount(0);
});

test("legacy external nodes remain visible and can be stopped and resumed without copying credentials", async ({
  page,
}) => {
  const { requests } = await fixture(page, {
    configuration: { enabled: true, endpoint, externalMode: true, managedNodeConfigured: false },
    state: {
      paused: false,
      reason: null,
      onlineNodes: 1,
      nodes: [
        {
          id: "legacy-readback-1",
          online: true,
          panelHost: "readback.example.org",
          panelUrl: "https://readback.example.org:8443/",
          lastSeenAt: new Date().toISOString(),
        },
      ],
    },
  });
  await page.goto("/platform/readback");
  await expect(page.getByText("自动回读运行中", { exact: true })).toBeVisible();
  await expect(page.getByText(/当前沿用高级独立节点配置/u)).toBeVisible();
  await expect(page.getByRole("link", { name: "打开节点面板" })).not.toBeVisible();
  await page.getByText("高级设置与任务记录", { exact: true }).click();
  await expect(page.getByRole("link", { name: "打开节点面板" })).toHaveAttribute(
    "href",
    "https://readback.example.org:8443/",
  );
  await page.getByRole("button", { name: "切换为人工复核", exact: true }).click();
  await expect(page.getByText("人工复核（默认）", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "启用自动回读", exact: true }).click();
  await expect(page.getByText("自动回读运行中", { exact: true })).toBeVisible();
  expect(requests.filter(({ path }) => path.endsWith("/test"))).toHaveLength(0);
  const toggles = requests.filter(({ method }) => method === "POST");
  expect(toggles.map(({ body }) => body?.enabled)).toEqual([false, true]);
  for (const toggle of toggles) expect(toggle.body).not.toHaveProperty("token");
});

test("only enabled readback faults are alerts and the shared request limit remains editable", async ({
  page,
}) => {
  const { state, requests } = await fixture(page, {
    configuration: { enabled: true, endpoint, tokenConfigured: true, verified: true },
    state: { paused: true, reason: "PROVIDER_AUTH_ERROR", retrying: 10 },
  });
  await page.goto("/platform/readback");
  await expect(page.getByRole("alert").filter({ hasText: "自动回读运行提醒" })).toContainText(
    "重试工作单 10 条",
  );
  await expect(page.locator("body")).not.toContainText("主服务暂停");
  await page.getByText("高级设置与任务记录", { exact: true }).click();
  await page.getByRole("spinbutton", { name: "每日领取上限", exact: true }).fill("80");
  await page.getByRole("textbox", { name: "额度变更原因", exact: true }).fill("降低查询请求上限");
  await page.getByRole("button", { name: "保存额度", exact: true }).click();
  await expect(page.getByText("0 / 80", { exact: true })).toBeVisible();
  expect(state.dailyLimit).toBe(80);
  expect(requests.find(({ path }) => path.endsWith("/daily-limit"))?.body).toEqual({
    dailyLimit: 80,
    reason: "降低查询请求上限",
  });
});

test("sample verification is allowed before colocated deployment but activation stays disabled", async ({
  page,
}) => {
  await fixture(page, {
    configuration: {
      endpoint,
      tokenConfigured: true,
      verified: true,
      managedNodeConfigured: false,
    },
  });
  await page.goto("/platform/readback");
  await page.getByRole("textbox", { name: "配置变更原因", exact: true }).fill("验证已有数据接口");
  await page.getByRole("textbox", { name: "样本笔记链接", exact: true }).fill(sampleUrl);
  await expect(
    page.getByRole("button", { name: "验证样本（可能产生费用）", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "启用自动回读", exact: true })).toBeDisabled();
  await expect(page.getByText(/同机采集服务尚未配置/u)).toBeVisible();
});

test("saving failures retain the draft without issuing a sample query", async ({ page }) => {
  const { requests } = await fixture(page, { failSave: true });
  await page.goto("/platform/readback");
  const token = page.getByLabel("供应商 Token", { exact: true });
  await page.getByRole("textbox", { name: "笔记数据接口", exact: true }).fill(endpoint);
  await token.fill(secret);
  await page.getByRole("textbox", { name: "配置变更原因", exact: true }).fill("保存企业数据接口");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "配置保存暂时失败" })).toBeVisible();
  await expect(token).toHaveValue(secret);
  expect(requests.filter(({ path }) => path.endsWith("/test"))).toHaveLength(0);
});
