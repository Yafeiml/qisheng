import { expect, type Locator, type Page, test } from "@playwright/test";

async function mockPublic(page: Page, mode = "APPLICATION") {
  await page.route(/:3100\//u, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked API" } }),
  );
  await page.route("**/public/platform-branding", (route) =>
    route.fulfill({ json: { name: "企声" } }),
  );
  await page.route("**/public/registration/mode", (route) => route.fulfill({ json: { mode } }));
  await page.route("**/auth/captcha/challenge", (route) =>
    route.fulfill({ json: { required: false } }),
  );
}

async function mockAdmin(page: Page) {
  await mockPublic(page);
  const role = { code: "ADMIN", name: "测试管理员" };
  const tenant = { id: "tenant", name: "测试集团", customerType: "GROUP" };
  const enterprise = { id: "enterprise", name: "测试企业" };
  const profile = {
    userId: "admin",
    name: "测试管理员",
    phone: "13800000001",
    features: {},
    scopes: [
      {
        scopeId: "platform",
        scopeType: "PLATFORM",
        tenant: null,
        enterprise: null,
        inheritedEnterprises: [],
        permissions: ["platform.tenant.manage", "platform.settings.manage"],
        role,
      },
      {
        scopeId: "group",
        scopeType: "TENANT",
        tenant,
        enterprise: null,
        inheritedEnterprises: [enterprise],
        permissions: ["tenant.enterprise.read", "tenant.enterprise.manage"],
        role,
      },
    ],
  };
  await page.addInitScript(() =>
    localStorage.setItem(
      "xhs-agentic:mvp-session:v1",
      JSON.stringify({
        mode: "FORMAL",
        tenantId: "tenant",
        enterpriseId: "enterprise",
        adminToken: "old-token",
      }),
    ),
  );
  await page.route("**/auth/admin/refresh", (route) =>
    route.fulfill({ json: { accessToken: "test-token", expiresInSeconds: 3600 } }),
  );
  await page.route("**/auth/admin/session", (route) => route.fulfill({ json: profile }));
  await page.route("**/auth/admin/account", (route) =>
    route.fulfill({
      json: {
        id: "admin",
        name: profile.name,
        phone: profile.phone,
        email: "owner@example.test",
        emailVerifiedAt: "2026-10-09T00:00:00Z",
      },
    }),
  );
  return profile;
}

async function geometry(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top + window.scrollY, height: rect.height, width: rect.width };
  });
}

for (const width of [1440, 390]) {
  test(`publication validation reappears after expiry without editing the reason at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    const profile = await mockAdmin(page);
    profile.scopes[1].permissions.push("campaign.approve");
    const reviews = ["MANUAL_REVIEW", "UNAVAILABLE"].map((status, index) => ({
      id: `review-${index}`,
      status,
      normalizedUrl: `https://example.test/note/${index}`,
      verificationPolicyVersion: "test-v1",
      verificationAttempt: 1,
      extractedImageUrls: [],
      textSimilarityScore: null,
      imageSimilarityScore: null,
      factMatchScore: null,
      task: {
        status: "AVAILABLE",
        campaignId: "campaign",
        employeeContent: {
          title: "发布核实示例",
          body: "用于浏览器验证复核依据的测试内容。",
          images: [],
          audienceSnapshot: { employeeName: `测试员工${index}`, employeePhone: "13800000002" },
        },
      },
    }));
    let mutations = 0;
    await page.route("**/publication-reviews**", (route) => {
      if (route.request().method() !== "GET") {
        mutations++;
        return route.fulfill({
          status: 500,
          json: { message: "Validation must stop the mutation" },
        });
      }
      return route.fulfill({
        json: { items: reviews, pageInfo: { hasNextPage: false, nextCursor: null } },
      });
    });
    await page.goto("/console/publications");
    const toast = page.locator('.feedbackToast[data-tone="error"]');
    for (const [index, action, message] of [
      [0, "核实有效", "复核前请填写至少 2 个字的判断依据"],
      [1, "重新获取", "重试前请填写至少 2 个字的原因"],
    ] as const) {
      const row = page.locator(".reviewQueue > article").nth(index);
      const reason = row.getByLabel("复核或重试依据");
      const submit = row.getByRole("button", { name: action, exact: true });
      await reason.fill("x");
      await submit.click();
      await expect(toast).toHaveText(message);
      await expect(reason).toHaveAttribute("aria-invalid", "true");
      await expect(reason).toBeFocused();
      await page.clock.fastForward(3100);
      await expect(toast).toHaveCount(0);
      await expect(reason).toHaveValue("x");
      await expect(reason).toHaveAttribute("aria-invalid", "true");
      await submit.click();
      await expect(toast).toHaveText(message);
      await expect(reason).toHaveValue("x");
      await expect(reason).toBeFocused();
      expect(mutations).toBe(0);
      await page.clock.fastForward(3100);
      await expect(toast).toHaveCount(0);
    }
  });
}

for (const width of [1440, 390]) {
  for (const [name, path, failedEndpoints] of [
    [
      "model configuration",
      "/platform/models",
      ["/platform/model-catalog", "/platform/runtime-policy"],
    ],
    ["content safety", "/platform/settings/content-safety", ["/platform/settings/content-safety"]],
    ["admin SMS", "/platform/settings/security", ["/platform/settings/admin-sms"]],
    ["generation lab", "/platform/generation-lab", ["/platform/generation-lab/options"]],
  ] as const) {
    test(`${name} keeps its reload action after a load error toast expires at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.clock.install();
      const profile = await mockAdmin(page);
      profile.scopes[0].permissions.push("platform.model.manage");
      await page.route("**:3100/platform/settings", (route) =>
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
              {
                group: "SECURITY",
                slug: "security",
                label: "安全设置",
                description: "管理员登录",
                configuredCount: 0,
                totalCount: 0,
                settings: [],
              },
            ],
          },
        }),
      );
      await page.route("**:3100/platform/generation-lab", (route) => route.fulfill({ json: [] }));
      const reads = new Map<string, number>();
      const message = "配置读取暂时失败，请稍后重试";
      for (const endpoint of failedEndpoints) {
        reads.set(endpoint, 0);
        await page.route(`**:3100${endpoint}`, (route) => {
          reads.set(endpoint, (reads.get(endpoint) ?? 0) + 1);
          return route.fulfill({ status: 503, json: { message } });
        });
      }
      let providerCalls = 0;
      let mutations = 0;
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.startsWith("/platform/model-providers/")) providerCalls++;
        if (pathname.startsWith("/platform/") && request.method() !== "GET") mutations++;
      });
      await page.goto(path);
      const toast = page.locator('.feedbackToast[data-tone="error"]', { hasText: message });
      await expect(toast).toBeVisible();
      await page.clock.fastForward(3100);
      await expect(toast).toHaveCount(0);
      const retry = page.getByRole("button", { name: "重新加载", exact: true });
      await expect(retry).toBeVisible();
      await expect(retry).toBeEnabled();
      const before = new Map(reads);
      await retry.click();
      for (const endpoint of failedEndpoints) {
        await expect
          .poll(() => reads.get(endpoint) ?? 0)
          .toBeGreaterThan(before.get(endpoint) ?? 0);
      }
      await expect(toast).toBeVisible();
      await expectToastInViewport(page, toast);
      expect({ providerCalls, mutations }).toEqual({ providerCalls: 0, mutations: 0 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  }
}

async function expectToastInViewport(page: Page, toast: Locator) {
  const box = await toast.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect(box?.y).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport?.height ?? 0);
  const rightGap = (viewport?.width ?? 0) - (box?.x ?? 0) - (box?.width ?? 0);
  const bottomGap = (viewport?.height ?? 0) - (box?.y ?? 0) - (box?.height ?? 0);
  expect(rightGap).toBeLessThanOrEqual(48);
  expect(bottomGap).toBeGreaterThanOrEqual(12);
  expect(bottomGap).toBeLessThanOrEqual(80);
  expect(
    await page
      .locator(".feedbackToastStack")
      .evaluate((element) => getComputedStyle(element).position),
  ).toBe("fixed");
}

for (const width of [1440, 390]) {
  test(`platform feedback is fixed, deduplicated and leaves fields in place at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    await mockAdmin(page);
    const industries = Array.from({ length: 35 }, (_, index) => ({
      id: `industry-${index}`,
      name: `测试行业 ${index}`,
      sortOrder: index,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    }));
    let reject = true;
    await page.route("**:3100/platform/industries", (route) => {
      if (route.request().method() === "POST") {
        if (reject) return route.fulfill({ status: 409, json: { message: "行业名称已存在" } });
        const industry = {
          ...industries[0],
          id: "new-industry",
          name: route.request().postDataJSON().name,
        };
        industries.push(industry);
        return route.fulfill({ json: industry });
      }
      return route.fulfill({ json: industries });
    });
    await page.goto("/platform/industries");
    await page.evaluate(() =>
      document.documentElement.style.setProperty("scroll-behavior", "auto"),
    );
    const form = page.locator(".industryCreator");
    const name = page.getByLabel("行业名称");
    const submit = page.getByRole("button", { name: "添加行业", exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toHaveClass(/feedbackFieldError/u);
    await expect(name).toBeFocused();
    await expect(page.locator('.feedbackToast[data-tone="error"]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("platform-field-error.png") });
    await page.clock.fastForward(3100);
    await expect(page.locator('.feedbackToast[data-tone="error"]')).toHaveCount(0);
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toHaveClass(/feedbackFieldError/u);
    await name.fill("x");
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator('.feedbackToast[data-tone="error"]')).toHaveCount(0);
    await name.fill("重复行业");
    await expect(name).not.toHaveAttribute("aria-invalid", "true");
    await expect(name).not.toHaveClass(/feedbackFieldError/u);
    await expect(page.locator('.feedbackToast[data-tone="error"]')).toHaveCount(0);
    const before = await geometry(form);
    await submit.click();
    const error = page.locator('.feedbackToast[data-tone="error"]');
    await expect(error).toHaveText(/行业名称已存在/u);
    expect(await geometry(form)).toEqual(before);
    await submit.click();
    await expect(error).toHaveCount(1);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expectToastInViewport(page, error);
    await page.screenshot({ path: testInfo.outputPath("platform-error-toast.png") });
    await page.clock.fastForward(3100);
    await expect(error).toHaveCount(0);
    await name.fill("重复行业（修改）");
    await page.clock.fastForward(100);
    await expect(error).toHaveCount(0);
    await submit.click();
    await expect(error).toHaveText(/行业名称已存在/u);
    await error.getByRole("button", { name: "关闭提示" }).click();
    await expect(error).toHaveCount(0);
    await name.fill("重复行业（再次修改）");
    await page.clock.fastForward(100);
    await expect(error).toHaveCount(0);
    await submit.click();
    await expect(error).toHaveText(/行业名称已存在/u);
    await error.getByRole("button", { name: "关闭提示" }).click();
    reject = false;
    await name.fill("新增行业");
    const successBefore = await geometry(form);
    await submit.click();
    const success = page.locator('.feedbackToast[data-tone="success"]');
    await expect(success).toHaveText(/新增行业.*已加入行业目录/u);
    const successAfter = await geometry(form);
    expect(successAfter.height).toBe(successBefore.height);
    expect(successAfter.width).toBe(successBefore.width);
    await expectToastInViewport(page, success);
    await page.clock.fastForward(3100);
    await expect(success).toHaveCount(0);
    expect(await geometry(form)).toEqual(successAfter);
    await name.fill("尚未提交的行业");
    await page.clock.fastForward(100);
    await expect(success).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test(`console drawer validates fields and keeps feedback above the drawer at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockAdmin(page);
    let enterprise = {
      id: "enterprise",
      name: "测试企业",
      code: "TEST",
      status: "ACTIVE",
      brandName: "测试品牌",
      industry: "科技",
      city: "北京市",
      seats: { ENABLED: 2 },
      campaigns: {},
    };
    await page.route("**/console/tenants/tenant/enterprises", (route) => {
      if (route.request().method() === "POST")
        return route.fulfill({ status: 409, json: { message: "企业名称已存在" } });
      return route.fulfill({ json: [enterprise] });
    });
    await page.route("**/console/tenants/tenant/industries", (route) =>
      route.fulfill({
        json: [
          { id: "tech", name: "科技", sortOrder: 0 },
          { id: "retail", name: "零售", sortOrder: 1 },
        ],
      }),
    );
    await page.route("**/console/tenants/tenant/enterprises/enterprise/profile", (route) => {
      enterprise = { ...enterprise, ...route.request().postDataJSON() };
      return route.fulfill({ json: enterprise });
    });
    await page.goto("/console/enterprises");
    await page.getByRole("button", { name: "创建企业", exact: true }).click();
    const create = page.getByRole("dialog", { name: "创建集团企业" });
    const name = create.getByLabel("企业名称");
    await create.getByRole("button", { name: "创建企业", exact: true }).click();
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("console-drawer-field-error.png") });
    await name.fill("已有企业");
    await expect(name).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.locator('.feedbackToast[data-tone="error"]')).toHaveCount(0);
    await create.getByLabel("行业", { exact: true }).selectOption("零售");
    await create.getByLabel("省或自治区").selectOption({ label: "广东省" });
    await create.getByLabel("城市", { exact: true }).selectOption({ label: "深圳市" });
    await expect(create.getByLabel("城市", { exact: true })).toBeEnabled();
    await expect(create.getByLabel("行业", { exact: true })).toHaveValue("零售");
    const body = create.locator(".workspaceDrawerBody");
    const before = await geometry(body);
    await create.getByRole("button", { name: "创建企业", exact: true }).click();
    const error = page.locator('.feedbackToast[data-tone="error"]', { hasText: "企业名称已存在" });
    await expect(error).toBeVisible();
    expect(await geometry(body)).toEqual(before);
    await expectToastInViewport(page, error);
    const errorBox = await error.boundingBox();
    const closeBox = await create.getByRole("button", { name: "关闭创建集团企业" }).boundingBox();
    expect(errorBox?.y).toBeGreaterThanOrEqual((closeBox?.y ?? 0) + (closeBox?.height ?? 0));
    expect(
      await page
        .locator(".feedbackToastStack")
        .evaluate((element) => Number(getComputedStyle(element).zIndex)),
    ).toBeGreaterThan(
      await page
        .locator(".workspaceDrawerBackdrop")
        .evaluate((element) => Number(getComputedStyle(element).zIndex)),
    );
    await page.screenshot({ path: testInfo.outputPath("console-drawer-toast.png") });
    await page.keyboard.press("Escape");
    await expect(error).toHaveCount(0);
    await expect(create).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(create).not.toBeVisible();
    await page.getByRole("button", { name: "编辑选中企业" }).click();
    const edit = page.getByRole("dialog", { name: "编辑 测试企业" });
    await edit.getByLabel("品牌名称").fill("新的品牌");
    await edit.getByRole("button", { name: "保存企业资料" }).click();
    await expect(edit).not.toBeVisible();
    await expect(page.locator('.feedbackToast[data-tone="success"]')).toHaveText(/企业资料已更新/u);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test(`login failures use the bottom-right toast without expanding the form at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockPublic(page);
    await page.route("**/auth/admin/request-code", (route) =>
      route.fulfill({
        status: 503,
        json: {
          message:
            "短信服务暂时不可用，请确认手机号无误后重试；如果仍然无法收到验证码，请联系后台管理员处理。",
        },
      }),
    );
    await page.goto("/login");
    await page.getByLabel("管理员手机号").fill("13800000001");
    const form = page.locator(".loginForm");
    const before = await geometry(form);
    await page.getByRole("button", { name: "获取验证码", exact: true }).click();
    const error = page.locator('.feedbackToast[data-tone="error"]');
    await expect(error).toHaveText(/短信服务暂时不可用/u);
    expect(await geometry(form)).toEqual(before);
    await expectToastInViewport(page, error);
    await page.screenshot({ path: testInfo.outputPath("login-error-toast.png") });
    await error.getByRole("button", { name: "关闭提示" }).click();
    await expect(error).toHaveCount(0);
  });

  test(`registration validates required fields and retains its completed state at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    await mockPublic(page);
    await page.route("**/public/registration/applications", (route) =>
      route.fulfill({ json: { id: "application", submitted: true } }),
    );
    await page.goto("/register");
    const form = page.locator("form.loginForm");
    const company = page.getByLabel("企业名称");
    await page.getByLabel("企业规模").selectOption("1–49 人");
    await page.getByLabel("联系人", { exact: true }).fill("李管理员");
    await page.getByLabel("联系手机号").fill("13800000001");
    const submit = page.getByRole("button", { name: "提交申请", exact: true });
    await expect(submit).toBeEnabled();
    const before = await geometry(form);
    await submit.click();
    await expect(company).toHaveAttribute("aria-invalid", "true");
    await expect(company).toBeFocused();
    expect(await geometry(form)).toEqual(before);
    await company.fill("测试企业");
    await expect(company).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.locator('.feedbackToast[data-tone="error"]')).toHaveCount(0);
    await submit.click();
    await expect(page.locator('.feedbackToast[data-tone="success"]')).toHaveText(/提交成功/u);
    await expect(form).toHaveCount(0);
    await page.clock.fastForward(3100);
    await expect(page.locator('.feedbackToast[data-tone="success"]')).toHaveCount(0);
    await expect(page.getByText("申请已提交，我们会主动联系你。", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("registration-completed.png") });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}
