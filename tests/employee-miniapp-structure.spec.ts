import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const miniappRoot = resolve(process.cwd(), "apps/employee-miniapp");
const nativeComponents = new Set([
  "block",
  "button",
  "image",
  "input",
  "label",
  "scroll-view",
  "text",
  "textarea",
  "view",
]);

describe("employee native mini program structure", () => {
  it("declares complete TypeScript page bundles", () => {
    const configuration = jsonFile<{ pages: string[] }>("app.json");

    expect(configuration.pages).toEqual([
      "pages/login/login",
      "pages/tasks/tasks",
      "pages/task-detail/task-detail",
    ]);
    for (const page of configuration.pages) {
      for (const extension of ["json", "ts", "wxml", "wxss"]) {
        expect(existsSync(resolve(miniappRoot, `${page}.${extension}`))).toBe(true);
      }
    }
  });

  it("uses native WXML components instead of browser-only HTML tags", () => {
    const configuration = jsonFile<{ pages: string[] }>("app.json");
    for (const page of configuration.pages) {
      const source = readFileSync(resolve(miniappRoot, `${page}.wxml`), "utf8");
      const tags = [...source.matchAll(/<\/?([a-z][\w-]*)\b/gu)].map((match) => match[1]);
      expect(tags.filter((tag) => tag && !nativeComponents.has(tag))).toEqual([]);
    }
  });

  it("checks production domains with TypeScript compilation enabled", () => {
    const project = jsonFile<{
      appid: string;
      miniprogramRoot: string;
      setting: { urlCheck: boolean; useCompilerPlugins: string[] };
    }>("project.config.json");

    expect(project.appid).toBe("touristappid");
    expect(project.miniprogramRoot).toBe("./");
    expect(project.setting.useCompilerPlugins).toContain("typescript");
    expect(project.setting.urlCheck).toBe(true);
  });

  it("keeps cancelled and expired tasks out of the current employee queue", () => {
    const types = readFileSync(resolve(miniappRoot, "types.ts"), "utf8");
    const tasks = readFileSync(resolve(miniappRoot, "pages/tasks/tasks.ts"), "utf8");
    const taskList = readFileSync(resolve(miniappRoot, "utils/task-list.ts"), "utf8");
    const detail = readFileSync(resolve(miniappRoot, "pages/task-detail/task-detail.wxml"), "utf8");

    expect(types).toContain('| "CANCELLED"');
    expect(tasks).toContain("filterEmployeeTasks");
    expect(taskList).toContain('["COMPLETED", "LATE_CORRECTED", "EXPIRED", "CANCELLED"]');
    expect(detail).toContain("task.status === 'CANCELLED' || task.status === 'EXPIRED'");
    expect(detail).toContain("本期任务已取消");
    expect(detail).not.toContain("统一 visibleAt");
  });
});

function jsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(miniappRoot, path), "utf8")) as T;
}
