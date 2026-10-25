import { createHash } from "node:crypto";

export type WechatMiniappErrorDisposition =
  | "RETRYABLE"
  | "PERMANENT"
  | "UNAUTHORIZED"
  | "UNCERTAIN";

/** Safe to persist: neither the provider response nor request credentials are retained. */
export class WechatMiniappError extends Error {
  readonly code: string;
  readonly disposition: WechatMiniappErrorDisposition;

  constructor(code: string, disposition: WechatMiniappErrorDisposition) {
    super(`WeChat miniapp request failed (${code}).`);
    this.name = "WechatMiniappError";
    this.code = code;
    this.disposition = disposition;
  }
}

export interface WechatMiniappCredentials {
  appId: string;
  appSecret: string;
}

export interface WechatSubscriptionInput extends WechatMiniappCredentials {
  openId: string;
  templateId: string;
  page: string;
  environment: "developer" | "trial" | "formal";
  data: Record<string, { value: string }>;
}

interface TokenEntry {
  token: string;
  expiresAt: number;
}

const API_ORIGIN = "https://api.weixin.qq.com";
const MAX_RESPONSE_BYTES = 65_536;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const FIELD_KEY = /^(thing|phrase|time|date)[1-9][0-9]{0,2}$/;
const EXPIRED_TOKEN_CODES = new Set([40001, 40014, 42001]);
const RETRYABLE_CODES = new Set([-1, 45009, 45011, 45028, 45032]);

/** Fixed-origin WeChat APIs. Unknown send outcomes are never automatically resent. */
export class WechatMiniappClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly pendingTokens = new Map<string, Promise<TokenEntry>>();

  constructor(options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new WechatMiniappError("INVALID_TIMEOUT", "PERMANENT");
    }
  }

  async exchangeCode(
    input: WechatMiniappCredentials & { code: string },
  ): Promise<{ openId: string; unionId?: string }> {
    validateCredentials(input);
    if (typeof input.code !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(input.code)) {
      throw new WechatMiniappError("INVALID_LOGIN_CODE", "PERMANENT");
    }
    const url = new URL("/sns/jscode2session", API_ORIGIN);
    url.search = new URLSearchParams({
      appid: input.appId,
      secret: input.appSecret,
      js_code: input.code,
      grant_type: "authorization_code",
    }).toString();
    const body = await this.request(url, { method: "GET" }, false);
    checkProviderError(body);
    if (typeof body.openid !== "string" || !IDENTIFIER.test(body.openid)) {
      throw new WechatMiniappError("LOGIN_RESPONSE_INVALID", "PERMANENT");
    }
    if (
      body.unionid !== undefined &&
      (typeof body.unionid !== "string" || !IDENTIFIER.test(body.unionid))
    ) {
      throw new WechatMiniappError("LOGIN_RESPONSE_INVALID", "PERMANENT");
    }
    // Explicit projection prevents session_key and unexpected provider fields escaping.
    return {
      openId: body.openid,
      ...(typeof body.unionid === "string" ? { unionId: body.unionid } : {}),
    };
  }

  async sendSubscription(input: WechatSubscriptionInput): Promise<void> {
    validateCredentials(input);
    validateSubscriptionInput(input);
    let token = await this.getToken(input, false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = new URL("/cgi-bin/message/subscribe/send", API_ORIGIN);
      url.searchParams.set("access_token", token);
      const body = await this.request(
        url,
        {
          method: "POST",
          body: JSON.stringify({
            touser: input.openId,
            template_id: input.templateId,
            page: input.page,
            miniprogram_state: input.environment,
            lang: "zh_CN",
            data: input.data,
          }),
        },
        true,
      );
      const code = providerCode(body);
      if (code === undefined) throw new WechatMiniappError("SEND_RESPONSE_INVALID", "UNCERTAIN");
      if (code !== undefined && EXPIRED_TOKEN_CODES.has(code) && attempt === 0) {
        // A structured rejection confirms nothing was sent, so one token refresh is safe.
        token = await this.getToken(input, true, token);
        continue;
      }
      checkProviderError(body);
      if (code !== 0) throw new WechatMiniappError("SEND_RESPONSE_INVALID", "UNCERTAIN");
      return;
    }
  }

  private async getToken(
    credentials: WechatMiniappCredentials,
    forceRefresh: boolean,
    rejectedToken?: string,
  ): Promise<string> {
    const key = `${credentials.appId}:${createHash("sha256").update(credentials.appSecret).digest("hex")}`;
    const cached = this.tokens.get(key);
    // Another concurrent request may already have refreshed this rejected token.
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      (!forceRefresh || cached.token !== rejectedToken)
    ) {
      return cached.token;
    }
    if (forceRefresh) this.tokens.delete(key);
    const pending = this.pendingTokens.get(key);
    if (pending) return (await pending).token;
    const loading = this.loadToken(credentials, forceRefresh);
    this.pendingTokens.set(key, loading);
    try {
      const entry = await loading;
      this.tokens.set(key, entry);
      return entry.token;
    } finally {
      this.pendingTokens.delete(key);
    }
  }

  private async loadToken(
    credentials: WechatMiniappCredentials,
    forceRefresh: boolean,
  ): Promise<TokenEntry> {
    const body = await this.request(
      new URL("/cgi-bin/stable_token", API_ORIGIN),
      {
        method: "POST",
        body: JSON.stringify({
          grant_type: "client_credential",
          appid: credentials.appId,
          secret: credentials.appSecret,
          force_refresh: forceRefresh,
        }),
      },
      false,
    );
    checkProviderError(body);
    if (
      typeof body.access_token !== "string" ||
      !/^[A-Za-z0-9_-]{1,2048}$/.test(body.access_token) ||
      typeof body.expires_in !== "number" ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0 ||
      body.expires_in > 86_400
    ) {
      throw new WechatMiniappError("TOKEN_RESPONSE_INVALID", "RETRYABLE");
    }
    return {
      token: body.access_token,
      expiresAt: Date.now() + Math.max(0, body.expires_in * 1000 - 60_000),
    };
  }

  private async request(
    url: URL,
    init: RequestInit,
    sending: boolean,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        ...init,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      const body = await readBoundedJson(response);
      if (!response.ok) {
        // Structured provider rejections are classified by the caller, including token refresh.
        const code = providerCode(body);
        if (code !== undefined && code !== 0) return body;
        throw new WechatMiniappError(
          `HTTP_${response.status}`,
          sending
            ? "UNCERTAIN"
            : response.status === 429 || response.status >= 500
              ? "RETRYABLE"
              : "PERMANENT",
        );
      }
      return body;
    } catch (error) {
      if (error instanceof WechatMiniappError) {
        if (error.code === "RESPONSE_INVALID" || error.code === "RESPONSE_TOO_LARGE") {
          throw new WechatMiniappError(error.code, sending ? "UNCERTAIN" : "RETRYABLE");
        }
        throw error;
      }
      throw new WechatMiniappError(
        controller.signal.aborted ? "TIMEOUT" : "TRANSPORT_FAILURE",
        sending ? "UNCERTAIN" : "RETRYABLE",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new WechatMiniappError("RESPONSE_TOO_LARGE", "RETRYABLE");
  }
  if (!response.body) throw new WechatMiniappError("RESPONSE_INVALID", "RETRYABLE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new WechatMiniappError("RESPONSE_TOO_LARGE", "RETRYABLE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(body)) throw new Error("invalid");
    return body;
  } catch {
    throw new WechatMiniappError("RESPONSE_INVALID", "RETRYABLE");
  }
}

function providerCode(body: Record<string, unknown>): number | undefined {
  return typeof body.errcode === "number" && Number.isSafeInteger(body.errcode)
    ? body.errcode
    : undefined;
}

function checkProviderError(body: Record<string, unknown>): void {
  const code = providerCode(body);
  if (body.errcode !== undefined && code === undefined) {
    throw new WechatMiniappError("RESPONSE_INVALID", "RETRYABLE");
  }
  if (code === undefined || code === 0) return;
  throw new WechatMiniappError(
    String(code),
    code === 43101 ? "UNAUTHORIZED" : RETRYABLE_CODES.has(code) ? "RETRYABLE" : "PERMANENT",
  );
}

function validateCredentials(credentials: WechatMiniappCredentials): void {
  if (
    typeof credentials.appId !== "string" ||
    !/^wx[a-fA-F0-9]{16}$/.test(credentials.appId) ||
    typeof credentials.appSecret !== "string" ||
    !/^[A-Za-z0-9]{32}$/.test(credentials.appSecret)
  ) {
    throw new WechatMiniappError("INVALID_CREDENTIALS", "PERMANENT");
  }
}

function validateSubscriptionInput(input: WechatSubscriptionInput): void {
  if (
    typeof input.openId !== "string" ||
    !IDENTIFIER.test(input.openId) ||
    typeof input.templateId !== "string" ||
    !IDENTIFIER.test(input.templateId) ||
    typeof input.page !== "string" ||
    input.page.length > 1024 ||
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*(?:\?[A-Za-z0-9_~%=&-]*)?$/.test(input.page) ||
    !["developer", "trial", "formal"].includes(input.environment) ||
    !isRecord(input.data)
  ) {
    throw new WechatMiniappError("INVALID_SUBSCRIPTION_INPUT", "PERMANENT");
  }
  const entries = Object.entries(input.data);
  if (entries.length < 1 || entries.length > 5) {
    throw new WechatMiniappError("INVALID_TEMPLATE_DATA", "PERMANENT");
  }
  for (const [key, field] of entries) {
    if (
      !FIELD_KEY.test(key) ||
      !isRecord(field) ||
      typeof field.value !== "string" ||
      !field.value ||
      field.value.length > 128
    ) {
      throw new WechatMiniappError("INVALID_TEMPLATE_DATA", "PERMANENT");
    }
    const length = Array.from(field.value).length;
    if (
      (key.startsWith("thing") && length > 20) ||
      (key.startsWith("phrase") && length > 5) ||
      (key.startsWith("time") && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(field.value)) ||
      (key.startsWith("date") && !/^\d{4}-\d{2}-\d{2}$/.test(field.value))
    ) {
      throw new WechatMiniappError("INVALID_TEMPLATE_DATA", "PERMANENT");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export const subscriptionTemplateSources = [
  "TASK_TITLE",
  "ENTERPRISE_NAME",
  "VISIBLE_AT",
  "EXPIRES_AT",
  "REMARK",
  "TASK_TYPE",
  "TASK_STATUS",
  "TASK_PLATFORM",
] as const;

export type SubscriptionTemplateSource = (typeof subscriptionTemplateSources)[number];
export type SubscriptionTemplateMapping = Record<string, SubscriptionTemplateSource>;
const TIME_SOURCES = new Set<SubscriptionTemplateSource>(["VISIBLE_AT", "EXPIRES_AT"]);

export function parseSubscriptionTemplateMapping(json: string): SubscriptionTemplateMapping {
  if (typeof json !== "string" || json.length > 8192) {
    throw new WechatMiniappError("INVALID_TEMPLATE_MAPPING", "PERMANENT");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new WechatMiniappError("INVALID_TEMPLATE_MAPPING", "PERMANENT");
  }
  return validateSubscriptionTemplateMapping(parsed);
}

/** Requires 1–5 fields and at least one title/enterprise field identifying the new task. */
export function validateSubscriptionTemplateMapping(mapping: unknown): SubscriptionTemplateMapping {
  if (!isRecord(mapping)) throw new WechatMiniappError("INVALID_TEMPLATE_MAPPING", "PERMANENT");
  const entries = Object.entries(mapping);
  if (entries.length < 1 || entries.length > 5) {
    throw new WechatMiniappError("INVALID_TEMPLATE_MAPPING", "PERMANENT");
  }
  let identifying = false;
  const result: SubscriptionTemplateMapping = {};
  for (const [key, value] of entries) {
    if (
      !FIELD_KEY.test(key) ||
      typeof value !== "string" ||
      !subscriptionTemplateSources.includes(value as SubscriptionTemplateSource)
    ) {
      throw new WechatMiniappError("INVALID_TEMPLATE_MAPPING", "PERMANENT");
    }
    const source = value as SubscriptionTemplateSource;
    const temporal = key.startsWith("time") || key.startsWith("date");
    if (temporal !== TIME_SOURCES.has(source)) {
      throw new WechatMiniappError("INVALID_TEMPLATE_MAPPING", "PERMANENT");
    }
    if (source === "TASK_TITLE" || source === "ENTERPRISE_NAME") identifying = true;
    result[key] = source;
  }
  if (!identifying) throw new WechatMiniappError("INVALID_TEMPLATE_MAPPING", "PERMANENT");
  return result;
}

export interface SubscriptionTemplateDataInput {
  title: string;
  enterpriseName: string;
  visibleAt: Date | string;
  expiresAt: Date | string;
  remark?: string;
  taskType?: string;
  taskStatus?: string;
  taskPlatform?: string;
}

export function formatSubscriptionData(
  mapping: SubscriptionTemplateMapping,
  input: SubscriptionTemplateDataInput,
): Record<string, { value: string }> {
  const validated = validateSubscriptionTemplateMapping(mapping);
  const text: Partial<Record<SubscriptionTemplateSource, string>> = {
    TASK_TITLE: input.title,
    ENTERPRISE_NAME: input.enterpriseName,
    REMARK: input.remark ?? "新任务已发布，请及时领取",
    TASK_TYPE: input.taskType ?? "内容任务",
    TASK_STATUS: input.taskStatus ?? "待领取",
    TASK_PLATFORM: input.taskPlatform ?? "小红书",
  };
  const result: Record<string, { value: string }> = {};
  for (const [key, source] of Object.entries(validated)) {
    if (TIME_SOURCES.has(source)) {
      const value = formatShanghaiTime(source === "VISIBLE_AT" ? input.visibleAt : input.expiresAt);
      result[key] = { value: key.startsWith("date") ? value.slice(0, 10) : value };
    } else {
      const raw = text[source];
      if (typeof raw !== "string")
        throw new WechatMiniappError("INVALID_TEMPLATE_DATA", "PERMANENT");
      const value = Array.from(
        raw
          .replace(/\p{Cc}/gu, " ")
          .replace(/\s+/g, " ")
          .trim(),
      )
        .slice(0, key.startsWith("phrase") ? 5 : 20)
        .join("");
      if (!value) throw new WechatMiniappError("INVALID_TEMPLATE_DATA", "PERMANENT");
      result[key] = { value };
    }
  }
  return result;
}

function formatShanghaiTime(value: Date | string): string {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new WechatMiniappError("INVALID_TEMPLATE_TIME", "PERMANENT");
  }
  // Reject ambiguous strings rather than interpreting them in the execution host timezone.
  if (
    typeof value === "string" &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new WechatMiniappError("INVALID_TEMPLATE_TIME", "PERMANENT");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() < 1 ||
    date.getUTCFullYear() > 9999
  ) {
    throw new WechatMiniappError("INVALID_TEMPLATE_TIME", "PERMANENT");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}
