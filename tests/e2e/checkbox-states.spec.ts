import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("every checkbox template has an audited page or drawer scenario", () => {
  const root = resolve("apps/admin-web/app");
  const sites: Record<string, number> = {};
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.name.endsWith(".tsx")) {
        const count = [...readFileSync(file, "utf8").matchAll(/type=["']checkbox["']/gu)].length;
        if (count) sites[relative(root, file).replaceAll("\\", "/")] = count;
      }
    }
  };
  scan(root);
  expect(sites).toEqual({
    "components/medical-selection-form.tsx": 1,
    "console/access/page.tsx": 1,
    "console/campaigns/new/page.tsx": 3,
    "console/employees/page.tsx": 5,
    "console/materials/page.tsx": 5,
    "employee/page.tsx": 1,
    "platform/generation-lab/page.tsx": 1,
    "platform/settings/content-style/page.tsx": 2,
    "setup/page.tsx": 1,
  });
});

test("the shared checkbox contract also styles new unclassified controls and accessibility states", async ({
  page,
}) => {
  await page.route(/:3100\//u, (route) => route.fulfill({ status: 404, json: {} }));
  await page.goto("/login");
  // Deliberately omit a checkbox class: new native inputs must receive the same
  // treatment, including when generic field/filter input styles are present.
  await page.evaluate(() => {
    const section = document.createElement("section");
    section.dataset.testid = "checkbox-contract";
    for (const className of ["", "field", "workspaceFilters", "checkboxField"]) {
      const label = document.createElement("label");
      label.className = className;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("aria-label", className || "unclassified");
      label.append(input, document.createTextNode("选择项"));
      section.append(label);
    }
    document.body.append(section);
  });
  const controls = page.getByTestId("checkbox-contract").getByRole("checkbox");
  for (const checkbox of await controls.all()) {
    await expect(checkbox).toHaveCSS("width", "16px");
    await expect(checkbox).toHaveCSS("height", "16px");
    await expect(checkbox).toHaveCSS("padding", "0px");
    await expect(checkbox).toHaveCSS("appearance", "none");
    await expect(checkbox).toHaveCSS("border-radius", "2px");
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toHaveCSS("outline-style", "solid");
  }
  const checkbox = controls.first();
  await checkbox.evaluate((element: HTMLInputElement) => {
    element.indeterminate = true;
  });
  expect(
    await checkbox.evaluate((element) => {
      const mark = getComputedStyle(element, "::after");
      return { height: mark.height, transform: mark.transform, opacity: mark.opacity };
    }),
  ).toEqual({ height: "2px", transform: "none", opacity: "1" });
  await checkbox.evaluate((element: HTMLInputElement) => {
    element.disabled = true;
  });
  await expect(checkbox).toHaveCSS("cursor", "not-allowed");
  await expect(checkbox).toHaveCSS("opacity", "0.55");
  await page.emulateMedia({ forcedColors: "active" });
  await expect(checkbox).toHaveCSS("appearance", "auto");
  await expect(checkbox).toHaveCSS("opacity", "1");
  expect(await checkbox.evaluate((element) => getComputedStyle(element, "::after").content)).toBe(
    "none",
  );
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
  await expect(checkbox).toHaveCSS("transition-duration", "0s");
});
