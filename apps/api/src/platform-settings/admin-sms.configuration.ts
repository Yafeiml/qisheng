import { ServiceUnavailableException } from "@nestjs/common";
import type { Prisma } from "@xhs-agentic/database";
import type { PlatformSettingsReader } from "./platform-settings.reader";
import { isProductionCredential } from "./production-secret";

export const ALIYUN_SMS_KEYS = {
  accessKeyId: "security.admin_sms_access_key_id",
  accessKeySecret: "security.admin_sms_access_key_secret",
  signName: "security.admin_sms_sign_name",
  templateCode: "security.admin_sms_template_code",
} as const;
export const ADMIN_SMS_MODE_KEY = "security.admin_sms_mode";
export type AliyunSmsConfiguration = Readonly<Record<keyof typeof ALIYUN_SMS_KEYS, string>>;

export function validateAliyunSmsConfiguration(configuration: AliyunSmsConfiguration) {
  const missing = Object.entries(configuration)
    .filter(([, value]) => !value.trim())
    .map(
      ([key]) =>
        ({
          accessKeyId: "ACCESS_KEY_ID",
          accessKeySecret: "ACCESS_KEY_SECRET",
          signName: "SIGN_NAME",
          templateCode: "TEMPLATE_CODE",
        })[key],
    );
  if (missing.length)
    throw new ServiceUnavailableException({
      code: "ADMIN_SMS_SETTINGS_INCOMPLETE",
      message: `请先配置阿里云短信：${missing.join("、")}`,
    });
  if (
    process.env.NODE_ENV === "production" &&
    (!isProductionCredential(configuration.accessKeyId, 4) ||
      !isProductionCredential(configuration.accessKeySecret, 8))
  )
    throw new ServiceUnavailableException({
      code: "ADMIN_SMS_SETTINGS_INCOMPLETE",
      message: "阿里云短信需要有效的 AccessKey，不能使用开发占位值",
    });
}

export async function readAliyunSmsConfiguration(
  reader: PlatformSettingsReader,
  transaction?: Prisma.TransactionClient,
): Promise<AliyunSmsConfiguration> {
  const rows = await reader.resolveMany(Object.values(ALIYUN_SMS_KEYS), transaction);
  const configuration = Object.fromEntries(
    Object.entries(ALIYUN_SMS_KEYS).map(([field, key]) => [
      field,
      String(rows.get(key)?.value ?? "").trim(),
    ]),
  ) as AliyunSmsConfiguration;
  validateAliyunSmsConfiguration(configuration);
  return configuration;
}
