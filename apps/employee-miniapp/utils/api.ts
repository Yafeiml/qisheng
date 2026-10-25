import { miniappConfig } from "../config";
import { clearSession, loadSession } from "./session";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export function getApiBaseUrl(): string {
  return miniappConfig.apiBaseUrl.replace(/\/+$/u, "");
}

export function storageObjectUrl(value: string): string {
  return value.startsWith("/api/storage/objects/")
    ? `${getApiBaseUrl().replace(/\/$/u, "")}${value.slice(4)}`
    : value;
}

export async function apiRequest<T>(
  path: string,
  options: Readonly<{
    body?: WechatMiniprogram.IAnyObject;
    idempotencyKey?: string;
    method?: "GET" | "POST";
    token?: string;
  }> = {},
): Promise<T> {
  const token =
    options.token ?? (path.startsWith("/auth/") ? undefined : loadSession()?.accessToken);
  const header: Record<string, string> = {};
  if (token) header.Authorization = `Bearer ${token}`;
  if (options.idempotencyKey) header["Idempotency-Key"] = options.idempotencyKey;
  return new Promise<T>((resolve, reject) => {
    wx.request<WechatMiniprogram.IAnyObject>({
      data: options.body,
      header,
      method: options.method ?? "GET",
      timeout: 15_000,
      url: `${getApiBaseUrl()}${path}`,
      fail(reason) {
        reject(new ApiError(reason.errMsg || "无法连接服务器", 0));
      },
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data as T);
          return;
        }
        if (response.statusCode === 401 && token && loadSession()?.accessToken === token) {
          clearSession();
        }
        reject(
          new ApiError(
            errorMessage(response.data, response.statusCode),
            response.statusCode,
            response.data,
          ),
        );
      },
    });
  });
}

export function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : "操作失败，请稍后重试";
}

function errorMessage(body: unknown, statusCode: number): string {
  if (body && typeof body === "object" && "message" in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string") return message;
    if (Array.isArray(message)) return message.join("；");
  }
  return `请求失败（${statusCode}）`;
}
