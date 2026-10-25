import { createHash, randomUUID } from "node:crypto";
import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  type OnApplicationShutdown,
  ServiceUnavailableException,
} from "@nestjs/common";
import { writeStructuredLog } from "@xhs-agentic/observability";
import Redis from "ioredis";

type RateLimitRequest = Readonly<{
  body?: Readonly<Record<string, unknown>>;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  ip?: string;
  method?: string;
  originalUrl?: string;
  socket?: Readonly<{ remoteAddress?: string }>;
}>;

type RateLimitResponse = Readonly<{
  setHeader(name: string, value: number | string): void;
}>;

export type RateLimitPolicy = Readonly<{
  limit: number;
  name: string;
  subject: string;
  windowMs: number;
}>;

type RateLimitResult = Readonly<{
  allowed: boolean;
  remaining: number;
  resetAfterMs: number;
}>;

const incrementScript = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return { current, ttl }
`;
const rateLimitNamespace =
  process.env.RATE_LIMIT_NAMESPACE ??
  (process.env.NODE_ENV === "test" ? `test-${process.pid}-${randomUUID()}` : "shared");

@Injectable()
export class RateLimitGuard implements CanActivate, OnApplicationShutdown {
  private readonly redis = new Redis(requiredEnv("REDIS_URL"), {
    commandTimeout: positiveInteger(process.env.RATE_LIMIT_REDIS_TIMEOUT_MS ?? "1000"),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  private readonly prefix = requiredEnv("REDIS_PREFIX");

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    const http = context.switchToHttp();
    const request = http.getRequest<RateLimitRequest>();
    const response = http.getResponse<RateLimitResponse>();
    const policies = rateLimitPolicies(request);

    for (const policy of policies) {
      let result: RateLimitResult;
      try {
        result = await this.consume(policy);
      } catch (error) {
        writeStructuredLog({
          event: "rate-limit.dependency.error",
          fields: { error, policy: policy.name },
          level: "error",
          service: "api",
        });
        throw new ServiceUnavailableException("Request rate limiter is unavailable");
      }
      response.setHeader("RateLimit-Limit", policy.limit);
      response.setHeader("RateLimit-Remaining", result.remaining);
      response.setHeader("RateLimit-Reset", Math.ceil(result.resetAfterMs / 1_000));
      if (!result.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil(result.resetAfterMs / 1_000));
        response.setHeader("Retry-After", retryAfterSeconds);
        writeStructuredLog({
          event: "rate-limit.rejected",
          fields: { path: pathOnly(request.originalUrl), policy: policy.name, retryAfterSeconds },
          level: "warn",
          service: "api",
        });
        throw new HttpException(
          {
            code: "RATE_LIMITED",
            details: { policy: policy.name, retryAfterSeconds },
            message: "操作过于频繁，请稍后重试。",
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return true;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === "wait") {
      this.redis.disconnect();
    } else if (this.redis.status !== "end") {
      await this.redis.quit();
    }
  }

  private async consume(policy: RateLimitPolicy): Promise<RateLimitResult> {
    if (this.redis.status === "wait") await this.redis.connect();
    const key = `${this.prefix}:rate-limit:${rateLimitNamespace}:${policy.name}:${hash(policy.subject)}`;
    const raw = await this.redis.eval(incrementScript, 1, key, policy.windowMs);
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error("Rate limiter returned an invalid Redis response");
    }
    const current = Number(raw[0]);
    const resetAfterMs = Math.max(1, Number(raw[1]));
    if (!Number.isSafeInteger(current) || !Number.isFinite(resetAfterMs)) {
      throw new Error("Rate limiter returned invalid counter values");
    }
    return {
      allowed: current <= policy.limit,
      remaining: Math.max(0, policy.limit - current),
      resetAfterMs,
    };
  }
}

export function rateLimitPolicies(request: RateLimitRequest): RateLimitPolicy[] {
  const path = pathOnly(request.originalUrl);
  if (path.startsWith("/health/") || path === "/openapi.json" || path.startsWith("/api-docs")) {
    return [];
  }
  const ip = request.ip ?? request.socket?.remoteAddress ?? "unknown";
  const policies: RateLimitPolicy[] = [
    {
      limit: configuredLimit("RATE_LIMIT_GLOBAL_MAX", 600),
      name: "global-ip",
      subject: ip,
      windowMs: 60_000,
    },
  ];

  if (path.startsWith("/auth/dev/")) {
    policies.push({
      limit: configuredLimit("RATE_LIMIT_DEV_AUTH_MAX", 600),
      name: "development-auth-ip",
      subject: ip,
      windowMs: 60_000,
    });
    return policies;
  }

  if (isCredentialAuthenticationPath(path)) {
    policies.push({
      limit: configuredLimit("RATE_LIMIT_AUTH_IP_MAX", 60),
      name: "auth-ip",
      subject: ip,
      windowMs: 600_000,
    });
    const subject = authenticationSubject(request.body);
    if (subject) {
      policies.push({
        limit: configuredLimit("RATE_LIMIT_AUTH_SUBJECT_MAX", 10),
        name: "auth-subject",
        subject,
        windowMs: 600_000,
      });
    }
  }

  if (path === "/auth/captcha/challenge" || path === "/auth/captcha/password-challenge") {
    policies.push({ name: "sms-challenge-ip", subject: ip, limit: 20, windowMs: 600_000 });
  }

  if (request.method === "POST" && path.startsWith("/auth/admin/account/email/")) {
    policies.push({ name: "admin-email-request-ip", subject: ip, limit: 20, windowMs: 600_000 });
  }
  if (request.method === "POST" && path === "/auth/admin/email/confirm") {
    policies.push({ name: "admin-email-confirm-ip", subject: ip, limit: 30, windowMs: 600_000 });
  }

  if (
    request.method === "POST" &&
    (/\/campaigns(?:\/[^/]+\/(?:approve|retry-failed))?$/u.test(path) ||
      /\/generation-runs\/[^/]+\/recover$/u.test(path) ||
      /^\/platform\/generation-lab\/(?:check|[^/]+\/(?:execute|review|assets))$/u.test(path) ||
      /\/model-providers\/[^/]+\/test-connection$/u.test(path))
  ) {
    policies.push({
      limit: configuredLimit("RATE_LIMIT_EXPENSIVE_MAX", 30),
      name: "expensive-operation-ip",
      subject: ip,
      windowMs: 60_000,
    });
  }

  if (request.method === "POST" && path === "/platform/settings/admin-sms/test") {
    policies.push({ name: "admin-sms-test-ip", subject: ip, limit: 5, windowMs: 60_000 });
    const phone = authenticationSubject(request.body);
    if (phone)
      policies.push({ name: "admin-sms-test-phone", subject: phone, limit: 1, windowMs: 60_000 });
  }

  if (request.method === "POST" && path === "/employee/notifications/identity") {
    policies.push({ name: "wechat-identity-ip", subject: ip, limit: 60, windowMs: 60_000 });
  }

  return policies;
}

function isCredentialAuthenticationPath(path: string): boolean {
  return (
    path === "/auth/admin/request-code" ||
    path === "/auth/admin/login" ||
    path === "/auth/admin/register" ||
    path === "/auth/admin/installation" ||
    path === "/auth/admin/password-login" ||
    path === "/auth/employee/request-code" ||
    path === "/auth/employee/debug/request-code" ||
    path === "/auth/employee/bind" ||
    path === "/auth/employee/debug/bind" ||
    path === "/auth/employee/candidates" ||
    path === "/auth/employee/debug/candidates"
  );
}

function authenticationSubject(body: RateLimitRequest["body"]): string | undefined {
  const phone =
    typeof body?.username === "string" ? body.username.trim().toLowerCase() : body?.phone;
  return typeof phone === "string" && phone.trim() ? phone.trim() : undefined;
}

function pathOnly(value: string | undefined): string {
  return value?.split("?", 1)[0] ?? "";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function configuredLimit(name: string, fallback: number): number {
  return positiveInteger(process.env[name] ?? String(fallback));
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Expected a positive integer");
  return parsed;
}

function requiredEnv(name: "REDIS_PREFIX" | "REDIS_URL"): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
