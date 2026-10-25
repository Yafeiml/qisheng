import { ConflictException } from "@nestjs/common";
import { parseSubscriptionTemplateMapping } from "@xhs-agentic/wechat-miniapp";
import { normalizeCapEndpoint } from "./cap-endpoint";
import type { PlatformSettingDefinition, PlatformSettingScalar } from "./platform-setting-catalog";

export function validatePlatformSettingValue(
  definition: PlatformSettingDefinition,
  input: unknown,
): PlatformSettingScalar {
  if (input === null) {
    if (definition.nullable) return null;
    throw invalid(definition, "不能为空");
  }
  if (definition.valueType === "BOOLEAN") {
    if (typeof input !== "boolean") throw invalid(definition, "必须是布尔值");
    return input;
  }
  if (definition.valueType === "INTEGER" || definition.valueType === "DECIMAL") {
    if (typeof input !== "number" || !Number.isFinite(input)) {
      throw invalid(definition, "必须是有效数字");
    }
    if (definition.valueType === "INTEGER" && !Number.isSafeInteger(input)) {
      throw invalid(definition, "必须是安全整数");
    }
    if (definition.min !== undefined && input < definition.min) {
      throw invalid(definition, `不能小于 ${definition.min}`);
    }
    if (definition.max !== undefined && input > definition.max) {
      throw invalid(definition, `不能大于 ${definition.max}`);
    }
    return input;
  }
  if (typeof input !== "string") throw invalid(definition, "必须是字符串");
  const value = definition.valueType === "SECRET" ? input : input.trim();
  if (definition.valueType === "SECRET" && !value.trim())
    throw invalid(definition, "密钥不能为空；不修改时请勿提交此字段");
  if (
    definition.nullable &&
    value === "" &&
    !(definition.group === "PAYMENT" && definition.valueType === "SECRET")
  )
    return "";
  if (definition.minLength !== undefined && value.length < definition.minLength) {
    throw invalid(definition, `长度不能少于 ${definition.minLength} 个字符`);
  }
  if (definition.maxLength !== undefined && value.length > definition.maxLength) {
    throw invalid(definition, `长度不能超过 ${definition.maxLength} 个字符`);
  }
  if (definition.pattern && !new RegExp(definition.pattern, "u").test(value)) {
    throw invalid(definition, "格式不正确");
  }
  if (definition.valueType === "ENUM") {
    const allowed = definition.options?.some((option) => option.value === value) ?? false;
    if (!allowed && !(definition.nullable && value === "")) {
      throw invalid(definition, "不在允许的选项中");
    }
  }
  if (definition.valueType === "URL" && value !== "") {
    if (definition.key === "security.cap_endpoint") return normalizeCapEndpoint(value);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalid(definition, "必须是有效 URL");
    }
    if (!new Set(["http:", "https:"]).has(url.protocol)) {
      throw invalid(definition, "只允许 HTTP 或 HTTPS URL");
    }
  }
  if (definition.key === "notification.wechat_template_fields" && value !== "") {
    try {
      parseSubscriptionTemplateMapping(value);
    } catch {
      throw invalid(definition, "必须是有效的微信模板字段映射 JSON");
    }
  }
  return value;
}

export function parsePlatformSettingEnvironmentValue(
  definition: PlatformSettingDefinition,
  raw: string,
): PlatformSettingScalar {
  if (definition.valueType === "BOOLEAN") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw invalid(definition, "环境变量必须是 true 或 false");
  }
  if (definition.valueType === "INTEGER" || definition.valueType === "DECIMAL") {
    return validatePlatformSettingValue(definition, Number(raw));
  }
  return validatePlatformSettingValue(definition, raw);
}

function invalid(definition: PlatformSettingDefinition, message: string): ConflictException {
  return new ConflictException({
    code: "PLATFORM_SETTING_INVALID",
    key: definition.key,
    message: `${definition.label}${message}`,
  });
}
