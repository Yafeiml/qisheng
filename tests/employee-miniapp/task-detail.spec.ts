import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext, Script } from "node:vm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EmployeeTask,
  EmployeeTaskMetric,
  TaskStatus,
} from "../../apps/employee-miniapp/types";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../apps/employee-miniapp/utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../apps/employee-miniapp/utils/api")>()),
  apiRequest: mocks.request,
}));
vi.mock("../../apps/employee-miniapp/utils/session", () => ({
  clearSession: vi.fn(),
  consumeFlashNotice: () => "",
  hasSeenFirstGuide: () => true,
  loadEnterpriseFilter: () => "ALL",
  loadSession: () => ({ accessToken: "employee-token", memberships: [], phone: "13800000099" }),
  markFirstGuideSeen: vi.fn(),
  saveEnterpriseFilter: vi.fn(),
}));

type DetailTask = EmployeeTask & { canSubmit: boolean; failureReasonText: string };
type DetailPage = {
  data: { task: DetailTask | null; taskId: string; error?: string };
  setData(data: object): void;
  loadTask(): Promise<void>;
  copyContent(): Promise<void>;
  saveImage(event: { currentTarget: { dataset: { imageId: string } } }): Promise<void>;
  confirmFacts(): Promise<void>;
};
type TasksPage = {
  data: { tasks: (EmployeeTask & { metricText: string })[] };
  setData(data: object): void;
  loadTasks(): Promise<void>;
};
let detailDefinition: DetailPage;
let tasksDefinition: TasksPage;
const root = resolve(process.cwd(), "apps/employee-miniapp");
const detailTemplate = readFileSync(resolve(root, "pages/task-detail/task-detail.wxml"), "utf8");

beforeAll(async () => {
  vi.stubGlobal("Page", (definition: DetailPage | TasksPage) => {
    if ("loadTask" in definition) detailDefinition = definition;
    else tasksDefinition = definition;
  });
  await import("../../apps/employee-miniapp/pages/task-detail/task-detail");
  await import("../../apps/employee-miniapp/pages/tasks/tasks");
});

beforeEach(() => vi.clearAllMocks());

describe("employee task templates", () => {
  it("keeps reporting available when a changed publishing arrangement hides the medical draft", async () => {
    mocks.request.mockResolvedValue({
      ...taskFixture("AVAILABLE"),
      factsConfirmationRequired: true,
      contentVisible: false,
      content: null,
    });
    const page = detailPage();
    await page.loadTask();
    const task = page.data.task;
    if (!task) throw new Error("Missing loaded task");
    expect(condition("facts-section", task)).toBeTruthy();
    const confirmTag = detailTemplate.match(
      /<button\b[^>]*class="primary-button facts-confirm"[^>]*>/u,
    )?.[0];
    const expression = confirmTag?.match(/wx:elif="\{\{(.*?)\}\}"/u)?.[1];
    expect(expression).toBeDefined();
    expect(runInNewContext(expression ?? "undefined", { task })).toBeFalsy();
    mocks.request.mockClear();
    await page.confirmFacts();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(page.data.error).toContain("退回企业");
  });

  it("keeps medical actions locked until the current revision is confirmed", async () => {
    mocks.request.mockResolvedValue({
      ...taskFixture("AVAILABLE"),
      factsConfirmationRequired: true,
      factsConfirmed: false,
    });
    const page = detailPage();
    await page.loadTask();
    expect(page.data.task?.canSubmit).toBe(false);
    mocks.request.mockResolvedValue({
      ...taskFixture("AVAILABLE"),
      factsConfirmationRequired: true,
      factsConfirmed: true,
    });
    await page.confirmFacts();
    expect(mocks.request).toHaveBeenLastCalledWith("/employee/tasks/task-1/facts", {
      method: "POST",
      body: { revision: 1, confirmed: true },
    });
    expect(page.data.task?.canSubmit).toBe(true);
  });

  it("waits for server permission before writing clipboard or downloading images", async () => {
    const order: string[] = [];
    const task = taskFixture("AVAILABLE");
    if (!task.content) throw new Error("Missing fixture content");
    task.content.images = [
      {
        id: "image-1",
        imageUrl: "https://example.test/image.png",
        mimeType: "image/png",
        width: 100,
        height: 100,
        synthetic: false,
      },
    ];
    vi.stubGlobal("wx", {
      setClipboardData: ({ success }: { success: () => void }) => {
        order.push("clipboard");
        success();
      },
      downloadFile: ({ success }: { success: (result: object) => void }) => {
        order.push("download");
        success({ statusCode: 200, tempFilePath: "temp.png" });
      },
      saveImageToPhotosAlbum: ({ success }: { success: () => void }) => {
        order.push("album");
        success();
      },
      showToast: vi.fn(),
    });
    const page = detailPage();
    mocks.request.mockResolvedValue(task);
    await page.loadTask();
    mocks.request.mockImplementation(async () => {
      order.push("permission");
      return task;
    });
    await page.copyContent();
    expect(order).toEqual(["permission", "clipboard"]);
    order.length = 0;
    await page.saveImage({ currentTarget: { dataset: { imageId: "image-1" } } });
    expect(order).toEqual(["permission", "download", "album"]);
    order.length = 0;
    mocks.request.mockRejectedValue(new Error("请先确认当前版本真实"));
    await page.copyContent();
    await page.saveImage({ currentTarget: { dataset: { imageId: "image-1" } } });
    expect(order).toEqual([]);
    expect(page.data.error).toContain("确认");
  });

  it("does not use a changed revision even if a stale permission response arrives", async () => {
    const clipboard = vi.fn();
    vi.stubGlobal("wx", { setClipboardData: clipboard, showToast: vi.fn() });
    mocks.request.mockResolvedValue(taskFixture("AVAILABLE"));
    const page = detailPage();
    await page.loadTask();
    mocks.request.mockResolvedValue({ ...taskFixture("AVAILABLE"), contentRevision: 2 });
    await page.copyContent();
    expect(clipboard).not.toHaveBeenCalled();
    expect(page.data.error).toContain("已经更新");
  });
  it("keeps every native WXML expression free of HTML entities and parseable", () => {
    const { pages } = JSON.parse(readFileSync(resolve(root, "app.json"), "utf8")) as {
      pages: string[];
    };
    for (const page of pages) {
      const template = readFileSync(resolve(root, `${page}.wxml`), "utf8");
      for (const [, expression] of template.matchAll(/\{\{(.*?)\}\}/gu)) {
        expect(expression).not.toMatch(/&(?:amp|lt|gt);/u);
        expect(() => new Script(`(${expression})`)).not.toThrow();
      }
    }
  });

  it.each(["COMPLETED", "LATE_CORRECTED"] as const)(
    "shows the successful publication for %s tasks instead of pending verification",
    async (status) => {
      const task = await loadDetail(status);
      expect(task.canSubmit).toBe(false);
      expect(condition("review-pending-section", task)).toBe(false);
      expect(condition("success-section", task)).toBe(true);
      const tasksTemplate = readFileSync(resolve(root, "pages/tasks/tasks.wxml"), "utf8");
      const footer = tasksTemplate.match(/<view class="task-footer">\s*<text>\{\{(.*?)\}\}/u)?.[1];
      expect(footer).toBeDefined();
      expect(runInNewContext(footer ?? "undefined", { item: task })).toBe("查看任务记录");
    },
  );

  it("shows correction instructions when a rejected submission returns to AVAILABLE", async () => {
    const task = await loadDetail("AVAILABLE", "发布图片不是本人的独立图片");
    expect(task.canSubmit).toBe(true);
    expect(condition("repair-section", task)).toBeTruthy();
    expect(task.failureReasonText).toContain("独立图片");
    expect(condition("success-section", task)).toBe(false);
    expect(condition("review-pending-section", task)).toBe(false);
  });

  it("reserves the pending panel for VERIFYING tasks", async () => {
    const task = await loadDetail("VERIFYING");
    expect(task.canSubmit).toBe(false);
    expect(condition("review-pending-section", task)).toBe(true);
    expect(condition("success-section", task)).toBe(false);
    expect(condition("repair-section", task)).toBe(false);
  });

  it.each([null, 0, 17])("shows missing metrics as — while preserving %s", async (value) => {
    const task = taskFixture("COMPLETED");
    const metrics: EmployeeTaskMetric = {
      comments: value,
      favorites: value,
      likes: value,
      observedAt: "2026-10-13T00:00:00.000Z",
      shares: value,
      views: value,
    };
    if (!task.publication) throw new Error("Completed fixture requires a publication");
    task.publication.latestMetrics = metrics;
    mocks.request.mockResolvedValue([task]);
    const page = {
      ...tasksDefinition,
      data: { ...tasksDefinition.data },
      setData(data: object) {
        Object.assign(this.data, data);
      },
    };
    await page.loadTasks();
    const display = value ?? "—";
    expect(page.data.tasks[0]?.metricText).toBe(
      `阅读 ${display} · 点赞 ${display} · 收藏 ${display}`,
    );
    const expressions = [...detailTemplate.matchAll(/<text class="metric-value">\{\{(.*?)\}\}/gu)];
    expect(expressions).toHaveLength(4);
    for (const [, expression] of expressions) {
      expect(runInNewContext(expression ?? "undefined", { task })).toBe(display);
    }
    task.publication.latestMetrics = null;
    for (const [, expression] of expressions) {
      expect(runInNewContext(expression ?? "undefined", { task })).toBe("—");
    }
  });
});

async function loadDetail(status: TaskStatus, submissionFailureReason: string | null = null) {
  mocks.request.mockResolvedValue({ ...taskFixture(status), submissionFailureReason });
  const page = {
    ...detailDefinition,
    data: { ...detailDefinition.data, taskId: "task-1" },
    setData(data: object) {
      Object.assign(this.data, data);
    },
  };
  await page.loadTask();
  if (!page.data.task) throw new Error("Task detail did not load");
  return page.data.task;
}

function detailPage() {
  return {
    ...detailDefinition,
    data: { ...detailDefinition.data, taskId: "task-1" },
    setData(data: object) {
      Object.assign(this.data, data);
    },
  };
}

function condition(className: string, task: DetailTask): unknown {
  const tag = detailTemplate.match(
    new RegExp(`<view\\b[^>]*class="${className}(?: [^"]*)?"[^>]*>`, "u"),
  )?.[0];
  const expression = tag?.match(/wx:(?:if|elif)="\{\{(.*?)\}\}"/u)?.[1];
  expect(expression).toBeDefined();
  return runInNewContext(expression ?? "undefined", { task });
}

function taskFixture(status: TaskStatus): EmployeeTask {
  return {
    contentRevision: 1,
    factsConfirmationRequired: false,
    factsConfirmed: false,
    factsReturned: false,
    publishingArrangement: null,
    campaign: { id: "campaign-1", status: "ACTIVE", title: "本人任务" },
    content: { body: "正文", hashtags: [], images: [], synthetic: false, title: "标题" },
    contentVisible: true,
    copiedAt: null,
    downloadedAt: null,
    enterprise: { id: "enterprise-1", name: "企业" },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    firstViewedAt: null,
    id: "task-1",
    publication: ["COMPLETED", "LATE_CORRECTED"].includes(status)
      ? {
          latestMetrics: null,
          normalizedUrl: "https://www.xiaohongshu.com/explore/task-1",
          verifiedAt: new Date().toISOString(),
        }
      : null,
    status,
    submissionFailureReason: null,
    submittedAt: null,
    verifiedAt: null,
    visibleAt: new Date(Date.now() - 3_600_000).toISOString(),
  };
}
