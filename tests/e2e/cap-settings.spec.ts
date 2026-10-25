import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`Cap settings save, retain the masked secret and clear the endpoint at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() =>
      localStorage.setItem(
        "xhs-agentic:mvp-session:v1",
        JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
      ),
    );
    await page.route("**/auth/admin/refresh", (route) =>
      route.fulfill({ json: { accessToken: "mock-token", expiresInSeconds: 3600 } }),
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
              permissions: ["platform.settings.manage"],
            },
          ],
        },
      }),
    );
    await page.route("**/platform/settings/admin-sms", (route) =>
      route.fulfill({
        json: {
          accessKeyIdConfigured: false,
          accessKeySecretConfigured: false,
          accessKeyIdHint: null,
          signName: "",
          templateCode: "",
          configured: false,
          enabled: false,
        },
      }),
    );
    let endpoint: string | null = "https://cap.example.com/old-site/";
    await page.route("**/platform/settings", (route) =>
      route.fulfill({
        json: {
          groups: [
            {
              group: "SECURITY",
              slug: "security",
              label: "安全设置",
              mark: "安",
              description: "登录与验证码保护",
              configuredCount: endpoint ? 2 : 1,
              totalCount: 2,
              settings: [
                ["security.cap_endpoint", "Cap 验证服务 Endpoint", endpoint],
                ["security.cap_secret", "Cap 验证服务 Secret Key", null],
              ].map(([key, label, value]) => ({
                key,
                label,
                value,
                group: "SECURITY",
                description: "登录、注册与员工验证码共用的 Cap 配置",
                configured: key === "security.cap_secret" || Boolean(endpoint),
                maskedValue: key === "security.cap_secret" ? "••••••••" : null,
                max: null,
                min: null,
                maxLength: key === "security.cap_secret" ? 512 : 2048,
                minLength: key === "security.cap_secret" ? 1 : null,
                nullable: true,
                options: [],
                restartRequired: false,
                secret: key === "security.cap_secret",
                source: "DATABASE",
                step: 1,
                store: "PLATFORM_SETTING",
                unit: null,
                updatedAt: null,
                updatedBy: null,
                valueType: key === "security.cap_secret" ? "SECRET" : "URL",
                version: 1,
              })),
            },
          ],
        },
      }),
    );
    const saves: { key: string; value: string; reason: string }[] = [];
    await page.route(/\/platform\/settings\/security\.cap_/u, (route) => {
      const key = decodeURIComponent(route.request().url().split("/").at(-1) ?? "");
      const body = route.request().postDataJSON();
      saves.push({ key, ...body });
      if (key === "security.cap_endpoint") endpoint = body.value || null;
      return route.fulfill({ json: {} });
    });

    await page.goto("/platform/settings/security");
    const endpointInput = page.getByRole("textbox", {
      name: "Cap 验证服务 Endpoint",
      exact: true,
    });
    const secretInput = page.locator('input[aria-label="Cap 验证服务 Secret Key"]');
    const reasonInput = page.getByLabel("本次变更原因", { exact: true });
    const save = page.getByRole("button", { name: "保存更改", exact: true });
    await expect(page.getByText(/format-1（SHA-256）挑战/u)).toBeVisible();
    await expect(endpointInput).toHaveAttribute(
      "placeholder",
      "https://cap.example.com/<Site Key>/",
    );
    await expect(secretInput).toHaveValue("");
    await expect(secretInput).toHaveAttribute("type", "password");
    await expect(secretInput).toHaveAttribute("placeholder", "••••••••");
    await expect(save).toBeDisabled();

    await endpointInput.fill("https://cap.example.com/site-key/");
    await secretInput.fill("test-only-secret");
    await reasonInput.fill("配置新的 Cap 服务");
    await secretInput.focus();
    await expect(secretInput).toBeFocused();
    await expect(secretInput).not.toHaveCSS("box-shadow", "none");
    await expect(save).toBeEnabled();
    await save.hover();
    const saveBounds = await save.boundingBox();
    expect(saveBounds?.height).toBeGreaterThanOrEqual(36);
    if (width === 1440) expect(saveBounds?.width).toBeLessThan(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({
      path: testInfo.outputPath(`cap-settings-${width}.png`),
      fullPage: true,
    });
    await save.click();
    await expect(page.getByText("2 项参数已保存到数据库并写入审计记录")).toBeVisible();
    expect(saves).toEqual(
      expect.arrayContaining([
        {
          key: "security.cap_endpoint",
          value: "https://cap.example.com/site-key/",
          reason: "配置新的 Cap 服务",
        },
        { key: "security.cap_secret", value: "test-only-secret", reason: "配置新的 Cap 服务" },
      ]),
    );
    await expect(secretInput).toHaveValue("");
    await expect(save).toBeDisabled();

    await endpointInput.fill("https://cap.example.com/another-site/");
    await reasonInput.fill("更换 Cap 站点保留密钥");
    await save.click();
    await expect(page.getByText("1 项参数已保存到数据库并写入审计记录")).toBeVisible();
    expect(saves).toHaveLength(3);
    expect(saves[2]).toMatchObject({
      key: "security.cap_endpoint",
      value: "https://cap.example.com/another-site/",
    });

    await endpointInput.fill("");
    await reasonInput.fill("清除 Cap Endpoint 配置");
    await save.click();
    await expect(page.getByText("1 项参数已保存到数据库并写入审计记录")).toBeVisible();
    await expect(save).toBeDisabled();
    expect(saves).toHaveLength(4);
    expect(saves[3]).toMatchObject({ key: "security.cap_endpoint", value: "" });
    expect(saves.filter(({ key }) => key === "security.cap_secret")).toHaveLength(1);
  });
}
