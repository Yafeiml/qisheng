import type { EmployeeNotificationConfiguration, EmployeeSubscriptionResult } from "../types";

export interface SubscriptionContext {
  appId: string;
  authorizationGeneration: number;
  identityVersion: number;
  templateId: string;
}

export interface PendingSubscription extends SubscriptionContext {
  idempotencyKey: string;
  status: EmployeeSubscriptionResult;
}

export function isNotificationIdentityVersion(version: unknown): version is number {
  return typeof version === "number" && Number.isSafeInteger(version) && version > 0;
}

export function notificationIdempotencyKey(action: "identity" | "subscription"): string {
  return `miniapp-${action}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function checkNotificationConfiguration(config: EmployeeNotificationConfiguration): void {
  if (!config.enabled) return;
  if (!config.appId || !config.templateId) throw new Error("新任务通知尚未完成配置，请稍后再试。");
  // Older base libraries may not expose account information. Never send a client OpenID.
  if (typeof wx.getAccountInfoSync !== "function") return;
  const runtimeAppId = wx.getAccountInfoSync().miniProgram.appId;
  if (runtimeAppId && runtimeAppId !== config.appId) {
    throw new Error("当前小程序与通知配置不匹配，请联系平台管理员。");
  }
}

export function loginForNotifications(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      timeout: 10_000,
      success(result) {
        if (result.code) resolve(result.code);
        else reject(new Error("微信身份验证未完成，请重试。"));
      },
      fail() {
        reject(new Error("暂时无法验证微信身份，请重试。"));
      },
    });
  });
}

export function notificationStatusText(config: EmployeeNotificationConfiguration): string {
  if (!config.enabled) return "新任务通知暂未开放，任务可照常查看。";
  if (config.remainingSubscriptions > 0) {
    return `已订阅，剩余 ${config.remainingSubscriptions} 次新任务提醒。`;
  }
  if (config.subscriptionStatus === "REJECT") return "本次未订阅，仍可照常查看任务。";
  if (config.subscriptionStatus === "BAN") return "微信暂不允许订阅此通知，请稍后再试。";
  return "订阅后，新任务开放时会通过微信提醒你。";
}
