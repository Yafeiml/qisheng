import { expect, test } from "@playwright/test";

for (const scope of ["TENANT", "ENTERPRISE"]) {
  for (const width of [390, 1440]) {
    test(`${scope} sees truthful generation notice at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(() =>
        localStorage.setItem(
          "xhs-agentic:mvp-session:v1",
          JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
        ),
      );
      await page.route(/:3100\//u, (route) =>
        route.fulfill({ status: 404, json: { message: "Unmocked API" } }),
      );
      await page.route("**/auth/admin/refresh", (route) =>
        route.fulfill({ json: { accessToken: "mock-token", expiresInSeconds: 3600 } }),
      );
      await page.route("**/auth/admin/session", (route) =>
        route.fulfill({
          json: {
            userId: "mock-admin",
            phone: "13800000001",
            features: {},
            scopes: [
              {
                scopeType: scope,
                role: {
                  code: `${scope}_ADMIN`,
                  name: scope === "TENANT" ? "集团管理员" : "企业管理员",
                },
                tenant: { id: "tenant", name: "示例集团" },
                enterprise: scope === "ENTERPRISE" ? { id: "enterprise", name: "示例企业" } : null,
                inheritedEnterprises: [{ id: "enterprise", name: "示例企业" }],
                permissions: [
                  "campaign.read",
                  ...(scope === "TENANT" ? ["tenant.dashboard.read"] : []),
                ],
              },
            ],
          },
        }),
      );
      const endpoint = `/console/tenants/tenant${scope === "TENANT" ? "" : "/enterprises/enterprise"}/generation-status`;
      let sent = false;
      await page.route(`**${endpoint}`, (route) =>
        route.fulfill({
          json: {
            checkedAt: new Date().toISOString(),
            affectedEnterpriseCount: 1,
            notices: [
              {
                affectedEnterpriseCount: 1,
                notificationStatus: sent ? "SENT" : "PENDING",
                message: sent
                  ? "生成服务连续多轮重试仍未恢复，已暂停新的生成任务。已通知平台管理员处理，请稍后再试。"
                  : "生成服务连续多轮重试仍未恢复，已暂停新的生成任务。问题已记录，正在通知平台管理员处理。",
              },
            ],
          },
        }),
      );
      await page.goto("/console/campaigns");
      const notice = page.getByRole("status", { name: "生成服务提示" });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText("正在通知");
      await expect(notice).not.toContainText("已通知");
      await expect(notice).toContainText("已生成内容及其他业务功能可继续使用");
      const box = await notice.boundingBox();
      if (!box) throw new Error("Missing notice bounds");
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: testInfo.outputPath(`notice-${scope}-${width}.png`),
        fullPage: true,
      });
      sent = true;
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect(notice).toContainText("已通知平台管理员");
    });
  }
}
