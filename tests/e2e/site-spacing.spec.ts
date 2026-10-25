import { readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

// Existing local demo identity only. Never invoke the data-mutating global setup.
test.use({
  storageState: ".artifacts/mvp-storage-state.json",
  screenshot: "off",
  trace: "off",
  video: "off",
});

function pageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return pageFiles(path);
    return entry.name === "page.tsx" ? [path] : [];
  });
}

const appDirectory = resolve("apps/admin-web/app");
const staticAdminRoutes = ["console", "platform"].flatMap((area) =>
  pageFiles(join(appDirectory, area))
    .filter((path) => !path.includes("["))
    .map((path) => `/${relative(appDirectory, path).replace(/\/page\.tsx$/u, "")}`),
);
type Target = { path: string; label: string; admin: boolean };
type Measurement = Awaited<ReturnType<typeof measureLayout>>;
type RecordEntry = {
  route: string;
  resolvedRoute: string;
  view: string;
  measurement: Measurement;
};

function anonymousPath(path: string) {
  return path
    .replace(/(\/console\/campaigns\/)(?!new(?:\/|$))[^/]+/u, "$1[campaignId]")
    .replace(/\b[a-z0-9]{22,}\b/gu, "[id]");
}

async function measureLayout(page: Page, admin: boolean) {
  return page.evaluate((isAdmin) => {
    const root = document.querySelector<HTMLElement>(isAdmin ? ".appWorkspace" : "main");
    if (!root) throw new Error("Actual page content is missing");
    const round = (value: number) => Math.round(value * 100) / 100;
    const description = (node: Element) =>
      node.tagName.toLowerCase() +
      Array.from(node.classList)
        .map((name) => `.${name}`)
        .join("");
    const normalVisible = (node: Element) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return (
        box.width > 0 &&
        box.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        !["absolute", "fixed"].includes(style.position) &&
        !node.matches(".appHeader,script,style,link")
      );
    };
    const sections = Array.from(root.children)
      .filter(normalVisible)
      .map((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          element: description(node),
          top: round(box.top + window.scrollY),
          bottom: round(box.bottom + window.scrollY),
          left: round(box.left),
          right: round(box.right),
          marginTop: style.marginTop,
          marginBottom: style.marginBottom,
        };
      });
    const sectionGaps = sections.slice(1).map((section, index) => ({
      before: sections[index].element,
      after: section.element,
      gap: round(section.top - sections[index].bottom),
    }));
    const innerCandidates: { parent: string; before: string; after: string; gap: number }[] = [];
    const scanParents = [root, ...root.querySelectorAll("form,section,article,aside,fieldset")];
    const controlBlock = (node: Element) =>
      node.matches(
        "label,form,fieldset,button,input,select,textarea,.fieldGrid,.buttonRow,.workspaceActionButtons",
      );
    for (const parent of scanParents) {
      const elements = Array.from(parent.children).filter(normalVisible);
      for (let index = 1; index < elements.length; index++) {
        const before = elements[index - 1];
        const after = elements[index];
        if (!controlBlock(before) && !controlBlock(after)) continue;
        const first = before.getBoundingClientRect();
        const second = after.getBoundingClientRect();
        const overlap = Math.min(first.right, second.right) - Math.max(first.left, second.left);
        const gridContent = after.matches(".fieldGrid")
          ? Array.from(after.children).filter(normalVisible)
          : [];
        // A borderless grid wrapper can touch its predecessor while its fields
        // still have deliberate top margins; measure that first visible edge.
        const contentTop = gridContent.length
          ? Math.min(...gridContent.map((child) => child.getBoundingClientRect().top))
          : second.top;
        const gap = contentTop - first.bottom;
        if (
          second.top > first.top + 1 &&
          overlap > Math.min(first.width, second.width) / 2 &&
          gap < 6
        ) {
          innerCandidates.push({
            parent: description(parent),
            before: description(before),
            after: description(after),
            gap: round(gap),
          });
        }
      }
    }
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      root: description(root),
      sections,
      sectionGaps,
      innerCandidates,
      formCount: root.querySelectorAll("form").length,
      selectionCount: root.querySelectorAll("select,input[type=checkbox],input[type=radio]").length,
      actionCount: root.querySelectorAll("button,a[class*=Button]").length,
    };
  }, admin);
}

for (const width of [1440, 390]) {
  test(`all rendered site sections retain spacing at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(360_000);
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(25_000);
    await page.setViewportSize({ width, height: 1000 });
    const records: RecordEntry[] = [];
    const errors: { route: string; reason: string }[] = [];
    const apiIssues: { method: string; path: string; status: number }[] = [];
    const preventedWrites: { method: string; path: string }[] = [];
    const isolatedAutoRequests: { method: string; path: string }[] = [];
    const scriptErrors: { route: string; kind: string }[] = [];
    const settingsSlugs = new Set<string>();
    const campaignLinks = new Set<string>();
    const pendingApiRequests = new Set<object>();
    let lastApiActivity = Date.now();
    let completedApiRequests = 0;

    page.on("request", (request) => {
      if (new URL(request.url()).port !== "3100") return;
      pendingApiRequests.add(request);
      lastApiActivity = Date.now();
    });
    const finishRequest = (request: object) => {
      if (!pendingApiRequests.delete(request)) return;
      lastApiActivity = Date.now();
      completedApiRequests++;
    };
    page.on("requestfinished", finishRequest);
    page.on("requestfailed", finishRequest);
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      // Redirects can discard an old document without delivering every fetch
      // completion callback. Never carry its pending work into the new page.
      pendingApiRequests.clear();
      lastApiActivity = Date.now();
    });
    await page.route(/:3100\//u, (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const isSessionRenewal = [
        "/auth/admin/refresh",
        "/auth/dev/admin-token",
        "/auth/dev/employee-bind",
      ].includes(path);
      if (["GET", "HEAD", "OPTIONS"].includes(request.method()) || isSessionRenewal)
        return route.continue();
      const autoPreview = path.endsWith("/campaigns/preflight")
        ? { ready: false, checks: [] }
        : path.endsWith("/campaigns/retrieval-preview")
          ? { hits: [], query: "", contextCharacters: 0, strategyVersion: "spacing-audit" }
          : path.endsWith("/campaign-planning/draft")
            ? {}
            : null;
      if (autoPreview) {
        // The creation page runs these automatically; keep every one in memory.
        // No draft is saved, retrieval performed, or generation started by this audit.
        isolatedAutoRequests.push({ method: request.method(), path: anonymousPath(path) });
        return route.fulfill({ json: autoPreview });
      }
      preventedWrites.push({ method: request.method(), path: anonymousPath(path) });
      return route.fulfill({
        status: 409,
        json: { message: "Read-only spacing audit prevented a business write" },
      });
    });
    page.on("pageerror", (error) => {
      scriptErrors.push({ route: anonymousPath(new URL(page.url()).pathname), kind: error.name });
    });
    page.on("response", async (response) => {
      const url = new URL(response.url());
      if (url.port !== "3100") return;
      if (response.status() >= 400)
        apiIssues.push({
          method: response.request().method(),
          path: anonymousPath(url.pathname),
          status: response.status(),
        });
      if (url.pathname === "/platform/settings" && response.ok()) {
        try {
          const data = (await response.json()) as { groups?: { slug: string }[] };
          for (const group of data.groups ?? []) settingsSlugs.add(group.slug);
        } catch {
          // Cancelled navigation is retried through another settings route below.
        }
      }
    });
    const settle = async () => {
      const enteredAt = Date.now();
      // Campaign filters debounce for 250ms. The old document's networkidle
      // state can already be true before those requests start, so require an
      // actual fresh quiet window and no pending API work after every change.
      await expect
        .poll(
          () =>
            pendingApiRequests.size === 0 &&
            Date.now() - Math.max(lastApiActivity, enteredAt) >= 500,
          { timeout: 15_000, intervals: [100, 150, 200] },
        )
        .toBe(true);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    };
    const record = async (target: Target, view: string) => {
      await page.evaluate(() => window.scrollTo(0, 0));
      const measurement = await measureLayout(page, target.admin);
      if (target.path === "/console/campaigns") {
        const hrefs = await page
          .locator('a[href^="/console/campaigns/"]')
          .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
        for (const href of hrefs)
          if (href && href !== "/console/campaigns/new") campaignLinks.add(href);
      }
      records.push({
        route: target.label,
        resolvedRoute: anonymousPath(new URL(page.url()).pathname),
        view,
        measurement,
      });
      console.info(
        `[spacing ${width}] ${target.label} ${view}: ${measurement.sections.length} sections`,
      );
      const tightSections = target.admin
        ? measurement.sectionGaps.filter(({ gap }) => gap < 13.5)
        : [];
      if (tightSections.length || measurement.documentWidth > width)
        errors.push({
          route: `${target.label} (${view})`,
          reason:
            "tight section gaps: " +
            (tightSections.map(({ gap }) => gap).join(",") || "none") +
            "; document " +
            measurement.documentWidth +
            "px / viewport " +
            width +
            "px",
        });
    };
    const visit = async (target: Target) => {
      let phase = "navigation";
      console.info(`[spacing ${width}] opening ${target.label}`);
      try {
        pendingApiRequests.clear();
        lastApiActivity = Date.now();
        const response = await page.goto(target.path, { waitUntil: "domcontentloaded" });
        if (!response || response.status() >= 400) {
          errors.push({
            route: target.label,
            reason: `Page HTTP status ${response?.status() ?? "missing"}`,
          });
          return;
        }
        phase = "content-root";
        await expect(page.locator(target.admin ? ".appWorkspace" : "main").first()).toBeVisible({
          timeout: 25_000,
        });
        if (await page.locator(".next-error-h1").count()) {
          errors.push({ route: target.label, reason: "Next error page, not actual content" });
          return;
        }
        phase = "initial-data";
        await settle();

        if (target.label === "/console/campaigns/[campaignId]")
          await expect(page.locator(".campaignMeta")).toBeVisible();
        await record(target, "default");

        const tabs = page.locator('.appWorkspace [role="tab"]');
        const tabCount = await tabs.count();
        for (let index = 0; index < tabCount; index++) {
          phase = `tab-${index + 1}`;
          const tab = tabs.nth(index);
          if (!(await tab.isVisible()) || !(await tab.isEnabled())) continue;
          if ((await tab.getAttribute("aria-selected")) === "true") continue;
          await tab.click();
          await settle();
          await record(target, `tab-${index + 1}`);
        }
        if (target.path === "/console/campaigns") {
          phase = "archive-filter";
          // Local test data can all be archived; the default working list is
          // intentionally empty even though valid historical details exist.
          await page.getByRole("tab", { name: "全部", exact: true }).click();
          await page.locator(".campaignAdvancedFilters > summary").click();
          await page.locator(".campaignAdvancedFilters select").nth(1).selectOption("ALL");
          await settle();
          await record(target, "all-including-archived");
        }
      } catch (error) {
        // Framework errors can contain business text; retain only the failure kind.
        const reason = `${phase}: ${error instanceof Error ? error.name : "unknown"}; pending=${pendingApiRequests.size}`;
        console.info(`[spacing ${width}] ${target.label} failed at ${reason}`);
        errors.push({
          route: target.label,
          reason,
        });
      }
    };
    for (const path of staticAdminRoutes) await visit({ path, label: path, admin: true });
    if (settingsSlugs.size === 0)
      await visit({
        path: "/platform/settings/general",
        label: "/platform/settings/general",
        admin: true,
      });
    const knownStaticPaths = new Set(staticAdminRoutes);
    for (const slug of [...settingsSlugs].sort()) {
      const path = `/platform/settings/${slug}`;
      if (!knownStaticPaths.has(path)) await visit({ path, label: path, admin: true });
    }
    if (settingsSlugs.size === 0)
      errors.push({
        route: "/platform/settings/[group]",
        reason: "Settings group catalog unavailable; coverage incomplete",
      });

    const campaign = [...campaignLinks][0];
    if (campaign) {
      await visit({ path: campaign, label: "/console/campaigns/[campaignId]", admin: true });
    } else {
      errors.push({
        route: "/console/campaigns/[campaignId]",
        reason: "No existing campaign detail link; empty or unavailable data",
      });
    }
    for (const path of ["/", "/login", "/register", "/prototype/employee"])
      await visit({ path, label: path, admin: false });
    const reportPath = testInfo.outputPath(`site-spacing-${width}.json`);
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          viewportWidth: width,
          staticAdminRoutes,
          settingsGroups: [...settingsSlugs].sort(),
          coveredStates: records.length,
          records,
          apiIssues,
          completedApiRequests,
          preventedWrites,
          isolatedAutoRequests,
          scriptErrors,
          errors,
        },
        null,
        2,
      ),
    );
    await testInfo.attach(`site-spacing-${width}`, {
      path: reportPath,
      contentType: "application/json",
    });
    // Avoid recording business text in Playwright's automatic error-context snapshot.
    await page.goto("about:blank");
    expect(errors, `Read-only site spacing report: ${reportPath}`).toEqual([]);
    expect(preventedWrites, "Page navigation must not attempt business writes").toEqual([]);
    expect(scriptErrors, "Every inspected page must render without a JavaScript failure").toEqual(
      [],
    );
    expect(
      apiIssues.filter(
        ({ method, path, status }) =>
          !(method === "GET" && path.endsWith("/available-models") && status === 409),
      ),
      // A locally unconfigured provider has an intentional 409 UI state.
      // Successful discovery is separately covered by model-configuration.spec.ts.
      "Unexpected API failures would hide normal-state spacing coverage",
    ).toEqual([]);
  });
}
