import { ConflictException } from "@nestjs/common";
import {
  parseSubscriptionTemplateMapping,
  type SubscriptionTemplateMapping,
} from "@xhs-agentic/wechat-miniapp";
import type { PlatformSettingsReader } from "./platform-settings.reader";

export const wechatNotificationKeys = [
  "miniapp.wechat_app_id",
  "miniapp.wechat_app_secret",
  "notification.enabled",
  "notification.channel",
  "notification.wechat_template_id",
  "notification.wechat_template_fields",
  "notification.wechat_environment",
] as const;

export type WechatNotificationConfiguration = Readonly<{
  appId: string;
  appSecret: string;
  templateId: string;
  mapping: SubscriptionTemplateMapping;
  environment: "developer" | "trial" | "formal";
}>;

export function validateWechatNotificationConfiguration(
  settings: ReadonlyMap<string, Readonly<{ value: unknown }>>,
): WechatNotificationConfiguration {
  const value = (key: string) => settings.get(key)?.value;
  const appId = value("miniapp.wechat_app_id");
  const appSecret = value("miniapp.wechat_app_secret");
  const templateId = value("notification.wechat_template_id");
  const fields = value("notification.wechat_template_fields");
  const environment = value("notification.wechat_environment");
  if (
    typeof appId !== "string" ||
    !/^wx[0-9a-f]{16}$/u.test(appId) ||
    typeof appSecret !== "string" ||
    !/^[A-Za-z0-9]{32}$/u.test(appSecret) ||
    typeof templateId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(templateId) ||
    typeof fields !== "string" ||
    fields.length === 0 ||
    !["developer", "trial", "formal"].includes(String(environment)) ||
    value("notification.channel") !== "WECHAT_TEMPLATE"
  ) {
    throw new ConflictException({
      code: "WECHAT_NOTIFICATION_SETTINGS_INCOMPLETE",
      message:
        "启用任务通知前请填写小程序 AppID、AppSecret、订阅模板 ID、字段映射和版本，并选择微信订阅消息渠道。",
    });
  }
  let mapping: SubscriptionTemplateMapping;
  try {
    mapping = parseSubscriptionTemplateMapping(fields);
  } catch {
    throw new ConflictException({
      code: "WECHAT_NOTIFICATION_TEMPLATE_INVALID",
      message:
        "订阅模板字段映射不正确，请按微信模板的 thing/phrase/time/date 编号及页面说明填写 JSON。",
    });
  }
  return {
    appId,
    appSecret,
    templateId,
    mapping,
    environment: environment as WechatNotificationConfiguration["environment"],
  };
}

export async function readWechatNotificationConfiguration(
  reader: Pick<PlatformSettingsReader, "resolveMany">,
): Promise<WechatNotificationConfiguration | null> {
  const channel = await reader.resolveMany(["notification.enabled", "notification.channel"]);
  if (
    channel.get("notification.enabled")?.value !== true ||
    channel.get("notification.channel")?.value !== "WECHAT_TEMPLATE"
  )
    return null;
  const settings = await reader.resolveMany(wechatNotificationKeys);
  if (
    settings.get("notification.enabled")?.value !== true ||
    settings.get("notification.channel")?.value !== "WECHAT_TEMPLATE"
  )
    return null;
  return validateWechatNotificationConfiguration(settings);
}
