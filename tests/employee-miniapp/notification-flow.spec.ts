import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EmployeeNotificationConfiguration,
  EmployeeSubscriptionResult,
} from "../../apps/employee-miniapp/types";
import { ApiError } from "../../apps/employee-miniapp/utils/api";
import type { PendingSubscription } from "../../apps/employee-miniapp/utils/notifications";

const mocks = vi.hoisted(() => ({ request: vi.fn(), loadSession: vi.fn() }));

vi.mock("../../apps/employee-miniapp/utils/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/employee-miniapp/utils/api")>();
  return { ...actual, apiRequest: mocks.request };
});
vi.mock("../../apps/employee-miniapp/utils/session", () => ({
  clearSession: vi.fn(),
  consumeFlashNotice: () => "",
  hasSeenFirstGuide: () => true,
  loadEnterpriseFilter: () => "ALL",
  loadSession: mocks.loadSession,
  markFirstGuideSeen: vi.fn(),
  saveEnterpriseFilter: vi.fn(),
}));

type TasksPage = {
  data: {
    busy: boolean;
    error: string;
    subscriptionAuthorizationGeneration: number | null;
    subscriptionBusy: boolean;
    subscriptionEnabled: boolean;
    subscriptionError: string;
    subscriptionIdentityReady: boolean;
    subscriptionIdentityVersion: number | null;
    subscriptionLoading: boolean;
    subscriptionPending: boolean;
    subscriptionRemaining: number;
    subscriptionStatusText: string;
    subscriptionTemplateId: string;
  };
  notificationRequestSequence: number;
  pendingSubscription: PendingSubscription | null;
  setData(data: object): void;
  onShow(): void;
  openTask(event: { currentTarget: { dataset: { taskId: string } } }): void;
  loadNotificationConfiguration(): Promise<void>;
  applyNotificationConfiguration(config: EmployeeNotificationConfiguration): void;
  subscribeToNewTasks(): void;
  retrySubscriptionSave(): void;
};

const wxLogin = vi.fn();
const requestSubscribeMessage = vi.fn();
const getAccountInfoSync = vi.fn();
const navigateTo = vi.fn();
const reLaunch = vi.fn();
let pageDefinition: TasksPage;

beforeAll(async () => {
  vi.stubGlobal("Page", (definition: TasksPage) => {
    pageDefinition = definition;
  });
  vi.stubGlobal("wx", {
    getAccountInfoSync,
    login: wxLogin,
    navigateTo,
    reLaunch,
    requestSubscribeMessage,
  });
  await import("../../apps/employee-miniapp/pages/tasks/tasks");
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadSession.mockReturnValue({
    accessToken: "employee-token",
    memberships: [],
    phone: "13800000099",
  });
  getAccountInfoSync.mockReturnValue({ miniProgram: { appId: "wx-notification-app" } });
  wxLogin.mockImplementation((options) => options.success({ code: "server-exchange-code" }));
  mocks.request.mockImplementation(async (path: string) => {
    if (path === "/employee/tasks") return [];
    if (path.endsWith("identity")) return configuration({ identityLinked: true });
    return configuration();
  });
});

describe("employee new-task notification subscription", () => {
  it("prepares identity on entry without asking for notification permission", async () => {
    const page = makePage();
    page.onShow();
    await vi.waitFor(() => expect(page.data.subscriptionIdentityReady).toBe(true));
    expect(wxLogin).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledWith(
      "/employee/notifications/identity",
      expect.objectContaining({
        body: { code: "server-exchange-code" },
        idempotencyKey: expect.stringMatching(/^miniapp-identity-/u),
        method: "POST",
      }),
    );
    expect(requestSubscribeMessage).not.toHaveBeenCalled();
    expect(page.data.busy).toBe(false);
    expect(page.data.error).toBe("");
  });

  it("checks this WeChat identity even if the account already has a linked identity", async () => {
    mocks.request.mockResolvedValue(configuration({ identityLinked: true }));
    await makePage().loadNotificationConfiguration();
    expect(wxLogin).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledWith(
      "/employee/notifications/identity",
      expect.objectContaining({ body: { code: "server-exchange-code" } }),
    );
  });

  it("does not prepare or request subscription when notifications are disabled", async () => {
    mocks.request.mockResolvedValue(
      configuration({ appId: null, enabled: false, templateId: null }),
    );
    const page = makePage();
    await page.loadNotificationConfiguration();
    page.subscribeToNewTasks();
    expect(wxLogin).not.toHaveBeenCalled();
    expect(requestSubscribeMessage).not.toHaveBeenCalled();
    expect(page.data.subscriptionStatusText).toContain("暂未开放");
  });

  it("treats an older server's missing configuration route as unavailable without blocking tasks", async () => {
    mocks.request.mockImplementation(async (path: string) => {
      if (path === "/employee/tasks") return [];
      throw new ApiError(`Cannot GET ${path}`, 404);
    });
    const page = makePage();
    page.data.subscriptionEnabled = true;
    page.data.subscriptionIdentityReady = true;
    page.data.subscriptionRemaining = 2;
    page.onShow();
    await vi.waitFor(() => expect(page.data.subscriptionLoading).toBe(false));
    expect(page.data.subscriptionEnabled).toBe(false);
    expect(page.data.subscriptionIdentityReady).toBe(false);
    expect(page.data.subscriptionRemaining).toBe(0);
    expect(page.data.subscriptionError).toBe("");
    expect(page.data.subscriptionStatusText).toContain("暂未开放");
    expect(page.data.busy).toBe(false);
    expect(page.data.error).toBe("");
    expect(wxLogin).not.toHaveBeenCalled();
    page.subscribeToNewTasks();
    expect(requestSubscribeMessage).not.toHaveBeenCalled();
    page.openTask({ currentTarget: { dataset: { taskId: "existing-task" } } });
    expect(navigateTo).toHaveBeenCalledWith({
      url: "/pages/task-detail/task-detail?taskId=existing-task",
    });
  });

  it("requires identity preparation before the permission tap", async () => {
    const page = makePage();
    page.data.subscriptionEnabled = true;
    page.data.subscriptionTemplateId = "new-task-template";
    page.subscribeToNewTasks();
    expect(requestSubscribeMessage).not.toHaveBeenCalled();
  });

  it("rejects a runtime AppID mismatch before exchanging any login code", async () => {
    getAccountInfoSync.mockReturnValue({ miniProgram: { appId: "wx-other-app" } });
    const page = makePage();
    await page.loadNotificationConfiguration();
    expect(page.data.subscriptionError).toContain("不匹配");
    expect(page.data.subscriptionIdentityReady).toBe(false);
    expect(wxLogin).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledOnce();
  });

  it("leaves tasks usable when a configured template is missing", async () => {
    mocks.request.mockImplementation(async (path: string) =>
      path === "/employee/tasks" ? [] : configuration({ templateId: null }),
    );
    const page = makePage();
    page.onShow();
    await vi.waitFor(() => expect(page.data.subscriptionLoading).toBe(false));
    expect(page.data.subscriptionError).toContain("尚未完成配置");
    expect(page.data.error).toBe("");
    expect(wxLogin).not.toHaveBeenCalled();
    page.openTask({ currentTarget: { dataset: { taskId: "task-1" } } });
    expect(navigateTo).toHaveBeenCalledWith({
      url: "/pages/task-detail/task-detail?taskId=task-1",
    });
  });

  it("allows task access when WeChat identity setup fails", async () => {
    wxLogin.mockImplementation((options) => options.fail({ errMsg: "login:fail" }));
    const page = makePage();
    page.onShow();
    await vi.waitFor(() => expect(page.data.subscriptionLoading).toBe(false));
    expect(page.data.subscriptionError).toContain("无法验证微信身份");
    expect(page.data.subscriptionIdentityReady).toBe(false);
    expect(page.data.busy).toBe(false);
    expect(page.data.error).toBe("");
    expect(requestSubscribeMessage).not.toHaveBeenCalled();
  });

  it("requests permission directly from the tap and records only the chosen template", async () => {
    const page = await readyPage();
    mocks.request.mockResolvedValue(
      configuration({ identityLinked: true, remainingSubscriptions: 1 }),
    );
    requestSubscribeMessage.mockImplementation((options) => {
      options.success({ "new-task-template": "accept", errMsg: "requestSubscribeMessage:ok" });
    });
    page.subscribeToNewTasks();
    // The native call has happened before the handler returns, without waiting for an API.
    expect(requestSubscribeMessage).toHaveBeenCalledOnce();
    expect(requestSubscribeMessage.mock.calls[0]?.[0].tmplIds).toEqual(["new-task-template"]);
    await vi.waitFor(() => expect(page.data.subscriptionBusy).toBe(false));
    expect(mocks.request).toHaveBeenLastCalledWith(
      "/employee/notifications/subscriptions",
      expect.objectContaining({
        body: {
          authorizationGeneration: 1,
          identityVersion: 1,
          status: "accept",
          templateId: "new-task-template",
        },
        idempotencyKey: expect.stringMatching(/^miniapp-subscription-/u),
        method: "POST",
      }),
    );
    expect(page.data.subscriptionRemaining).toBe(1);
    expect(page.pendingSubscription).toBeNull();
  });

  it.each<EmployeeSubscriptionResult>(["reject", "ban"])(
    "records %s without preventing task navigation",
    async (status) => {
      const page = await readyPage();
      mocks.request.mockResolvedValue(
        configuration({
          identityLinked: true,
          subscriptionStatus: status === "reject" ? "REJECT" : "BAN",
        }),
      );
      requestSubscribeMessage.mockImplementation((options) =>
        options.success({ "new-task-template": status, errMsg: "requestSubscribeMessage:ok" }),
      );
      page.subscribeToNewTasks();
      await vi.waitFor(() => expect(page.data.subscriptionBusy).toBe(false));
      expect(mocks.request.mock.calls.at(-1)?.[1].body.status).toBe(status);
      expect(page.data.subscriptionRemaining).toBe(0);
      expect(page.data.subscriptionStatusText).toContain(
        status === "reject" ? "未订阅" : "暂不允许",
      );
      page.openTask({ currentTarget: { dataset: { taskId: "task-2" } } });
      expect(navigateTo).toHaveBeenCalledWith({
        url: "/pages/task-detail/task-detail?taskId=task-2",
      });
    },
  );

  it("never reports filtered or missing native results as acceptance", async () => {
    const page = await readyPage();
    mocks.request.mockClear();
    requestSubscribeMessage.mockImplementation((options) =>
      options.success({ "new-task-template": "filter", errMsg: "requestSubscribeMessage:ok" }),
    );
    page.subscribeToNewTasks();
    expect(page.data.subscriptionBusy).toBe(false);
    expect(page.data.subscriptionError).toContain("未返回有效订阅结果");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("handles a cancelled or failed native prompt without reporting a result", async () => {
    const page = await readyPage();
    mocks.request.mockClear();
    requestSubscribeMessage.mockImplementation((options) => options.fail({ errCode: 20004 }));
    page.subscribeToNewTasks();
    expect(page.data.subscriptionBusy).toBe(false);
    expect(page.data.subscriptionIdentityReady).toBe(true);
    expect(page.data.subscriptionError).toContain("未完成");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("suppresses duplicate taps while the native permission prompt is open", async () => {
    const page = await readyPage();
    requestSubscribeMessage.mockImplementation(() => undefined);
    page.subscribeToNewTasks();
    page.subscribeToNewTasks();
    expect(requestSubscribeMessage).toHaveBeenCalledOnce();
    expect(page.data.subscriptionBusy).toBe(true);
  });

  it("retries a lost server acknowledgment with the same key without asking again", async () => {
    const page = await readyPage();
    mocks.request.mockClear();
    mocks.request
      .mockRejectedValueOnce(new Error("network response lost"))
      .mockResolvedValueOnce(configuration({ identityLinked: true, remainingSubscriptions: 1 }));
    requestSubscribeMessage.mockImplementation((options) =>
      options.success({ "new-task-template": "accept", errMsg: "requestSubscribeMessage:ok" }),
    );
    page.subscribeToNewTasks();
    await vi.waitFor(() => expect(page.data.subscriptionBusy).toBe(false));
    expect(page.data.subscriptionPending).toBe(true);
    expect(page.data.subscriptionError).toContain("无需再次授权");
    page.subscribeToNewTasks();
    expect(requestSubscribeMessage).toHaveBeenCalledOnce();
    page.retrySubscriptionSave();
    await vi.waitFor(() => expect(page.data.subscriptionPending).toBe(false));
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls[1]?.[1]).toEqual(mocks.request.mock.calls[0]?.[1]);
    expect(mocks.request.mock.calls[0]?.[1].body.identityVersion).toBe(1);
    expect(mocks.request.mock.calls[0]?.[1].body.authorizationGeneration).toBe(1);
    expect(page.data.subscriptionRemaining).toBe(1);
    expect(requestSubscribeMessage).toHaveBeenCalledOnce();
  });

  it("requires identity setup again if the server changes the configured AppID", async () => {
    const page = await readyPage();
    mocks.request.mockResolvedValue(
      configuration({
        appId: "wx-reconfigured-app",
        identityLinked: true,
        remainingSubscriptions: 1,
      }),
    );
    requestSubscribeMessage.mockImplementation((options) =>
      options.success({ "new-task-template": "accept", errMsg: "requestSubscribeMessage:ok" }),
    );
    page.subscribeToNewTasks();
    await vi.waitFor(() => expect(page.data.subscriptionBusy).toBe(false));
    expect(page.data.subscriptionPending).toBe(false);
    expect(page.data.subscriptionIdentityReady).toBe(false);
    expect(page.data.subscriptionError).toContain("不匹配");
    page.subscribeToNewTasks();
    expect(requestSubscribeMessage).toHaveBeenCalledOnce();
  });

  it.each(["identityVersion", "authorizationGeneration"] as const)(
    "does not enable subscription when identity setup returns no valid %s",
    async (field) => {
      mocks.request.mockResolvedValue(configuration({ identityLinked: true, [field]: null }));
      const page = makePage();
      await page.loadNotificationConfiguration();
      expect(page.data.subscriptionIdentityReady).toBe(false);
      expect(page.data.subscriptionError).toContain("微信身份尚未关联");
      page.subscribeToNewTasks();
      expect(requestSubscribeMessage).not.toHaveBeenCalled();
    },
  );

  const contextChanges: [string, Partial<EmployeeNotificationConfiguration>][] = [
    ["AppID", { appId: "wx-reconfigured-app" }],
    ["template", { templateId: "replacement-template" }],
    ["identity version", { identityVersion: 2 }],
    ["authorization generation", { authorizationGeneration: 2 }],
  ];

  it.each(contextChanges)(
    "discards a native result if %s changes while the authorization prompt is open",
    async (_label, changes) => {
      const page = await readyPage();
      mocks.request.mockClear();
      requestSubscribeMessage.mockImplementation(() => undefined);
      page.subscribeToNewTasks();
      page.applyNotificationConfiguration(configuration({ identityLinked: true, ...changes }));
      const callback = requestSubscribeMessage.mock.calls[0]?.[0].success;
      callback({ "new-task-template": "accept", errMsg: "requestSubscribeMessage:ok" });
      expect(mocks.request).not.toHaveBeenCalled();
      expect(page.pendingSubscription).toBeNull();
      expect(page.data.subscriptionBusy).toBe(false);
      expect(page.data.subscriptionIdentityReady).toBe(false);
      expect(page.data.subscriptionError).toContain("已变化");
    },
  );

  it.each(contextChanges)(
    "discards unsaved authorization if %s changes before report retry",
    async (_label, changes) => {
      const page = await readyPage();
      mocks.request.mockClear();
      mocks.request.mockRejectedValue(new Error("response lost"));
      requestSubscribeMessage.mockImplementation((options) =>
        options.success({ "new-task-template": "accept", errMsg: "requestSubscribeMessage:ok" }),
      );
      page.subscribeToNewTasks();
      await vi.waitFor(() => expect(page.data.subscriptionBusy).toBe(false));
      expect(page.pendingSubscription?.identityVersion).toBe(1);
      expect(page.pendingSubscription?.authorizationGeneration).toBe(1);
      page.applyNotificationConfiguration(configuration({ identityLinked: true, ...changes }));
      page.retrySubscriptionSave();
      expect(mocks.request).toHaveBeenCalledOnce();
      expect(page.pendingSubscription).toBeNull();
      expect(page.data.subscriptionPending).toBe(false);
      expect(page.data.subscriptionIdentityReady).toBe(false);
      expect(page.data.subscriptionError).toContain("已变化");
    },
  );

  it.each(["subscriptionIdentityVersion", "subscriptionAuthorizationGeneration"] as const)(
    "checks the captured %s again before retrying an unsaved result",
    async (field) => {
      const page = await readyPage();
      mocks.request.mockClear();
      mocks.request.mockRejectedValue(new Error("response lost"));
      requestSubscribeMessage.mockImplementation((options) =>
        options.success({ "new-task-template": "accept", errMsg: "requestSubscribeMessage:ok" }),
      );
      page.subscribeToNewTasks();
      await vi.waitFor(() => expect(page.data.subscriptionBusy).toBe(false));
      page.data[field] = 2;
      page.retrySubscriptionSave();
      expect(mocks.request).toHaveBeenCalledOnce();
      expect(page.pendingSubscription).toBeNull();
      expect(page.data.subscriptionIdentityReady).toBe(false);
    },
  );

  it("requires new authorization after the server rejects a stale identity version", async () => {
    const page = await readyPage();
    mocks.request.mockClear();
    mocks.request.mockRejectedValue(new ApiError("identity changed", 409));
    requestSubscribeMessage.mockImplementation((options) =>
      options.success({ "new-task-template": "accept", errMsg: "requestSubscribeMessage:ok" }),
    );
    page.subscribeToNewTasks();
    await vi.waitFor(() => expect(page.data.subscriptionBusy).toBe(false));
    expect(page.pendingSubscription).toBeNull();
    expect(page.data.subscriptionIdentityReady).toBe(false);
    expect(page.data.subscriptionError).toContain("已变化");
    page.retrySubscriptionSave();
    page.subscribeToNewTasks();
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(requestSubscribeMessage).toHaveBeenCalledOnce();
  });

  it("offers setup again when a rejected subscription advances the authorization generation", async () => {
    const page = await readyPage();
    mocks.request.mockResolvedValue(
      configuration({
        identityLinked: true,
        authorizationGeneration: 2,
        subscriptionStatus: "REJECT",
      }),
    );
    requestSubscribeMessage.mockImplementation((options) =>
      options.success({ "new-task-template": "reject", errMsg: "requestSubscribeMessage:ok" }),
    );
    page.subscribeToNewTasks();
    await vi.waitFor(() => expect(page.data.subscriptionBusy).toBe(false));
    expect(page.data.subscriptionAuthorizationGeneration).toBe(2);
    expect(page.data.subscriptionIdentityReady).toBe(false);
    expect(page.data.subscriptionPending).toBe(false);
    expect(page.data.subscriptionError).toContain("重新准备");
    expect(page.data.subscriptionStatusText).toContain("未订阅");
  });

  it.each(["identityVersion", "authorizationGeneration"] as const)(
    "does not restore an old %s from an in-flight report response",
    async (field) => {
      const page = await readyPage();
      let completeReport!: (config: EmployeeNotificationConfiguration) => void;
      mocks.request.mockImplementation(
        () =>
          new Promise<EmployeeNotificationConfiguration>((resolve) => {
            completeReport = resolve;
          }),
      );
      requestSubscribeMessage.mockImplementation((options) =>
        options.success({ "new-task-template": "accept", errMsg: "requestSubscribeMessage:ok" }),
      );
      page.subscribeToNewTasks();
      page.applyNotificationConfiguration(configuration({ identityLinked: true, [field]: 2 }));
      completeReport(
        configuration({ identityLinked: true, [field]: 1, remainingSubscriptions: 1 }),
      );
      await vi.waitFor(() => expect(page.data.subscriptionBusy).toBe(false));
      expect(
        field === "identityVersion"
          ? page.data.subscriptionIdentityVersion
          : page.data.subscriptionAuthorizationGeneration,
      ).toBe(2);
      expect(page.data.subscriptionRemaining).toBe(0);
      expect(page.data.subscriptionIdentityReady).toBe(false);
      expect(page.pendingSubscription).toBeNull();
    },
  );

  it("discards unsaved authorization and returns to login after an expired employee session", async () => {
    const page = await readyPage();
    mocks.request.mockClear();
    mocks.request.mockRejectedValue(new ApiError("session expired", 401));
    requestSubscribeMessage.mockImplementation((options) =>
      options.success({ "new-task-template": "accept", errMsg: "requestSubscribeMessage:ok" }),
    );
    page.subscribeToNewTasks();
    await vi.waitFor(() => expect(page.data.subscriptionBusy).toBe(false));
    expect(page.pendingSubscription).toBeNull();
    expect(page.data.subscriptionIdentityReady).toBe(false);
    expect(page.data.subscriptionError).toContain("登录已过期");
    expect(reLaunch).toHaveBeenCalledWith({ url: "/pages/login/login" });
    page.retrySubscriptionSave();
    expect(mocks.request).toHaveBeenCalledOnce();
  });
});

function configuration(
  overrides: Partial<EmployeeNotificationConfiguration> = {},
): EmployeeNotificationConfiguration {
  return {
    appId: "wx-notification-app",
    authorizationGeneration: overrides.identityLinked ? 1 : null,
    enabled: true,
    identityLinked: false,
    identityVersion: overrides.identityLinked ? 1 : null,
    remainingSubscriptions: 0,
    subscriptionStatus: "NONE",
    templateId: "new-task-template",
    ...overrides,
  };
}

function makePage(): TasksPage {
  return {
    ...pageDefinition,
    data: { ...pageDefinition.data },
    notificationRequestSequence: 0,
    pendingSubscription: null,
    setData(data: object) {
      Object.assign(this.data, data);
    },
  };
}

async function readyPage(): Promise<TasksPage> {
  const page = makePage();
  await page.loadNotificationConfiguration();
  expect(page.data.subscriptionIdentityReady).toBe(true);
  return page;
}
