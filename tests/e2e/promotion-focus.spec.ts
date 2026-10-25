import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`material recommendations can be reviewed, confirmed and edited at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.addInitScript(() =>
      localStorage.setItem(
        "xhs-agentic:mvp-session:v1",
        JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
      ),
    );
    await page.route(/:3100\//u, (route) =>
      route.fulfill({ status: 404, json: { message: "Unmocked focus fixture" } }),
    );
    await page.route("**/auth/admin/refresh", (route) =>
      route.fulfill({ json: { accessToken: "fixture", expiresInSeconds: 3600 } }),
    );
    await page.route("**/auth/admin/session", (route) =>
      route.fulfill({
        json: {
          userId: "admin",
          phone: "13800000000",
          features: {},
          scopes: [
            {
              scopeType: "ENTERPRISE",
              role: { code: "ENTERPRISE_ADMIN", name: "企业管理员" },
              tenant: { id: "tenant", name: "测试集团" },
              enterprise: { id: "enterprise", name: "测试企业", tenantId: "tenant" },
              permissions: ["geo.read", "geo.manage", "material.read", "material.manage"],
            },
          ],
        },
      }),
    );
    let rows: Record<string, unknown>[] = [];
    let saved: Record<string, unknown> | null = null;
    await page.route("**/console/tenants/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      let json: unknown = [];
      if (path.endsWith("/generation-status")) json = { notices: [], affectedEnterpriseCount: 0 };
      if (path.endsWith("/focus-recommendations"))
        json = rows.length
          ? []
          : [
              {
                name: "周示例",
                aliases: ["周教授"],
                type: "DOCTOR",
                materialId: "material",
                materialTitle: "专家介绍",
                enterpriseId: "enterprise",
                evidence: "资料中说明：周示例教授。",
              },
            ];
      if (path.endsWith("/geo-entities") && route.request().method() === "GET") json = rows;
      if (route.request().method() === "POST") {
        saved = route.request().postDataJSON();
        rows = [
          {
            ...saved,
            id: "focus",
            tenantId: "tenant",
            enterpriseId: "enterprise",
            seriesId: "series",
            version: path.endsWith("/versions") ? 2 : 1,
            status: "ACTIVE",
            topics: [],
          },
        ];
        json = rows[0];
      }
      return route.fulfill({ json });
    });
    await page.goto("/console/compliance?tab=focus");
    const recommendations = page.getByRole("region", { name: "从资料推荐宣传重点" });
    await expect(recommendations.getByText("周示例", { exact: true })).toBeVisible();
    await expect(
      page.getByText("可选设置。先从已有资料确认名称，活动按相关性匹配；不设置也能正常生成。"),
    ).toBeVisible();
    const add = recommendations.getByRole("button", { name: "确认添加" });
    await expect(add).toHaveCSS("align-items", "center");
    expect((await add.boundingBox())?.height).toBeLessThanOrEqual(40);
    await add.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByLabel("名称", { exact: true })).toHaveValue("周示例");
    await drawer.getByLabel("名称", { exact: true }).fill("周示例教授");
    const category = drawer.getByRole("combobox", { name: "类别", exact: true });
    await category.selectOption("DOCTOR");
    await expect(category).toHaveCSS("appearance", "none");
    await expect(drawer.getByLabel("其他称呼（逗号分隔，可选）")).toHaveValue("周教授");
    await page.screenshot({ path: `.artifacts/focus-drawer-${width}.png`, fullPage: true });
    await drawer.getByRole("button", { name: "确认添加", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    expect(saved).toMatchObject({ name: "周示例教授", aliases: ["周教授"], type: "DOCTOR" });
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await drawer.getByLabel("其他称呼（逗号分隔，可选）").fill("周教授, 刘老师");
    await drawer.getByLabel("版本变更说明").fill("补充常用称呼");
    await drawer.getByRole("button", { name: "保存修改" }).click();
    await expect(drawer).toHaveCount(0);
    expect(saved).toMatchObject({ aliases: ["周教授", "刘老师"] });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: `.artifacts/focus-list-${width}.png`, fullPage: true });
  });
}
