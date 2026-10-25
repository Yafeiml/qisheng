import { expect, type Locator, type Page, test } from "@playwright/test";
import { defaultGenerationStyles } from "../../packages/ai-gateway/src/generation-style";

// Every identity, configuration and submission request is mocked.

async function expectCompactCheckbox(checkbox: Locator) {
  await expect(checkbox).toBeVisible();
  await expect(checkbox).toHaveCSS("appearance", "none");
  await expect(checkbox).toHaveCSS("padding", "0px");
  const geometry = await checkbox.evaluate((element) => {
    const input = element as HTMLInputElement;
    const box = input.getBoundingClientRect();
    const parent = input.parentElement;
    if (!parent) throw new Error("Checkbox label is missing");
    const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode && !textNode.textContent?.trim()) textNode = walker.nextNode();
    if (!textNode) throw new Error("Checkbox label text is missing");
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const textBox = range.getClientRects()[0];
    if (!textBox) throw new Error("Checkbox label has no visible first line");
    const style = getComputedStyle(input);
    return {
      width: box.width,
      height: box.height,
      radius: Number.parseFloat(style.borderTopLeftRadius),
      border: Number.parseFloat(style.borderTopWidth),
      textGap: textBox.left - box.right,
      centerDifference: Math.abs(box.top + box.height / 2 - textBox.top - textBox.height / 2),
    };
  });
  expect(geometry.width).toBe(16);
  expect(geometry.height).toBe(16);
  expect(geometry.radius).toBeGreaterThanOrEqual(2);
  expect(geometry.radius).toBeLessThanOrEqual(4);
  expect(geometry.border).toBeGreaterThanOrEqual(1);
  expect(geometry.border).toBeLessThanOrEqual(1.5);
  expect(geometry.textGap).toBeGreaterThanOrEqual(6);
  expect(geometry.textGap).toBeLessThanOrEqual(16);
  expect(geometry.centerDifference).toBeLessThanOrEqual(2);
}

async function exerciseCheckbox(page: Page, checkbox: Locator) {
  await checkbox.uncheck();
  await page.mouse.move(0, 0);
  await expectCompactCheckbox(checkbox);
  await expect(checkbox).toHaveCSS("border-top-color", "rgb(133, 133, 133)");
  const uncheckedSurface = await checkbox.evaluate((element) => {
    const probe = document.createElement("i");
    probe.style.backgroundColor = "var(--surface)";
    element.parentElement?.append(probe);
    const surface = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return surface;
  });
  await expect
    .poll(() => checkbox.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe(uncheckedSurface);
  const uncheckedBorder = await checkbox.evaluate(
    (element) => getComputedStyle(element).borderTopColor,
  );
  await checkbox.hover();
  await expect
    .poll(() => checkbox.evaluate((element) => getComputedStyle(element).borderTopColor))
    .not.toBe(uncheckedBorder);
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeFocused();
  await expect(checkbox).toHaveCSS("outline-style", "solid");
  await expect(checkbox).toHaveCSS("outline-width", "2px");
  await expect(checkbox).toHaveCSS("color", "rgb(255, 255, 255)");
  const checkedAccent = await checkbox.evaluate((element) => {
    const probe = document.createElement("i");
    probe.style.backgroundColor = "var(--accent)";
    element.parentElement?.append(probe);
    const accent = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return accent;
  });
  // The product intentionally animates both colors for 150ms. Assert their
  // final normalized CSS values rather than sampling an interpolation frame.
  await expect
    .poll(() =>
      checkbox.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, border: style.borderTopColor };
      }),
    )
    .toEqual({ background: checkedAccent, border: checkedAccent });
  await expectCompactCheckbox(checkbox);
  await page.keyboard.press("Space");
  await expect(checkbox).not.toBeChecked();
}

async function expectDisabledCheckbox(checkbox: Locator) {
  await expect(checkbox).toBeDisabled();
  await expectCompactCheckbox(checkbox);
  await expect(checkbox).toHaveCSS("cursor", "not-allowed");
  expect(
    await checkbox.evaluate((element) => Number(getComputedStyle(element).opacity)),
  ).toBeLessThan(1);
  const checked = await checkbox.isChecked();
  // Deliberately hit a disabled label: bypass Playwright's actionability wait,
  // not the browser's native disabled semantics, and ensure it cannot toggle.
  await checkbox.locator("..").click({ force: true });
  expect(await checkbox.isChecked()).toBe(checked);
}

async function expectNoOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
}

async function stylesFixture(page: Page) {
  let config = { ...defaultGenerationStyles(), version: 0 };
  const writes: (typeof config)[] = [];
  await page.route("**/platform/generation-styles", (route) => {
    if (route.request().method() === "POST") {
      const next = route.request().postDataJSON();
      writes.push(next);
      config = { ...next, version: config.version + 1 };
    }
    return route.fulfill({ json: config });
  });
  return writes;
}

for (const width of [1440, 390]) {
  test(`both style drawers keep enabled/default checkbox states accessible at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const writes = await stylesFixture(page);
    await page.goto("/platform/settings/content-style");
    for (const kind of ["内容方向", "图片风格"] as const) {
      if (kind === "图片风格") await page.getByRole("tab", { name: /图片风格/u }).click();
      await page.getByRole("button", { name: `新增${kind}`, exact: true }).click();
      const drawer = page.getByRole("dialog");
      await drawer
        .getByRole("textbox", { name: "预设名称", exact: true })
        .fill(`复选框验收${kind}`);
      await drawer
        .getByRole("textbox", { name: "生成提示词", exact: true })
        .fill("依据企业品牌事实生成清晰可靠的内容。");
      const enabled = drawer.getByRole("checkbox", { name: "启用，供新活动选择", exact: true });
      const defaultOption = drawer.getByRole("checkbox", { name: "设为默认", exact: true });
      await exerciseCheckbox(page, enabled);
      await expectDisabledCheckbox(defaultOption);
      await enabled.check();
      await exerciseCheckbox(page, defaultOption);
      await defaultOption.check();
      await expectDisabledCheckbox(enabled);
      await drawer.screenshot({
        path: testInfo.outputPath(`${kind}-checked-disabled-${width}.png`),
      });
      await drawer.getByRole("button", { name: "保存预设", exact: true }).click();
      await expect(drawer).toHaveCount(0);
      const key = kind === "内容方向" ? "contentDirections" : "imageStyles";
      expect(writes.at(-1)?.[key].find((item) => item.name === `复选框验收${kind}`)).toMatchObject({
        enabled: true,
        isDefault: true,
      });
      const card = page.getByRole("article").filter({
        has: page.getByRole("heading", { name: `复选框验收${kind}`, exact: true }),
      });
      await card.getByRole("button", { name: "编辑", exact: true }).click();
      await expectDisabledCheckbox(enabled);
      await expectDisabledCheckbox(defaultOption);
      await expectNoOverflow(page, width);
      await drawer.getByRole("button", { name: `关闭编辑${kind}`, exact: true }).click();
    }
  });
}
