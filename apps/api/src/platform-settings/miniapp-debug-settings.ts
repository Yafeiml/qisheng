import { isIP } from "node:net";
import { ConflictException } from "@nestjs/common";

export const miniappDebugKeys = [
  "miniapp.debug_code_enabled",
  "miniapp.debug_code_phones",
  "miniapp.debug_code_ips",
  "miniapp.debug_code_until",
] as const;

export type MiniappDebugConfiguration = Readonly<{
  enabled: boolean;
  phones: string;
  ips: string;
  until: string;
}>;

export function validateMiniappDebugConfiguration(configuration: MiniappDebugConfiguration): void {
  const { enabled, phones, ips, until } = configuration;
  const phoneList = phones ? phones.split(",").map((value) => value.trim()) : [];
  const ipList = ips ? ips.split(",").map((value) => value.trim()) : [];
  if (phoneList.length > 5 || phoneList.some((value) => !/^1[3-9]\d{9}$/u.test(value))) {
    throw new ConflictException("测试员工手机号必须是至多 5 个有效手机号，以英文逗号分隔");
  }
  if (
    ipList.length > 5 ||
    (ipList.includes("*") && (ipList.length !== 1 || ipList[0] !== "*")) ||
    ipList.some((value) => value !== "*" && isIP(value) === 0)
  ) {
    throw new ConflictException("允许来源 IP 必须是至多 5 个 IP，或单独填写 *");
  }
  const expires = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(until) ? Date.parse(until) : NaN;
  if (
    until !== "" &&
    until !== "never" &&
    (!Number.isFinite(expires) || new Date(expires).toISOString().replace(".000Z", "Z") !== until)
  ) {
    throw new ConflictException("截止时间必须是 UTC 时间（YYYY-MM-DDTHH:mm:ssZ）或 never");
  }
  if (
    enabled &&
    (phoneList.length === 0 ||
      ipList.length === 0 ||
      (!Number.isFinite(expires) && until !== "never") ||
      (until !== "never" && (expires <= Date.now() || expires > Date.now() + 86_400_000)))
  ) {
    throw new ConflictException(
      "启用前请设置手机号、来源 IP，以及未来 24 小时内的截止时间或 never",
    );
  }
}

export function miniappDebugAllows(
  configuration: MiniappDebugConfiguration,
  phone: string,
  ip: string,
): boolean {
  try {
    validateMiniappDebugConfiguration(configuration);
    const phones = configuration.phones.split(",").map((value) => value.trim());
    const ips = configuration.ips.split(",").map((value) => value.trim());
    return (
      configuration.enabled &&
      phones.includes(phone) &&
      (ips[0] === "*" || ips.includes(ip.replace(/^::ffff:/u, ""))) &&
      (configuration.until === "never" || Date.parse(configuration.until) > Date.now())
    );
  } catch {
    return false;
  }
}
