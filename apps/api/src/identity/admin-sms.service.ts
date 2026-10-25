import { randomUUID } from "node:crypto";
import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { withPublicHttpResponse } from "@xhs-agentic/network-security";
import {
  type AliyunSmsConfiguration,
  readAliyunSmsConfiguration,
} from "../platform-settings/admin-sms.configuration";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { isProductionCredential } from "../platform-settings/production-secret";
import { isProductionHttpsEndpoint } from "../platform-settings/publication-policy-evidence";
import { AliyunSmsClient } from "./aliyun-sms.client";

const MAX_RESPONSE_BYTES = 64 * 1024;

export type AdminSmsConfiguration = Readonly<
  | { delivery: "DEVELOPMENT_ADAPTER"; mode: "DEVELOPMENT" }
  | (AliyunSmsConfiguration & { delivery: "ALIYUN_SMS"; mode: "ALIYUN" })
  | {
      apiKey: string;
      delivery: "HTTP_SMS_GATEWAY";
      endpoint: string;
      mode: "HTTP";
      provider: string;
      sender: string;
      templateId: string;
      timeoutMs: number;
    }
>;

export type AdminSmsDeliveryResult = Readonly<{
  messageId: string;
  provider: string;
}>;

@Injectable()
export class AdminSmsService {
  constructor(
    @Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader,
    @Inject(AliyunSmsClient) private readonly aliyun: AliyunSmsClient,
  ) {}

  async current(): Promise<AdminSmsConfiguration> {
    const rows = await this.settings.resolveMany([
      "security.admin_sms_api_key",
      "security.admin_sms_endpoint",
      "security.admin_sms_mode",
      "security.admin_sms_provider",
      "security.admin_sms_sender",
      "security.admin_sms_template_id",
      "security.admin_sms_timeout_ms",
    ]);
    const mode = rows.get("security.admin_sms_mode")?.value;
    if (mode === "ALIYUN")
      return { ...(await readAliyunSmsConfiguration(this.settings)), mode, delivery: "ALIYUN_SMS" };
    if (mode === "DEVELOPMENT") {
      return { delivery: "DEVELOPMENT_ADAPTER", mode };
    }
    if (mode !== "HTTP") throw unavailable("Administrator SMS mode is invalid");
    const timeoutMs = rows.get("security.admin_sms_timeout_ms")?.value;
    if (typeof timeoutMs !== "number") throw unavailable("Administrator SMS timeout is missing");
    const endpoint = required(rows.get("security.admin_sms_endpoint")?.value, "Endpoint");
    const parsed = new URL(endpoint);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw unavailable("Administrator SMS Endpoint is unsafe");
    }
    if (process.env.NODE_ENV === "production" && !isProductionHttpsEndpoint(endpoint)) {
      throw unavailable("Administrator SMS Endpoint must be a public HTTPS URL in production");
    }
    const apiKey = required(rows.get("security.admin_sms_api_key")?.value, "API Key");
    if (process.env.NODE_ENV === "production" && !isProductionCredential(apiKey, 4)) {
      throw unavailable("Administrator SMS API Key is a development placeholder");
    }
    return {
      apiKey,
      delivery: "HTTP_SMS_GATEWAY",
      endpoint,
      mode,
      provider: required(rows.get("security.admin_sms_provider")?.value, "provider code"),
      sender: required(rows.get("security.admin_sms_sender")?.value, "sender"),
      templateId: required(rows.get("security.admin_sms_template_id")?.value, "template ID"),
      timeoutMs,
    };
  }

  async send(
    configuration: Exclude<AdminSmsConfiguration, { mode: "DEVELOPMENT" }>,
    input: Readonly<{
      code: string;
      expiresInSeconds: number;
      phone: string;
      purpose?: "ADMIN_LOGIN" | "EMPLOYEE_BIND";
      templateId?: string;
    }>,
  ): Promise<AdminSmsDeliveryResult> {
    const purpose = input.purpose === "EMPLOYEE_BIND" ? "employee-bind-code" : "admin-login-code";
    const requestId = `${purpose}:${randomUUID()}`;
    if (configuration.mode === "ALIYUN")
      return this.aliyun.send(configuration, {
        phone: input.phone,
        code: input.code,
        requestId,
        templateCode: input.templateId,
      });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), configuration.timeoutMs);
    try {
      const request: RequestInit = {
        body: JSON.stringify({
          code: input.code,
          expiresInSeconds: input.expiresInSeconds,
          phone: input.phone,
          requestId,
          sender: configuration.sender,
          templateId: input.templateId ?? configuration.templateId,
        }),
        headers: {
          Authorization: `Bearer ${configuration.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": requestId,
        },
        method: "POST",
        signal: controller.signal,
      };
      return await withPublicHttpResponse(
        configuration.endpoint,
        request,
        {
          allowHttp: process.env.NODE_ENV !== "production",
          allowPrivate: process.env.NODE_ENV !== "production",
        },
        async (response) => {
          const raw = await boundedText(response);
          const payload = parseRecord(raw);
          if (!response.ok) {
            throw unavailable(`Administrator SMS gateway returned HTTP ${response.status}`);
          }
          if (payload.status !== "ACCEPTED") {
            throw unavailable("Administrator SMS gateway did not accept the message");
          }
          return {
            messageId: required(payload.messageId, "message ID"),
            provider: configuration.provider,
          };
        },
      );
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw unavailable("Administrator SMS gateway timed out");
      }
      throw unavailable("Administrator SMS gateway request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw unavailable("Administrator SMS response is too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
    throw unavailable("Administrator SMS response is too large");
  }
  return raw;
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Normalized below without returning the provider payload.
  }
  throw unavailable("Administrator SMS gateway returned invalid JSON");
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw unavailable(`Administrator SMS ${label} is not configured`);
  }
  return value.trim();
}

function unavailable(message: string): ServiceUnavailableException {
  return new ServiceUnavailableException({ code: "ADMIN_SMS_UNAVAILABLE", message });
}
