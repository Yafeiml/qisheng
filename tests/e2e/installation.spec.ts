import { expect, type Locator, type Page, test } from "@playwright/test";

function profile(group = false) {
  return {
    userId: "owner",
    username: "owner",
    name: "系统管理员",
    phone: null,
    audience: "xhs-saas-admin",
    sessionId: "session",
    scopes: [
      {
        scopeType: "PLATFORM",
        scopeId: "platform",
        role: { code: "PLATFORM_ADMIN", name: "系统管理员" },
        permissions: [
          "platform.settings.manage",
          "platform.access.manage",
          "platform.monitor.read",
        ],
        inheritedEnterprises: [],
      },
      group
        ? {
            scopeType: "TENANT",
            scopeId: "tenant",
            tenant: { id: "tenant", name: "示例集团", customerType: "GROUP" },
            role: { code: "TENANT_ADMIN", name: "集团主管理员" },
            permissions: [
              "tenant.enterprise.read",
              "tenant.enterprise.manage",
              "tenant.role.manage",
            ],
            inheritedEnterprises: [],
          }
        : {
            scopeType: "ENTERPRISE",
            scopeId: "enterprise",
            tenant: { id: "tenant", name: "示例企业", customerType: "SINGLE_ENTERPRISE" },
            enterprise: { id: "enterprise", name: "示例企业" },
            role: { code: "ENTERPRISE_ADMIN", name: "企业管理员" },
            permissions: [
              "enterprise.membership.manage",
              "enterprise.membership.read",
              "enterprise.role.manage",
            ],
            inheritedEnterprises: [],
          },
    ],
  };
}

async function fixture(page: Page, initialized = false, loggedIn = false, group = false) {
  if (loggedIn)
    await page.addInitScript(() =>
      localStorage.setItem(
        "xhs-agentic:mvp-session:v1",
        JSON.stringify({
          mode: "FORMAL",
          adminToken: "old",
          platformToken: "old",
          tenantId: "tenant",
          enterpriseId: "enterprise",
        }),
      ),
    );
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const requests: string[] = [];
  const settings = new Map<string, string | boolean>([
    ["storage.provider", "S3"],
    ["storage.region", "us-east-1"],
    ["storage.force_path_style", true],
    ["storage.signed_url_ttl_seconds", "900"],
    ["storage.versioning_required", true],
    ["storage.delivery_mode", "S3_SIGNED"],
  ]);
  let providerSource = "DEFAULT";
  let switchBlocked = false;
  let storageValid = false;
  let bound = false;
  let failInstallation = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/u, "");
    requests.push(path);
    const body = request.method() === "POST" ? (request.postDataJSON() ?? {}) : {};
    if (request.method() === "POST") writes.push({ path, body });
    let json: unknown = {};
    if (path === "/auth/admin/installation") {
      if (request.method() === "GET") json = { initialized };
      else {
        if (failInstallation) {
          failInstallation = false;
          return route.fulfill({ status: 503, json: { message: "安装暂时失败，请重试" } });
        }
        initialized = true;
        group = body.organizationType === "GROUP";
        settings.set("storage.provider", "LOCAL");
        providerSource = "DATABASE";
        json = { accessToken: "owner-token", expiresInSeconds: 3600 };
      }
    } else if (path === "/auth/admin/refresh" || path === "/auth/admin/password-login")
      json = { accessToken: "owner-token", expiresInSeconds: 3600 };
    else if (path === "/auth/admin/session") json = profile(group);
    else if (path === "/platform/settings")
      json = {
        groups: [
          {
            slug: "storage",
            group: "STORAGE",
            label: "对象存储",
            description: "管理私有文件存储与交付。",
            settings: [
              ["storage.provider", "存储方式", "ENUM"],
              ["storage.endpoint", "对象存储 Endpoint", "URL"],
              ["storage.region", "对象存储 Region", "STRING"],
              ["storage.bucket", "私有 Bucket", "STRING"],
              ["storage.access_key_id", "Access Key ID", "SECRET"],
              ["storage.secret_access_key", "Secret Access Key", "SECRET"],
              ["storage.force_path_style", "强制 Path Style", "BOOLEAN"],
              ["storage.signed_url_ttl_seconds", "签名地址有效期", "INTEGER"],
              ["storage.versioning_required", "强制版本控制", "BOOLEAN"],
              ["storage.delivery_mode", "图片交付模式", "ENUM"],
            ].map(([key, label, valueType]) => ({
              key,
              label,
              valueType,
              value: valueType === "SECRET" ? null : (settings.get(key) ?? ""),
              configured: settings.has(key),
              secret: valueType === "SECRET",
              description: label,
              group: "STORAGE",
              source: key === "storage.provider" ? providerSource : "DEFAULT",
              store: "PLATFORM_SETTING",
              restartRequired: key !== "storage.signed_url_ttl_seconds",
              nullable: true,
              step: 1,
              min: valueType === "INTEGER" ? 60 : null,
              max: valueType === "INTEGER" ? 3600 : null,
              minLength: null,
              maxLength: null,
              unit: valueType === "INTEGER" ? "秒" : null,
              maskedValue: valueType === "SECRET" && settings.has(key) ? "****key" : null,
              updatedAt: null,
              updatedBy: null,
              version: null,
              options:
                key === "storage.provider"
                  ? [
                      { value: "LOCAL", label: "本机存储" },
                      { value: "S3", label: "S3 兼容存储" },
                    ]
                  : [
                      { value: "S3_SIGNED", label: "S3 签名地址" },
                      { value: "EDGE_SIGNED", label: "Edge 签名地址" },
                    ],
            })),
          },
        ],
      };
    else if (path === "/platform/settings/storage/test")
      json = {
        signedReadVerified: storageValid,
        bucket: settings.get("storage.provider") === "LOCAL" ? "本机存储" : "example-bucket",
        byteSize: 64,
      };
    else if (path.startsWith("/platform/settings/") && request.method() === "POST") {
      const key = decodeURIComponent(path.slice("/platform/settings/".length));
      if (key === "storage.provider" && switchBlocked)
        return route.fulfill({
          status: 409,
          json: {
            code: "OBJECT_STORAGE_SWITCH_REQUIRES_MIGRATION",
            message: "已有文件或进行中的任务，不能直接切换存储类型。请先迁移原文件并停止相关任务。",
          },
        });
      settings.set(key, body.value as string | boolean);
      if (key === "storage.provider") providerSource = "DATABASE";
    } else if (path.endsWith("/generation-status"))
      json = { notices: [], affectedEnterpriseCount: 0 };
    else if (path.endsWith("/memberships/member/web-account")) {
      bound = true;
      json = { username: body.username, userId: "employee-user", membershipId: "member" };
    } else if (path.endsWith("/memberships"))
      json = {
        items: [
          {
            id: "member",
            name: "示例员工",
            phone: "13600000001",
            status: bound ? "ACTIVE" : "PENDING_BIND",
            seatStatus: "ENABLED",
            globalUserId: bound ? "employee-user" : null,
            smsNotificationStatus: null,
          },
        ],
        pageInfo: { nextCursor: null, hasNextPage: false },
      };
    else if (
      path.endsWith("/departments") ||
      path.endsWith("/memberships/import-batches") ||
      path === "/platform/access/admins" ||
      path.endsWith("/admin-users")
    )
      json = [];
    else if (path.endsWith("/personnel-policy"))
      json = { allowEnterpriseParticipationManagement: true };
    else if (path.endsWith("/roles"))
      json = [
        {
          id: "operator-role",
          code: "ENTERPRISE_OPERATOR",
          name: "企业运营",
          description: "管理内容活动",
        },
      ];
    await route.fulfill({ json });
  });
  return {
    writes,
    requests,
    settings,
    failNextInstallation: () => {
      failInstallation = true;
    },
    acceptStorage: () => {
      storageValid = true;
    },
    setProvider: (value: string, source: string) => {
      settings.set("storage.provider", value);
      providerSource = source;
    },
    blockStorageSwitch: () => {
      switchBlocked = true;
    },
  };
}

async function fillInstallation(page: Page, group = false) {
  await page.getByLabel("安装凭证", { exact: true }).fill("fixture-installation-token");
  await page.getByLabel("管理员账号", { exact: true }).fill("owner");
  await page.getByLabel("管理员姓名", { exact: true }).fill("示例管理员");
  await page.getByLabel("管理员密码", { exact: true }).fill("Example-password123");
  await page.getByLabel("确认密码", { exact: true }).fill("Example-password123");
  await page
    .getByLabel("组织类型", { exact: true })
    .selectOption(group ? "GROUP" : "SINGLE_ENTERPRISE");
  await page
    .getByLabel(group ? "集团名称" : "企业名称", { exact: true })
    .fill(group ? "示例集团" : "示例企业");
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

async function expectHelpDoesNotShiftPeerControl(first: Locator, second: Locator, help: Locator) {
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect(help).toBeVisible();
  const bounds = await Promise.all(
    [first, second, help].map((control) =>
      control.evaluate((element) => {
        const { x, y, height, bottom } = element.getBoundingClientRect();
        return { x, y, height, bottom };
      }),
    ),
  );
  const [left, right, hint] = bounds;
  expect(hint.y - left.bottom).toBeGreaterThanOrEqual(6);
  if (Math.abs(left.x - right.x) > 1) {
    expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(left.height - right.height)).toBeLessThanOrEqual(1);
  } else {
    expect(right.y - hint.bottom).toBeGreaterThanOrEqual(6);
  }
}

for (const width of [1440, 390]) {
  test.describe(`installation and managed accounts ${width}`, () => {
    test.use({ viewport: { width, height: 1000 } });

    test("first login completes group installation without configuration steps", async ({
      page,
    }, testInfo) => {
      const { writes, requests, settings } = await fixture(page);
      await page.goto("/login");
      await expect(page).toHaveURL(/\/setup$/u);
      await fillInstallation(page, true);
      await page.getByLabel("确认密码", { exact: true }).fill("Other-password123");
      const submit = page.getByRole("button", { name: "创建管理员并完成安装", exact: true });
      await submit.click();
      await expect(
        page.getByRole("alert").filter({ hasText: "两次输入的密码不一致" }),
      ).toBeVisible();
      expect(writes.some(({ path }) => path === "/auth/admin/installation")).toBe(false);
      await page.getByLabel("确认密码", { exact: true }).fill("Example-password123");
      await expectHelpDoesNotShiftPeerControl(
        page.getByLabel("管理员密码", { exact: true }),
        page.getByLabel("确认密码", { exact: true }),
        page.locator("#installation-password-help"),
      );
      await expectNoOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath(`setup-account-${width}.png`),
        fullPage: true,
      });
      await submit.click();
      await expect(page.getByRole("heading", { name: "安装完成", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "进入工作台", exact: true })).toHaveAttribute(
        "href",
        "/console/enterprises",
      );
      expect(writes.find(({ path }) => path === "/auth/admin/installation")?.body).toMatchObject({
        organizationType: "GROUP",
        organizationName: "示例集团",
      });
      expect(settings.get("storage.provider")).toBe("LOCAL");
      expect(requests.filter((path) => path.startsWith("/platform/settings"))).toEqual([]);
      await expect(page.getByRole("list", { name: "安装步骤" })).toHaveCount(0);
      await expect(page.getByRole("combobox")).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: /配置生成模型|配置内容审核|其他常用设置/u }),
      ).toHaveCount(0);
      await expectNoOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath(`setup-complete-group-${width}.png`),
        fullPage: true,
      });
    });

    test("password fields stay aligned when their help text wraps", async ({ page }, testInfo) => {
      const { writes } = await fixture(page);
      await page.goto("/setup");
      const password = page.getByLabel("管理员密码", { exact: true });
      const confirmation = page.getByLabel("确认密码", { exact: true });
      const help = page.locator("#installation-password-help");
      await expectHelpDoesNotShiftPeerControl(password, confirmation, help);
      await help.evaluate((element) => {
        element.textContent =
          "密码须为 12–128 位，至少包含字母和数字，请通过安全方式妥善保存。".repeat(8);
      });
      await expectHelpDoesNotShiftPeerControl(password, confirmation, help);
      await expectNoOverflow(page);
      expect(writes.some(({ path }) => path === "/auth/admin/installation")).toBe(false);
      await page.screenshot({
        path: testInfo.outputPath(`setup-wrapped-password-help-${width}.png`),
        fullPage: true,
      });
    });

    test("single enterprise completes installation with local storage and one workbench action", async ({
      page,
    }, testInfo) => {
      const { writes, requests, settings } = await fixture(page);
      await page.goto("/setup");
      await fillInstallation(page);
      await page.getByRole("button", { name: "创建管理员并完成安装", exact: true }).click();
      await expect(page.getByRole("heading", { name: "安装完成", exact: true })).toBeVisible();
      await expect(page.getByText("管理员与组织配置已完成。", { exact: true })).toBeVisible();
      const workbench = page.getByRole("link", { name: "进入工作台", exact: true });
      await expect(workbench).toHaveAttribute("href", "/console");
      await page.keyboard.press("Tab");
      await workbench.focus();
      await expect(workbench).toHaveCSS("outline-style", "solid");
      await expect(page.getByLabel("存储方式", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "保存并验证存储" })).toHaveCount(0);
      expect(requests.filter((path) => path.startsWith("/platform/settings"))).toEqual([]);
      expect(settings.get("storage.provider")).toBe("LOCAL");
      expect(settings.has("storage.access_key_id")).toBe(false);
      expect(writes.filter(({ path }) => path === "/auth/admin/installation")).toHaveLength(1);
      await expectNoOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath(`setup-complete-enterprise-${width}.png`),
        fullPage: true,
      });
    });

    test("failed initialization keeps the form and retries without storage requests", async ({
      page,
    }) => {
      const { writes, requests, failNextInstallation } = await fixture(page);
      failNextInstallation();
      await page.goto("/setup");
      await fillInstallation(page);
      const submit = page.getByRole("button", { name: "创建管理员并完成安装", exact: true });
      await submit.click();
      await expect(
        page.getByRole("alert").filter({ hasText: "安装暂时失败，请重试" }),
      ).toBeVisible();
      await expect(page.getByLabel("管理员账号", { exact: true })).toHaveValue("owner");
      await expect(page.getByLabel("管理员密码", { exact: true })).toHaveValue(
        "Example-password123",
      );
      await expect(page.getByRole("link", { name: "进入工作台", exact: true })).toHaveCount(0);
      await expect(submit).toBeEnabled();
      await submit.click();
      await expect(page.getByRole("heading", { name: "安装完成", exact: true })).toBeVisible();
      expect(writes.filter(({ path }) => path === "/auth/admin/installation")).toHaveLength(2);
      expect(requests.filter((path) => path.startsWith("/platform/settings"))).toEqual([]);
    });

    test("storage settings save both providers and surface an existing-file switch block", async ({
      page,
    }, testInfo) => {
      const { writes, acceptStorage, blockStorageSwitch } = await fixture(page, true, true);
      acceptStorage();
      await page.goto("/platform/settings/storage");
      const provider = page.getByRole("combobox", { name: "存储方式", exact: true });
      await expect(provider).toHaveValue("S3");
      const save = page.getByRole("button", { name: "保存更改", exact: true });
      const testConnection = page.getByRole("button", { name: "测试存储连接", exact: true });
      await expect(save).toBeDisabled();
      await provider.selectOption("LOCAL");
      await expect(
        page.getByRole("textbox", { name: "对象存储 Endpoint", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("button", { name: "应用生命周期策略", exact: true })).toHaveCount(
        0,
      );
      await expect(testConnection).toBeDisabled();
      await page.getByLabel("本次变更原因").fill("使用本机持久化存储");
      await save.click();
      await expect(page.getByRole("status").filter({ hasText: "项参数已保存" })).toBeVisible();
      await expect(testConnection).toBeEnabled();
      await testConnection.click();
      await expect(
        page.getByRole("status").filter({ hasText: "存储连接正常：本机存储" }),
      ).toBeVisible();
      await provider.focus();
      await expect(provider).not.toHaveCSS("box-shadow", "none");
      await expectNoOverflow(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: testInfo.outputPath(`settings-local-storage-${width}.png`),
        fullPage: true,
      });
      await provider.selectOption("S3");
      await page
        .getByRole("textbox", { name: "对象存储 Endpoint", exact: true })
        .fill("https://storage.example.com");
      await page.getByRole("textbox", { name: "私有 Bucket", exact: true }).fill("example-bucket");
      await page.locator('input[aria-label="Access Key ID"]').fill("example-key");
      await page.locator('input[aria-label="Secret Access Key"]').fill("example-secret");
      await expect(
        page.getByRole("button", { name: "应用生命周期策略", exact: true }),
      ).toBeVisible();
      await page.getByLabel("本次变更原因").fill("切换到私有S3存储");
      await save.click();
      await expect(save).toBeDisabled();
      await expect(testConnection).toBeEnabled();
      await expect(provider).toHaveValue("S3");
      await expect(
        page
          .locator(
            'input[aria-label="Secret Access Key"], input[type="password"][placeholder="已配置，留空沿用"]',
          )
          .last(),
      ).toHaveValue("");
      const storageWrites = writes.filter(({ path }) =>
        path.startsWith("/platform/settings/storage."),
      );
      expect(storageWrites.at(-1)).toMatchObject({
        path: "/platform/settings/storage.provider",
        body: { value: "S3" },
      });
      await expectNoOverflow(page);
      const saveBounds = await save.boundingBox();
      const panelBounds = await page.locator(".parameterPanel").boundingBox();
      expect(saveBounds && panelBounds && saveBounds.width <= panelBounds.width).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: testInfo.outputPath(`settings-s3-storage-${width}.png`),
        fullPage: true,
      });
      blockStorageSwitch();
      await provider.selectOption("LOCAL");
      await page.getByLabel("本次变更原因").fill("验证已有文件切换门禁");
      await save.click();
      await expect(
        page.getByRole("alert").filter({ hasText: "已有文件或进行中的任务" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "刷新参数", exact: true }).click();
      await expect(provider).toHaveValue("S3");
    });

    test("completed setup never reads or replaces existing S3 settings", async ({ page }) => {
      const { writes, requests, settings, setProvider } = await fixture(page, true, true);
      setProvider("S3", "ENVIRONMENT");
      settings.set("storage.secret_access_key", "fixture-saved-secret");
      await page.goto("/setup");
      await expect(page.getByRole("heading", { name: "安装完成", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "进入工作台", exact: true })).toBeVisible();
      await expect(page.getByLabel("存储方式", { exact: true })).toHaveCount(0);
      expect(requests.filter((path) => path.startsWith("/platform/settings"))).toEqual([]);
      expect(writes.filter(({ path }) => path.startsWith("/platform/settings"))).toEqual([]);
      expect(settings.get("storage.provider")).toBe("S3");
      expect(settings.get("storage.secret_access_key")).toBe("fixture-saved-secret");
    });

    test("an installed signed-in account enters its workbench without settings permission", async ({
      page,
    }) => {
      const { requests } = await fixture(page, true, true);
      await page.route("**/api/auth/admin/session", (route) => {
        const current = profile();
        return route.fulfill({
          json: {
            ...current,
            scopes: current.scopes.filter((scope) => scope.scopeType !== "PLATFORM"),
          },
        });
      });
      await page.goto("/setup");
      await expect(page.getByRole("heading", { name: "安装完成", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "进入工作台", exact: true })).toHaveAttribute(
        "href",
        "/console",
      );
      expect(requests.filter((path) => path.startsWith("/platform/settings"))).toEqual([]);
    });

    test("an installed system has login only and cannot show first administrator creation", async ({
      page,
    }) => {
      await fixture(page, true);
      await page.goto("/setup");
      await expect(page.getByRole("heading", { name: "安装完成", exact: true })).toBeVisible();
      await expect(
        page.getByRole("link", { name: "登录并进入工作台", exact: true }),
      ).toHaveAttribute("href", "/login");
      await expect(
        page.getByRole("button", { name: "创建管理员并完成安装", exact: true }),
      ).toHaveCount(0);
      await page.goto("/register");
      await expect(page).toHaveURL(/\/login$/u);
      await expect(page.getByRole("link", { name: /注册/u })).toHaveCount(0);
    });

    test("an administrator creates and binds an employee account in the drawer", async ({
      page,
    }, testInfo) => {
      const { writes } = await fixture(page, true, true);
      await page.goto("/console/employees");
      await page.getByRole("button", { name: "创建网页账号", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "创建员工网页账号" });
      await drawer.getByLabel("登录账号", { exact: true }).fill("employee_one");
      await drawer.getByLabel("初始密码", { exact: false }).fill("Employee-password123");
      await drawer.getByLabel("确认密码", { exact: true }).fill("Employee-password123");
      const submit = drawer.getByRole("button", { name: "创建并绑定员工" });
      const button = await submit.boundingBox();
      const bounds = await drawer.boundingBox();
      expect(button && bounds && button.width <= bounds.width).toBe(true);
      await expectNoOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath(`employee-account-${width}.png`),
        fullPage: true,
      });
      await submit.click();
      await expect(drawer).toHaveCount(0);
      expect(writes.find(({ path }) => path.endsWith("/web-account"))?.body).toEqual({
        username: "employee_one",
        password: "Employee-password123",
      });
      await expect(page.getByRole("button", { name: "创建网页账号", exact: true })).toHaveCount(0);
    });

    test("system administrator creation sends an initial password without registration", async ({
      page,
    }) => {
      const { writes } = await fixture(page, true, true);
      await page.goto("/platform/access");
      await page.getByLabel("姓名", { exact: true }).fill("示例管理员");
      await page.getByLabel("管理员登录账号", { exact: true }).fill("second_admin");
      await page.getByLabel("初始密码（仅新账号填写）", { exact: false }).fill("Admin-password123");
      await page.getByRole("button", { name: "添加平台后台用户", exact: true }).click();
      await expect
        .poll(() => writes.some(({ path }) => path === "/platform/access/admins"))
        .toBe(true);
      expect(writes.find(({ path }) => path === "/platform/access/admins")?.body).toMatchObject({
        username: "second_admin",
        password: "Admin-password123",
      });
    });

    test("an enterprise administrator creates an account with scoped roles", async ({
      page,
    }, testInfo) => {
      const { writes } = await fixture(page, true, true);
      await page.goto("/console/access");
      await page.getByRole("button", { name: "添加后台用户", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "添加后台用户" });
      await drawer.getByLabel("姓名", { exact: true }).fill("示例运营");
      await drawer.getByLabel("登录账号", { exact: true }).fill("content_operator");
      await drawer
        .getByLabel("初始密码（仅新账号填写）", { exact: false })
        .fill("Operator-password123");
      const password = drawer.getByLabel("初始密码（仅新账号填写）", { exact: false });
      await expectHelpDoesNotShiftPeerControl(
        password,
        drawer.getByLabel("邮箱（选填）", { exact: true }),
        password.locator("..").locator("small"),
      );
      const role = drawer.getByRole("checkbox", { name: /企业运营/u });
      await page.keyboard.press("Tab");
      await role.focus();
      await page.keyboard.press("Space");
      await expect(role).toBeChecked();
      await expectNoOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath(`admin-account-${width}.png`),
        fullPage: true,
      });
      await drawer.getByRole("button", { name: "添加后台用户", exact: true }).click();
      await expect(drawer).toHaveCount(0);
      expect(writes.find(({ path }) => path.endsWith("/admin-users"))?.body).toMatchObject({
        username: "content_operator",
        password: "Operator-password123",
        roleCodes: ["ENTERPRISE_OPERATOR"],
      });
    });

    test("an empty group adds its enterprise without creating a phone-only administrator", async ({
      page,
    }, testInfo) => {
      const { writes } = await fixture(page, true, true, true);
      let created = false;
      const enterprise = {
        id: "enterprise",
        tenantId: "tenant",
        name: "示例分公司",
        code: "example-company",
        status: "ACTIVE",
        seats: { ENABLED: 0 },
        campaigns: {},
      };
      await page.route("**/auth/admin/session", (route) => {
        const current = profile(true);
        return route.fulfill({
          json: {
            ...current,
            scopes: current.scopes.map((scope) =>
              scope.scopeType === "TENANT"
                ? {
                    ...scope,
                    inheritedEnterprises: created
                      ? [{ id: enterprise.id, name: enterprise.name }]
                      : [],
                  }
                : scope,
            ),
          },
        });
      });
      await page.route("**/console/tenants/tenant/industries", (route) =>
        route.fulfill({ json: [] }),
      );
      await page.route("**/console/tenants/tenant/enterprises", (route) => {
        if (route.request().method() === "POST") {
          writes.push({
            path: "/console/tenants/tenant/enterprises",
            body: route.request().postDataJSON(),
          });
          created = true;
          return route.fulfill({ json: enterprise });
        }
        return route.fulfill({ json: created ? [enterprise] : [] });
      });
      await page.goto("/console");
      await expect(page).toHaveURL(/\/console\/enterprises$/u);
      await page.getByRole("button", { name: "创建企业", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "创建集团企业" });
      await expect(drawer.getByLabel(/管理员手机号/u)).toHaveCount(0);
      await drawer.getByLabel("企业名称", { exact: true }).fill(enterprise.name);
      await expectNoOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath(`group-enterprise-${width}.png`),
        fullPage: true,
      });
      await drawer.getByRole("button", { name: "创建企业", exact: true }).click();
      await expect(drawer).toHaveCount(0);
      expect(
        writes.find(({ path }) => path === "/console/tenants/tenant/enterprises")?.body,
      ).not.toHaveProperty("administratorPhone");
      await expect(
        page.getByRole("status").filter({ hasText: /企业已创建.*后台用户/u }),
      ).toBeVisible();
    });
  });
}
