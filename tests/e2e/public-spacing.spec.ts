import { expect, type Locator, type Page, test } from "@playwright/test";

// Public/employee layout checks run without demo setup, real SMS, or real submissions.
test.use({ storageState: { cookies: [], origins: [] } });

async function publicFixture(page: Page) {
  await page.route(/:3100\//u, (route) =>
    route.fulfill({ status: 404, json: { message: "Unmocked spacing fixture API" } }),
  );
  await page.route("**/public/platform-branding", (route) =>
    route.fulfill({ json: { name: "间距验证平台", logoDataUrl: null } }),
  );
  await page.route("**/auth/captcha/password-challenge", (route) =>
    route.fulfill({ json: { required: false } }),
  );
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(() =>
      Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
    ),
  ).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
}

async function expectVerticalGap(before: Locator, after: Locator, min = 12, max = 32) {
  const first = await before.boundingBox();
  const second = await after.boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  const gap = (second?.y ?? 0) - ((first?.y ?? 0) + (first?.height ?? 0));
  expect(gap).toBeGreaterThanOrEqual(min);
  expect(gap).toBeLessThanOrEqual(max);
}

async function expectFormRhythm(page: Page) {
  const children = page.locator(".loginForm > :visible");
  for (let index = 1; index < (await children.count()); index++) {
    await expectVerticalGap(children.nth(index - 1), children.nth(index), 12, 24);
  }
  const button = page.locator('.loginForm button[type="submit"]');
  const box = await button.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeLessThanOrEqual(52);
  await expectNoOverflow(page);
}

for (const width of [1440, 390]) {
  test(`landing provides direct workspace registration at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await publicFixture(page);
    await page.goto("/");
    await expect(page.getByRole("link", { name: /创建工作空间/u })).toBeVisible();
    await expectNoOverflow(page);
    await page.getByRole("link", { name: /创建工作空间/u }).click();
    await expect(
      page.getByRole("heading", { name: "创建账号与工作空间", exact: true }),
    ).toBeVisible();
  });

  test(`password login keeps fields and errors spaced at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await publicFixture(page);
    await page.route("**/auth/admin/password-login", (route) =>
      route.fulfill({ status: 401, json: { message: "账号或密码不正确" } }),
    );
    await page.goto("/login");
    await page.getByLabel("账号", { exact: true }).fill("spacing_user");
    await page.getByLabel("密码", { exact: true }).fill("SpacingPassword123");
    await expectFormRhythm(page);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "账号或密码不正确" })).toContainText(
      "账号或密码不正确",
    );
    await expectFormRhythm(page);
  });

  test(`password registration keeps field rhythm at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await publicFixture(page);
    await page.route("**/auth/admin/register", (route) =>
      route.fulfill({ status: 409, json: { message: "账号已存在" } }),
    );
    await page.goto("/register");
    await page.getByLabel("账号", { exact: true }).fill("spacing_user");
    await page.getByLabel("你的名字").fill("测试成员");
    await page.getByLabel("工作空间名称").fill("测试团队");
    await page.getByLabel("密码", { exact: true }).fill("SpacingPassword123");
    await page.getByLabel("确认密码").fill("SpacingPassword123");
    await expectFormRhythm(page);
    await page.getByRole("button", { name: "注册并进入工作空间", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "账号已存在" })).toContainText(
      "账号已存在",
    );
    await expectFormRhythm(page);
  });

  test(`employee image, copy and publication controls are separated at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await publicFixture(page, "CLOSED");
    await page.addInitScript(() =>
      localStorage.setItem(
        "xhs-agentic:mvp-session:v1",
        JSON.stringify({
          mode: "FORMAL",
          tenantId: "tenant",
          enterpriseId: "enterprise",
          employeeToken: "mock-employee",
          employeePhone: "13800000001",
        }),
      ),
    );
    await page.route("**/auth/admin/refresh", (route) =>
      route.fulfill({ json: { accessToken: "mock-admin", expiresInSeconds: 3600 } }),
    );
    await page.route("**/auth/admin/session", (route) =>
      route.fulfill({
        json: {
          userId: "admin",
          phone: "13800000001",
          features: {},
          scopes: [
            {
              scopeType: "ENTERPRISE",
              role: { code: "ENTERPRISE_ADMIN", name: "企业管理员" },
              tenant: { id: "tenant", name: "示例集团" },
              enterprise: { id: "enterprise", name: "示例企业", tenantId: "tenant" },
              permissions: ["campaign.read"],
            },
          ],
        },
      }),
    );
    await page.route("**/spacing-employee.svg", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#f0dfd5"/></svg>',
      }),
    );
    const task = {
      id: "spacing-task",
      status: "AVAILABLE",
      contentVisible: true,
      enterprise: { id: "enterprise", name: "示例企业" },
      campaign: { id: "campaign", title: "员工专属图文", status: "ACTIVE" },
      visibleAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      firstViewedAt: null,
      copiedAt: null,
      downloadedAt: null,
      submittedAt: null,
      verifiedAt: null,
      publication: null,
      submissionFailureReason: "请核对图片后重新提交发布链接。",
      content: {
        title: "品牌分享",
        body: "可信品牌资料生成的员工专属文案。",
        synthetic: true,
        hashtags: ["品牌分享", "企业动态"],
        images: [
          {
            id: "image",
            imageUrl: "/spacing-employee.svg",
            width: 600,
            height: 800,
            mimeType: "image/svg+xml",
            byteSize: "100",
            synthetic: true,
          },
        ],
      },
    };
    await page.route("**/employee/tasks", (route) => route.fulfill({ json: [task] }));
    await page.route("**/employee/tasks/spacing-task/view", (route) =>
      route.fulfill({ json: task }),
    );
    let submitted = false;
    await page.route("**/employee/tasks/spacing-task/submissions", (route) => {
      submitted = true;
      task.status = "VERIFYING";
      return route.fulfill({ json: { status: "PENDING", failureReason: null } });
    });
    await page.goto("/prototype/employee");
    await expect(page.getByRole("button", { name: "保存独立图片" })).toBeVisible();
    await expectVerticalGap(page.locator(".employeeIdentityBar"), page.locator(".employeeMvpGrid"));
    await expectVerticalGap(
      page.locator(".employeeRepairNotice"),
      page.locator(".employeeContentGrid"),
    );
    await expectVerticalGap(
      page.locator(".employeeImageCard img"),
      page.getByRole("button", { name: "保存独立图片" }),
    );
    await expectVerticalGap(
      page.locator(".employeeCopyCard .hashtagRow"),
      page.getByRole("button", { name: "复制完整文案" }),
    );
    await expectVerticalGap(page.locator(".employeeContentGrid"), page.locator(".publicationForm"));
    await expectNoOverflow(page);
    await page.screenshot({
      path: test.info().outputPath(`employee-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "历史记录 0" }).click();
    await expect(page.locator(".employeeTaskDetail")).toContainText("还没有历史记录");
    await page.getByRole("button", { name: "当前任务 1" }).click();
    await page
      .getByLabel("小红书发布链接或分享文本")
      .fill("https://www.xiaohongshu.com/explore/spacing-test");
    await page.getByRole("button", { name: "提交发布链接", exact: true }).click();
    await expect(page.locator(".publicationReviewPending")).toContainText("链接正在核实");
    expect(submitted).toBe(true);
    await expectNoOverflow(page);
  });
}
