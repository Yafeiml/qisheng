import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { ALIYUN_SMS_KEYS, validateAliyunSmsConfiguration } from "./admin-sms.configuration";
import {
  validateWechatNotificationConfiguration,
  wechatNotificationKeys,
} from "./wechat-notification.configuration";

export const smsMaterialNotificationKeys = [
  "notification.enabled",
  "notification.channel",
  "notification.sms_template_code",
  "notification.sms_daily_limit",
  ALIYUN_SMS_KEYS.accessKeyId,
  ALIYUN_SMS_KEYS.accessKeySecret,
  ALIYUN_SMS_KEYS.signName,
] as const;

export const materialNotificationKeys: readonly string[] = [
  ...new Set([...wechatNotificationKeys, ...smsMaterialNotificationKeys]),
];

export function validateMaterialNotificationConfiguration(
  settings: ReadonlyMap<string, Readonly<{ value: unknown }>>,
): void {
  if (settings.get("notification.channel")?.value !== "ALIYUN_SMS") {
    validateWechatNotificationConfiguration(settings);
    return;
  }
  const text = (key: string) => String(settings.get(key)?.value ?? "").trim();
  const templateCode = text("notification.sms_template_code");
  const dailyLimit = settings.get("notification.sms_daily_limit")?.value;
  if (
    !/^SMS_\d{1,60}$/u.test(templateCode) ||
    typeof dailyLimit !== "number" ||
    !Number.isSafeInteger(dailyLimit) ||
    dailyLimit < 1 ||
    dailyLimit > 50
  )
    throw new ConflictException({
      code: "MATERIAL_SMS_SETTINGS_INCOMPLETE",
      message: "启用素材开放短信前请填写独立的通知模板代码，并设置每人每日 1 至 50 条的发送上限。",
    });
  try {
    validateAliyunSmsConfiguration({
      accessKeyId: text(ALIYUN_SMS_KEYS.accessKeyId),
      accessKeySecret: text(ALIYUN_SMS_KEYS.accessKeySecret),
      signName: text(ALIYUN_SMS_KEYS.signName),
      templateCode,
    });
  } catch (error) {
    if (error instanceof ServiceUnavailableException)
      throw new ConflictException({
        code: "MATERIAL_SMS_SETTINGS_INCOMPLETE",
        message: "启用素材开放短信前请在短信设置中配置有效的阿里云 AccessKey 和短信签名。",
      });
    throw error;
  }
}
