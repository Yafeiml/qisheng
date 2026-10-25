import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");

const prisma = new PrismaClient();
const marker = `S9E2E${Date.now().toString(36).toUpperCase()}`;

test.describe
  .serial("Sprint 9 SaaS core browser flows", () => {
    test.afterAll(async () => {
      await prisma.$disconnect();
    });

    test("GEO page explains local coverage without external ranking claims", async ({ page }) => {
      await page.goto("/console/geo");
      await expect(page.getByRole("heading", { level: 1, name: "GEO 覆盖分析" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "资产资料完整度" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "最终文案交付覆盖" })).toBeVisible();
      await expect(page.locator("body")).toContainText("不承诺外部平台权重、排名或引用");
      await page.getByLabel("分析周期").selectOption("30");
      await page.getByRole("button", { name: /重新计算|计算中/u }).click();
      await expect(page.getByText("实体资产", { exact: true })).toBeVisible();
    });

    test("reviewer disposes warnings, regenerates one employee, reschedules, reopens and cancels", async ({
      page,
    }) => {
      test.setTimeout(90_000);

      const title = `${marker} 活动治理`;
      await page.goto("/console/campaigns/new");
      await expect(page.getByRole("heading", { level: 1, name: "创建营销活动" })).toBeVisible();
      await page.getByRole("button", { name: /活动内容/u }).click();
      await page.getByLabel("活动名称").fill(title);
      await page
        .getByLabel("主题和传播目标")
        .fill("生成全飞秒 Pro 小红书风格科普，强调规范评估、设备特点和个体差异。");
      await page.getByRole("button", { name: "下一步" }).click();
      await page.getByRole("button", { name: "下一步" }).click();
      await page
        .getByLabel("员工可查看素材的时间")
        .fill(localDateTime(new Date(Date.now() + 3 * 3_600_000)));
      await page.getByRole("button", { name: "下一步" }).click();
      await page.getByRole("button", { name: /生成 3 份独立图文/u }).click();
      await expect(page).toHaveURL(/\/console\/campaigns\/[0-9a-f-]+$/u, { timeout: 30_000 });
      await expect(page.getByText("等待审核", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      const campaignId = new URL(page.url()).pathname.split("/").at(-1);
      if (!campaignId) throw new Error("Expected a campaign id in the browser URL");
      const contents = await prisma.employeeContent.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          body: true,
          id: true,
          images: { orderBy: { sequence: "asc" }, select: { checksum: true } },
        },
        where: { campaignId },
      });
      expect(contents.length).toBeGreaterThanOrEqual(2);
      await prisma.employeeContent.updateMany({
        data: {
          riskAssessment: {
            notices: [],
            passed: false,
            replacedBlocks: [],
            warnings: ["E2E 审核提示：需要人工确认"],
          },
          status: "REVIEW_BLOCKED",
        },
        where: { id: { in: contents.slice(0, 2).map(({ id }) => id) } },
      });
      await page.reload();
      await page.getByRole("tab", { name: "内容审核" }).click();

      const firstContentId = contents[0]?.id;
      const secondContentId = contents[1]?.id;
      if (!firstContentId || !secondContentId) throw new Error("Expected two review contents");
      const secondContentBefore = contents[1];
      if (!secondContentBefore) throw new Error("Expected the second content snapshot");
      await page.getByLabel("选择员工内容").selectOption(firstContentId);
      await page.getByRole("button", { name: "人工确认可用", exact: true }).click();
      await page.getByLabel("人工检查说明（至少 4 个字）").fill("浏览器验证后接受风险警告");
      await page.getByRole("button", { name: "确认人工检查通过" }).click();
      await expect(
        page.getByRole("status").filter({ hasText: "这份图文已人工确认可用" }),
      ).toBeVisible();

      await page.getByLabel("选择员工内容").selectOption(secondContentId);
      await page.getByRole("button", { name: "重生成图文", exact: true }).click();
      await page.getByLabel("图文修改要求（至少 4 个字）").fill("降低承诺语气并补充个体差异说明");
      await page.getByRole("button", { name: "确认重生成图文" }).click();
      await expect(page.getByRole("status").filter({ hasText: "已进入重生成队列" })).toBeVisible();
      await expect
        .poll(
          async () =>
            (
              await prisma.employeeContent.findUniqueOrThrow({
                select: { revision: true },
                where: { id: secondContentId },
              })
            ).revision,
          { timeout: 30_000 },
        )
        .toBe(2);
      const revisionSnapshot = await prisma.employeeContentRevision.findFirstOrThrow({
        where: { employeeContentId: secondContentId, revision: 1 },
      });
      const snapshot = revisionSnapshot.snapshot as {
        body?: unknown;
        images?: Array<{ checksum?: unknown }>;
      };
      expect(snapshot.body).toBe(secondContentBefore.body);
      expect(snapshot.images?.map(({ checksum }) => checksum)).toEqual(
        secondContentBefore.images.map(({ checksum }) => checksum),
      );
      await page.reload();

      const campaignScope = await prisma.campaign.findUniqueOrThrow({
        select: { enterpriseId: true },
        where: { id: campaignId },
      });
      const occupiedWindow = await prisma.campaign.findFirst({
        orderBy: { expiresAt: "desc" },
        select: { expiresAt: true },
        where: {
          enterpriseId: campaignScope.enterpriseId,
          id: { not: campaignId },
          status: { in: ["ACTIVE", "APPROVED"] },
        },
      });
      const approvalTime = new Date(
        Math.max(Date.now() + 4 * 3_600_000, (occupiedWindow?.expiresAt.getTime() ?? 0) + 60_000),
      );
      const rescheduledTime = new Date(approvalTime.getTime() + 3_600_000);

      await page.getByLabel("员工可查看素材的时间").fill(localDateTime(approvalTime));
      await page.getByRole("button", { name: "确认排期发布" }).click();
      await page
        .getByRole("dialog", { name: "确认本期内容排期发布？" })
        .getByRole("button", { exact: true, name: "确认排期发布" })
        .click();
      await expect(page.getByRole("heading", { name: "活动已批准" })).toBeVisible();

      await page.getByLabel("新的员工开放时间").fill(localDateTime(rescheduledTime));
      await page.getByRole("button", { name: "保存改期" }).click();
      await page.getByLabel("改期说明").fill("浏览器验证统一改期");
      await page.getByRole("button", { name: "确认修改开放时间" }).click();
      await expect(page.getByText("员工开放时间和提交截止时间已同步更新")).toBeVisible();

      await page.getByRole("button", { name: "撤销批准并重新审核" }).click();
      await page.getByLabel("撤销原因").fill("浏览器验证撤销批准");
      await page.getByRole("button", { name: "撤销通过并重新审核" }).click();
      await expect(page.getByRole("heading", { name: "审核通过并安排开放" })).toBeVisible();

      await page.getByRole("button", { exact: true, name: "取消活动" }).click();
      await page.getByLabel("取消原因").fill("浏览器验收完成后取消活动");
      await page.getByRole("button", { name: "确认取消活动" }).click();
      await expect(page.getByRole("heading", { name: "活动已取消" })).toBeVisible();
      await expect(page.getByText("活动已取消", { exact: false }).first()).toBeVisible();
    });
  });

function localDateTime(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
