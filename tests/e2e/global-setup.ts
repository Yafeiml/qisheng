import { existsSync, mkdirSync } from "node:fs";
import { chromium, type FullConfig } from "@playwright/test";
import { PrismaClient } from "@xhs-agentic/database";

const API_BASE_URL = "http://127.0.0.1:3100";
if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");

export default async function globalSetup(config: FullConfig): Promise<void> {
  const storageState = ".artifacts/mvp-storage-state.json";
  const prisma = new PrismaClient();
  mkdirSync(".artifacts", { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL: config.projects[0]?.use.baseURL as string });
    await page.goto("/console");
    const initialize = page.getByRole("button", { name: "初始化本机演示数据" });
    const overview = page.getByRole("heading", { level: 1, name: "管理总览" });
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("初始化本机演示数据") ||
        document.body.innerText.includes("管理总览"),
      undefined,
      { timeout: 30_000 },
    );
    if (await initialize.isVisible()) {
      await initialize.click();
    }
    await overview.waitFor({
      state: "visible",
      timeout: 30_000,
    });
    const session = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("xhs-agentic:mvp-session:v1") ?? "null"),
    );
    if (session?.adminToken && session?.tenantId && session?.enterpriseId) {
      const base = `${API_BASE_URL}/console/tenants/${session.tenantId}/enterprises/${session.enterpriseId}`;
      const headers = { authorization: `Bearer ${session.adminToken}` };
      await prisma.campaign.updateMany({
        data: {
          cancellationReason: "E2E 启动前清理上一轮测试活动",
          cancelledAt: new Date(),
          status: "CANCELLED",
        },
        where: {
          enterpriseId: session.enterpriseId,
          status: { in: ["ACTIVE", "APPROVED"] },
          tenantId: session.tenantId,
          title: { startsWith: "E2E " },
        },
      });
      const response = await page.request.post(`${base}/campaign-planning/draft/clear`, {
        headers,
      });
      if (!response.ok()) throw new Error("Could not clear the demo campaign draft before E2E");
    }
    await page.context().storageState({ path: storageState });
    if (!existsSync(storageState)) throw new Error("MVP browser storage state was not created");
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}
