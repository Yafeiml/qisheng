import type {
  EmployeeNotificationConfiguration,
  EmployeeSubscriptionResult,
  EmployeeTask,
  EmployeeTaskMetric,
  TaskStatus,
} from "../../types";
import { ApiError, apiRequest, messageOf } from "../../utils/api";
import {
  checkNotificationConfiguration,
  isNotificationIdentityVersion,
  loginForNotifications,
  notificationIdempotencyKey,
  notificationStatusText,
  type PendingSubscription,
  type SubscriptionContext,
} from "../../utils/notifications";
import {
  clearSession,
  consumeFlashNotice,
  hasSeenFirstGuide,
  loadEnterpriseFilter,
  loadSession,
  markFirstGuideSeen,
  saveEnterpriseFilter,
} from "../../utils/session";
import {
  buildEnterpriseFilters,
  type EnterpriseFilter,
  filterEmployeeTasks,
  type StatusFilter,
  summarizeTasks,
  taskEmptyState,
  validEnterpriseSelection,
} from "../../utils/task-list";

interface TaskView extends EmployeeTask {
  metricText: string;
  statusLabel: string;
  timingLabel: string;
  tone: string;
}

interface TasksData {
  busy: boolean;
  completedCount: number;
  emptyAction: "JOIN" | "REFRESH";
  emptyDescription: string;
  emptyIcon: string;
  emptyTitle: string;
  enterpriseFilters: EnterpriseFilter[];
  enterpriseId: string;
  error: string;
  expiredCount: number;
  filteredTasks: TaskView[];
  guideVisible: boolean;
  historyCount: number;
  membershipCount: number;
  notice: string;
  pendingCount: number;
  phone: string;
  selectedEnterpriseName: string;
  statusFilter: StatusFilter;
  subscriptionAppId: string;
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
  tasks: TaskView[];
  totalCount: number;
}

Page({
  notificationRequestSequence: 0,
  pendingSubscription: null as PendingSubscription | null,

  data: {
    busy: false,
    completedCount: 0,
    emptyAction: "REFRESH",
    emptyDescription: "",
    emptyIcon: "○",
    emptyTitle: "",
    enterpriseFilters: [],
    enterpriseId: "ALL",
    error: "",
    expiredCount: 0,
    filteredTasks: [],
    guideVisible: false,
    historyCount: 0,
    membershipCount: 0,
    notice: "",
    pendingCount: 0,
    phone: "",
    selectedEnterpriseName: "",
    statusFilter: "CURRENT",
    subscriptionAppId: "",
    subscriptionAuthorizationGeneration: null,
    subscriptionBusy: false,
    subscriptionEnabled: false,
    subscriptionError: "",
    subscriptionIdentityReady: false,
    subscriptionIdentityVersion: null,
    subscriptionLoading: false,
    subscriptionPending: false,
    subscriptionRemaining: 0,
    subscriptionStatusText: "正在准备新任务通知…",
    subscriptionTemplateId: "",
    tasks: [],
    totalCount: 0,
  } as TasksData,

  onShow() {
    const session = loadSession();
    if (!session) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    const enterpriseId = validEnterpriseSelection(session.memberships, loadEnterpriseFilter());
    this.setData({
      enterpriseFilters: buildEnterpriseFilters(session.memberships, enterpriseId),
      enterpriseId,
      guideVisible: session.memberships.length > 0 && !hasSeenFirstGuide(),
      membershipCount: session.memberships.length,
      notice: consumeFlashNotice(),
      phone: maskPhone(session.phone),
      selectedEnterpriseName:
        session.memberships.find((item) => item.enterpriseId === enterpriseId)?.enterpriseName ??
        "",
    });
    void this.loadTasks();
    if (!this.data.subscriptionBusy && !this.pendingSubscription) {
      void this.loadNotificationConfiguration();
    }
  },

  onPullDownRefresh() {
    void this.loadTasks(false).finally(() => wx.stopPullDownRefresh());
  },

  async loadTasks(showLoading = true) {
    if (showLoading) this.setData({ busy: true });
    this.setData({ error: "" });
    try {
      const tasks = (await apiRequest<EmployeeTask[]>("/employee/tasks")).map(taskView);
      const session = loadSession();
      const memberships = session?.memberships ?? [];
      const enterpriseId = validEnterpriseSelection(memberships, this.data.enterpriseId);
      this.setData({
        enterpriseFilters: buildEnterpriseFilters(memberships, enterpriseId),
        enterpriseId,
        membershipCount: memberships.length,
        selectedEnterpriseName:
          memberships.find((item) => item.enterpriseId === enterpriseId)?.enterpriseName ?? "",
        tasks,
      });
      this.applyFilters();
    } catch (reason) {
      this.setData({ error: messageOf(reason) });
      if (!loadSession()) wx.reLaunch({ url: "/pages/login/login" });
    } finally {
      if (showLoading) this.setData({ busy: false });
    }
  },

  async loadNotificationConfiguration() {
    if (this.data.subscriptionBusy || this.pendingSubscription) return;
    const sequence = ++this.notificationRequestSequence;
    this.setData({
      subscriptionError: "",
      subscriptionIdentityReady: false,
      subscriptionLoading: true,
      subscriptionStatusText: "正在准备新任务通知…",
    });
    let configurationReceived = false;
    try {
      let config = await apiRequest<EmployeeNotificationConfiguration>(
        "/employee/notifications/configuration",
      );
      if (sequence !== this.notificationRequestSequence) return;
      configurationReceived = true;
      this.applyNotificationConfiguration(config);
      checkNotificationConfiguration(config);
      if (!config.enabled) return;
      const code = await loginForNotifications();
      if (sequence !== this.notificationRequestSequence) return;
      config = await apiRequest<EmployeeNotificationConfiguration>(
        "/employee/notifications/identity",
        {
          body: { code },
          idempotencyKey: notificationIdempotencyKey("identity"),
          method: "POST",
        },
      );
      if (sequence !== this.notificationRequestSequence) return;
      checkNotificationConfiguration(config);
      this.applyNotificationConfiguration(config);
      if (
        config.enabled &&
        (!config.identityLinked ||
          !isNotificationIdentityVersion(config.identityVersion) ||
          !isNotificationIdentityVersion(config.authorizationGeneration))
      ) {
        throw new Error("微信身份尚未关联，请重试。任务可照常查看。");
      }
      this.setData({ subscriptionIdentityReady: config.enabled && config.identityLinked });
    } catch (reason) {
      if (sequence !== this.notificationRequestSequence) return;
      if (!configurationReceived && reason instanceof ApiError && reason.statusCode === 404) {
        // A miniapp update may precede the server release that introduces notifications.
        this.applyNotificationConfiguration({
          appId: null,
          authorizationGeneration: null,
          enabled: false,
          identityLinked: false,
          identityVersion: null,
          remainingSubscriptions: 0,
          subscriptionStatus: "NONE",
          templateId: null,
        });
        return;
      }
      this.setData({
        subscriptionError: messageOf(reason),
        subscriptionIdentityReady: false,
        subscriptionStatusText: "通知暂不可用，任务可照常查看。",
      });
    } finally {
      if (sequence === this.notificationRequestSequence) {
        this.setData({ subscriptionLoading: false });
      }
    }
  },

  applyNotificationConfiguration(config: EmployeeNotificationConfiguration) {
    const authorizationGeneration = isNotificationIdentityVersion(config.authorizationGeneration)
      ? config.authorizationGeneration
      : null;
    const identityVersion = isNotificationIdentityVersion(config.identityVersion)
      ? config.identityVersion
      : null;
    const sameContext =
      this.data.subscriptionAppId === config.appId &&
      this.data.subscriptionTemplateId === config.templateId &&
      this.data.subscriptionIdentityVersion === identityVersion &&
      this.data.subscriptionAuthorizationGeneration === authorizationGeneration;
    const contextChanged = config.enabled && this.data.subscriptionIdentityReady && !sameContext;
    const pending = this.pendingSubscription;
    const discardPending =
      pending &&
      (!config.enabled ||
        !config.identityLinked ||
        pending.appId !== config.appId ||
        pending.templateId !== config.templateId ||
        pending.identityVersion !== identityVersion ||
        pending.authorizationGeneration !== authorizationGeneration);
    if (discardPending) this.pendingSubscription = null;
    this.setData({
      subscriptionAppId: config.appId ?? "",
      subscriptionAuthorizationGeneration: authorizationGeneration,
      subscriptionEnabled: config.enabled,
      subscriptionIdentityReady:
        config.enabled &&
        config.identityLinked &&
        sameContext &&
        this.data.subscriptionIdentityReady,
      subscriptionIdentityVersion: identityVersion,
      subscriptionRemaining: config.remainingSubscriptions,
      subscriptionStatusText: notificationStatusText(config),
      subscriptionTemplateId: config.templateId ?? "",
      ...(discardPending || contextChanged
        ? {
            subscriptionError: "微信身份或通知配置已变化，请重新准备通知并授权。",
            subscriptionPending: false,
          }
        : {}),
    });
  },

  hasSubscriptionContext(context: SubscriptionContext) {
    return (
      this.data.subscriptionEnabled &&
      this.data.subscriptionIdentityReady &&
      this.data.subscriptionAppId === context.appId &&
      this.data.subscriptionTemplateId === context.templateId &&
      this.data.subscriptionIdentityVersion === context.identityVersion &&
      this.data.subscriptionAuthorizationGeneration === context.authorizationGeneration
    );
  },

  subscribeToNewTasks() {
    if (
      this.data.subscriptionBusy ||
      this.data.subscriptionLoading ||
      this.pendingSubscription ||
      !this.data.subscriptionEnabled ||
      !this.data.subscriptionIdentityReady ||
      !this.data.subscriptionAppId ||
      !isNotificationIdentityVersion(this.data.subscriptionIdentityVersion) ||
      !isNotificationIdentityVersion(this.data.subscriptionAuthorizationGeneration) ||
      !this.data.subscriptionTemplateId
    ) {
      return;
    }
    if (typeof wx.requestSubscribeMessage !== "function") {
      this.setData({ subscriptionError: "当前微信版本不支持订阅消息，请更新微信后再试。" });
      return;
    }
    const templateId = this.data.subscriptionTemplateId;
    const context: SubscriptionContext = {
      appId: this.data.subscriptionAppId,
      authorizationGeneration: this.data.subscriptionAuthorizationGeneration,
      identityVersion: this.data.subscriptionIdentityVersion,
      templateId,
    };
    this.setData({ subscriptionBusy: true, subscriptionError: "" });
    // This call must stay in the tap handler, before any await or network request.
    try {
      wx.requestSubscribeMessage({
        tmplIds: [templateId],
        success: (result) => {
          if (!this.hasSubscriptionContext(context)) {
            this.setData({
              subscriptionBusy: false,
              subscriptionError: "微信身份或通知配置已变化，请重新准备通知并授权。",
              subscriptionIdentityReady: false,
            });
            return;
          }
          const status = result[templateId];
          if (!isSubscriptionResult(status)) {
            this.setData({
              subscriptionBusy: false,
              subscriptionError: "微信未返回有效订阅结果，请稍后再试。",
            });
            return;
          }
          this.pendingSubscription = {
            ...context,
            idempotencyKey: notificationIdempotencyKey("subscription"),
            status,
          };
          this.setData({ subscriptionPending: true });
          void this.savePendingSubscription();
        },
        fail: () => {
          this.setData({
            subscriptionBusy: false,
            subscriptionError: "本次订阅未完成，可稍后重试；任务仍可查看。",
          });
        },
      });
    } catch {
      this.setData({
        subscriptionBusy: false,
        subscriptionError: "暂时无法打开微信订阅，请稍后再试。",
      });
    }
  },

  async savePendingSubscription() {
    const pending = this.pendingSubscription;
    if (!pending) return;
    if (!this.hasSubscriptionContext(pending)) {
      this.pendingSubscription = null;
      this.setData({
        subscriptionBusy: false,
        subscriptionError: "微信身份或通知配置已变化，请重新准备通知并授权。",
        subscriptionIdentityReady: false,
        subscriptionPending: false,
      });
      return;
    }
    this.setData({ subscriptionBusy: true, subscriptionError: "" });
    try {
      const config = await apiRequest<EmployeeNotificationConfiguration>(
        "/employee/notifications/subscriptions",
        {
          body: {
            authorizationGeneration: pending.authorizationGeneration,
            identityVersion: pending.identityVersion,
            status: pending.status,
            templateId: pending.templateId,
          },
          idempotencyKey: pending.idempotencyKey,
          method: "POST",
        },
      );
      if (this.pendingSubscription !== pending) return;
      this.pendingSubscription = null;
      this.setData({ subscriptionPending: false });
      this.applyNotificationConfiguration(config);
      try {
        checkNotificationConfiguration(config);
      } catch (reason) {
        this.setData({
          subscriptionError: messageOf(reason),
          subscriptionIdentityReady: false,
        });
      }
    } catch (reason) {
      if (this.pendingSubscription !== pending) return;
      if (reason instanceof ApiError && (reason.statusCode === 401 || reason.statusCode === 409)) {
        this.pendingSubscription = null;
        this.setData({
          subscriptionError:
            reason.statusCode === 401
              ? "登录已过期，请重新登录后准备通知。"
              : "微信身份或通知配置已变化，请重新准备通知并授权。",
          subscriptionIdentityReady: false,
          subscriptionPending: false,
        });
        if (reason.statusCode === 401) wx.reLaunch({ url: "/pages/login/login" });
        return;
      }
      this.setData({
        subscriptionError: "订阅结果尚未保存，请点击重试保存；无需再次授权。",
      });
    } finally {
      this.setData({ subscriptionBusy: false });
    }
  },

  retrySubscriptionSave() {
    if (this.data.subscriptionBusy) return;
    void this.savePendingSubscription();
  },

  chooseStatus(event: { currentTarget: { dataset: { status?: StatusFilter } } }) {
    const status = event.currentTarget.dataset.status;
    if (!status) return;
    this.setData({ statusFilter: status });
    this.applyFilters();
  },

  chooseEnterprise(event: { currentTarget: { dataset: { enterpriseId?: string } } }) {
    const enterpriseId = event.currentTarget.dataset.enterpriseId;
    if (!enterpriseId) return;
    this.setData({
      enterpriseFilters: this.data.enterpriseFilters.map((item) => ({
        ...item,
        active: item.id === enterpriseId,
      })),
      enterpriseId,
      selectedEnterpriseName:
        this.data.enterpriseFilters.find((item) => item.id === enterpriseId)?.name ?? "",
    });
    saveEnterpriseFilter(enterpriseId);
    this.applyFilters();
  },

  applyFilters() {
    const filteredTasks = filterEmployeeTasks(
      this.data.tasks,
      this.data.enterpriseId,
      this.data.statusFilter,
    );
    const counts = summarizeTasks(this.data.tasks, this.data.enterpriseId);
    const empty = taskEmptyState({
      enterpriseId: this.data.enterpriseId,
      enterpriseName: this.data.selectedEnterpriseName,
      filteredCount: filteredTasks.length,
      membershipCount: this.data.membershipCount,
      scopedTaskCount: counts.total,
      statusFilter: this.data.statusFilter,
    });
    this.setData({
      completedCount: counts.completed,
      emptyAction: empty.action,
      emptyDescription: empty.description,
      emptyIcon: empty.icon,
      emptyTitle: empty.title,
      expiredCount: counts.expired,
      filteredTasks,
      historyCount: counts.history,
      pendingCount: counts.pending,
      totalCount: counts.total,
    });
  },

  dismissGuide() {
    markFirstGuideSeen();
    this.setData({ guideVisible: false });
  },

  openTask(event: { currentTarget: { dataset: { taskId?: string } } }) {
    const taskId = event.currentTarget.dataset.taskId;
    if (!taskId) return;
    wx.navigateTo({ url: `/pages/task-detail/task-detail?taskId=${taskId}` });
  },

  joinEnterprise() {
    wx.navigateTo({ url: "/pages/login/login?mode=join" });
  },

  logout() {
    wx.showModal({
      cancelText: "取消",
      confirmColor: "#ff2442",
      confirmText: "退出",
      content: "退出后需要重新验证手机号。",
      success(result) {
        if (!result.confirm) return;
        clearSession();
        wx.reLaunch({ url: "/pages/login/login" });
      },
      title: "退出员工端？",
    });
  },
});

function isSubscriptionResult(status: string | undefined): status is EmployeeSubscriptionResult {
  return status === "accept" || status === "reject" || status === "ban";
}

function taskView(task: EmployeeTask): TaskView {
  return {
    ...task,
    metricText: metricText(task.publication?.latestMetrics ?? null),
    statusLabel: statusLabel(task.status),
    timingLabel: timingLabel(task),
    tone: statusTone(task.status),
  };
}

function statusLabel(status: TaskStatus): string {
  const labels: Record<TaskStatus, string> = {
    AVAILABLE: "待提交发布链接",
    CANCELLED: "已取消",
    COMPLETED: "已按时完成",
    EXPIRED: "未按时提交链接",
    LATE_CORRECTED: "逾期核实有效",
    LOCKED: "尚未开放",
    VERIFYING: "链接核实中",
  };
  return labels[status];
}

function statusTone(status: TaskStatus): string {
  if (["COMPLETED", "LATE_CORRECTED"].includes(status)) return "success";
  if (status === "EXPIRED") return "danger";
  if (["LOCKED", "CANCELLED"].includes(status)) return "neutral";
  return "warning";
}

function timingLabel(task: EmployeeTask): string {
  const now = Date.now();
  const visibleAt = new Date(task.visibleAt).getTime();
  const expiresAt = new Date(task.expiresAt).getTime();
  if (task.status === "CANCELLED") return "本期任务已取消，无需处理";
  if (task.status === "COMPLETED") return `完成于 ${formatDate(task.verifiedAt ?? task.expiresAt)}`;
  if (task.status === "LATE_CORRECTED") return "逾期后已核实为有效发布";
  if (task.status === "EXPIRED") return "开放后 24 小时内未提交发布链接";
  if (task.status === "VERIFYING") return "已按时提交，等待确认结果";
  if (now < visibleAt) return `${formatDate(task.visibleAt)} 开放`;
  if (now >= expiresAt) return "提交时间已结束";
  const hours = Math.max(1, Math.ceil((expiresAt - now) / 3_600_000));
  return `还剩约 ${hours} 小时提交发布链接`;
}

function metricText(metric: EmployeeTaskMetric | null): string {
  return metric
    ? `阅读 ${metric.views ?? "—"} · 点赞 ${metric.likes ?? "—"} · 收藏 ${metric.favorites ?? "—"}`
    : "";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function maskPhone(phone: string): string {
  return phone.replace(/^(\d{3})\d+(\d{4})$/u, "$1****$2");
}
