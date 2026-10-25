import { expect, type Locator, type Page, test } from "@playwright/test";

// Isolate all identities and writes: these checks never change a real customer's settings.

async function verticalGap(before: Locator, after: Locator) {
  const [first, second] = await Promise.all([before.boundingBox(), after.boundingBox()]);
  if (!first || !second) throw new Error("Expected both spaced elements to be rendered");
  return second.y - first.y - first.height;
}

async function noHorizontalOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
}

async function readbackFixture(page: Page) {
  const operations = {
    paused: false,
    reason: null,
    today: "2026-09-27",
    dailyLimit: 200,
    total: 0,
    queued: 0,
    retrying: 0,
    leased: 0,
    completed: 0,
    needsReview: 0,
    budget: [],
    jobs: [],
    onlineNodes: 1,
    nodes: [
      {
        id: "spacing-node",
        online: true,
        lastSeenAt: "2026-09-27T02:00:00Z",
        panelHost: null,
        panelUrl: null,
      },
    ],
  };
  const saves: Record<string, unknown>[] = [];
  await page.route("**/platform/publication-readback/operations", (route) =>
    route.fulfill({ json: operations }),
  );
  await page.route("**/platform/publication-readback/daily-limit", (route) => {
    const body = route.request().postDataJSON();
    saves.push(body);
    operations.dailyLimit = body.dailyLimit;
    return route.fulfill({ json: operations });
  });
  return saves;
}

for (const width of [1440, 390]) {
  test(`readback panels and form rhythm stay aligned at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const saves = await readbackFixture(page);
    await page.goto("/platform/readback");
    const nodes = page.locator("article.panel").filter({
      has: page.getByRole("heading", { name: "采集节点", exact: true }),
    });
    const budget = page.locator("article.panel").filter({
      has: page.getByRole("heading", { name: "工作单额度设置", exact: true }),
    });
    const limit = budget.getByLabel("每日领取上限");
    await expect(limit).toHaveValue("200");
    const nodesBox = await nodes.boundingBox();
    const budgetBox = await budget.boundingBox();
    if (!nodesBox || !budgetBox) throw new Error("Readback panels did not render");
    if (width > 850) {
      expect(Math.abs(nodesBox.y - budgetBox.y)).toBeLessThanOrEqual(1);
    } else {
      const gap = await verticalGap(nodes, budget);
      expect(gap).toBeGreaterThanOrEqual(14);
      expect(gap).toBeLessThanOrEqual(24);
    }

    const fields = budget.locator("form > .field");
    const fieldGap = await verticalGap(fields.nth(0), fields.nth(1));
    expect(fieldGap).toBeGreaterThanOrEqual(12);
    expect(fieldGap).toBeLessThanOrEqual(22);
    const save = budget.getByRole("button", { name: "保存额度", exact: true });
    const buttonGap = await verticalGap(fields.nth(1), save);
    expect(buttonGap).toBeGreaterThanOrEqual(12);
    expect(buttonGap).toBeLessThanOrEqual(22);
    await expect(save).toBeDisabled();
    await limit.fill("320");
    await budget.getByLabel("变更原因").fill("调整测试预算");
    await expect(save).toBeEnabled();
    await save.focus();
    await expect(save).toBeFocused();
    await save.click();
    await expect(page.getByRole("status")).toContainText("每日工作单上限已更新为 320");
    expect(saves).toEqual([{ dailyLimit: 320, reason: "调整测试预算" }]);
    await noHorizontalOverflow(page, width);
    await budget.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`readback-spacing-${width}.png`) });
  });
}
