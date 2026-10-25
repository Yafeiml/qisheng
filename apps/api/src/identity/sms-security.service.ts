import { createHash, randomUUID } from "node:crypto";
import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  type OnApplicationShutdown,
  ServiceUnavailableException,
} from "@nestjs/common";
import { normalizeCapEndpoint } from "../platform-settings/cap-endpoint";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { closeRedisClient, createLazyRedisClient } from "../redis/redis-client";
import type {
  CaptchaProofDto,
  SmsChallengeRequestDto,
  SmsChallengeResponseDto,
  SmsPurpose,
} from "./sms-security.dto";

export const SMS_RETRY_SECONDS = 60;
const CONTEXT_TTL = 300;
// Check every budget before modifying any of them; concurrent API processes share one reservation.
export const RESERVE_SEND_BUDGET = `
local wait = redis.call('TTL', KEYS[1])
if wait > 0 then return {1, wait} end
for i = 2, #KEYS do
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  if count >= tonumber(ARGV[i * 2 - 1]) then return {i, math.max(1, redis.call('TTL', KEYS[i]))} end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
for i = 2, #KEYS do
  local count = redis.call('INCR', KEYS[i])
  if count == 1 then redis.call('EXPIRE', KEYS[i], ARGV[i * 2]) end
end
return {0, 0}
`;

@Injectable()
export class SmsSecurityService implements OnApplicationShutdown {
  private readonly redis = createLazyRedisClient("sms-security", { commandTimeout: 2000 });

  constructor(@Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader) {}

  async challenge(
    input: SmsChallengeRequestDto | { phone: string; purpose: "ADMIN_EMAIL_VERIFY" },
    ip: string,
  ): Promise<SmsChallengeResponseDto> {
    if (!(await this.enabled())) return { required: false };
    await this.assertCooldown(input.phone);
    const { endpoint } = await this.configuration();
    const result = await this.capRequest("challenge", {}, ip, endpoint);
    const challenge = result.challenge as { c?: number; s?: number; d?: number } | undefined;
    if (
      typeof result.token !== "string" ||
      !challenge ||
      typeof challenge.c !== "number" ||
      !Number.isInteger(challenge.c) ||
      typeof challenge.s !== "number" ||
      !Number.isInteger(challenge.s) ||
      typeof challenge.d !== "number" ||
      !Number.isInteger(challenge.d) ||
      challenge.c < 1 ||
      challenge.c > 100 ||
      challenge.s < 1 ||
      challenge.s > 64 ||
      challenge.d < 1 ||
      challenge.d > 4 ||
      result.instrumentation
    ) {
      throw unavailable();
    }
    await this.redisOperation(() =>
      this.redis.set(
        this.contextKey(result.token as string),
        this.context(input.phone, input.purpose, ip),
        "EX",
        CONTEXT_TTL,
      ),
    );
    return {
      required: true,
      challenge: { c: challenge.c, s: challenge.s, d: challenge.d },
      token: result.token,
      expires: Date.now() + CONTEXT_TTL * 1000,
    };
  }

  async authorize(
    phone: string,
    purpose: SmsPurpose,
    ip: string,
    proof?: CaptchaProofDto,
    developmentDelivery = false,
  ): Promise<string> {
    if (this.development() && developmentDelivery) return "development";
    await this.assertCooldown(phone);
    await this.verifyProof(phone, purpose, ip, proof);
    const reservation = randomUUID();
    const phoneHash = hash(phone);
    const ipHash = hash(ip);
    const budgets = [
      [`phone-quarter:${phoneHash}`, 3, 900],
      [`phone-day:${phoneHash}`, 10, 86400],
      [`ip-hour:${ipHash}`, 20, 3600],
      [`ip-day:${ipHash}`, 100, 86400],
      ["all-day", 1000, 86400],
    ] as const;
    const result = (await this.redisOperation(() =>
      this.redis.eval(
        RESERVE_SEND_BUDGET,
        budgets.length + 1,
        this.cooldownKey(phone),
        ...budgets.map(([key]) => this.key(key)),
        reservation,
        SMS_RETRY_SECONDS,
        ...budgets.flatMap(([, limit, ttl]) => [limit, ttl]),
      ),
    )) as [number, number];
    if (result[0] !== 0) throw limited(result[1], result[0] === 1 ? "sms-cooldown" : "sms-budget");
    return reservation;
  }

  async verifyProof(
    phone: string,
    purpose: SmsPurpose | "ADMIN_EMAIL_VERIFY",
    ip: string,
    proof?: CaptchaProofDto,
  ): Promise<void> {
    if (await this.enabled()) {
      if (!proof?.token || !Array.isArray(proof.solutions)) throw invalidProof();
      const context = await this.redisOperation(() =>
        this.redis.getdel(this.contextKey(proof.token)),
      );
      if (context !== this.context(phone, purpose, ip)) throw invalidProof();
      const { endpoint, secret } = await this.configuration();
      const redeemed = await this.capRequest("redeem", proof, ip, endpoint);
      if (redeemed.success !== true || typeof redeemed.token !== "string") throw invalidProof();
      const verified = await this.capRequest(
        "siteverify",
        { response: redeemed.token, secret },
        ip,
        endpoint,
      );
      if (verified.success !== true) throw invalidProof();
    }
  }

  async releaseFailedSend(phone: string, reservation: string): Promise<void> {
    // Failed supplier calls still consume budgets, but may be retried without a full cooldown.
    await this.redisOperation(() =>
      this.redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0",
        1,
        this.cooldownKey(phone),
        reservation,
      ),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await closeRedisClient(this.redis);
  }

  private async assertCooldown(phone: string): Promise<void> {
    const ttl = await this.redisOperation(() => this.redis.ttl(this.cooldownKey(phone)));
    if (ttl > 0) throw limited(ttl, "sms-cooldown");
  }

  private development(): boolean {
    return process.env.NODE_ENV !== "production" && process.env.ENABLE_DEV_AUTH === "true";
  }

  async passwordChallenge(
    username: string,
    purpose: SmsPurpose,
    ip: string,
  ): Promise<SmsChallengeResponseDto> {
    return this.challenge({ phone: username.trim().toLowerCase(), purpose }, ip);
  }

  private async enabled(): Promise<boolean> {
    try {
      return await this.settings.boolean("security.cap_enabled");
    } catch {
      throw unavailable();
    }
  }
  private key(suffix: string): string {
    const prefix = process.env.REDIS_PREFIX;
    if (!prefix) throw unavailable();
    return `${prefix}:identity:sms-security:${suffix}`;
  }
  private cooldownKey(phone: string): string {
    return this.key(`cooldown:${hash(phone)}`);
  }
  private contextKey(token: string): string {
    return this.key(`captcha:${hash(token)}`);
  }
  private context(phone: string, purpose: SmsPurpose | "ADMIN_EMAIL_VERIFY", ip: string): string {
    return hash(`${purpose}:${phone}:${ip}`);
  }

  private async configuration(): Promise<{ endpoint: string; secret: string }> {
    try {
      const resolved = await this.settings.resolveMany([
        "security.cap_endpoint",
        "security.cap_secret",
      ]);
      const endpoint = resolved.get("security.cap_endpoint")?.value;
      const secret = resolved.get("security.cap_secret")?.value;
      if (typeof endpoint !== "string" || !endpoint || typeof secret !== "string" || !secret.trim())
        throw unavailable();
      return { endpoint: normalizeCapEndpoint(endpoint), secret };
    } catch {
      throw unavailable();
    }
  }

  private async capRequest(
    action: "challenge" | "redeem" | "siteverify",
    body: object,
    ip: string,
    endpoint: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${endpoint}${action}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify(body),
      });
    } catch {
      throw unavailable();
    }
    if (!response.ok) {
      if (action !== "challenge" && [400, 403, 404].includes(response.status)) throw invalidProof();
      throw unavailable();
    }
    try {
      const text = await response.text();
      if (text.length > 16384) throw unavailable();
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable();
      return parsed as Record<string, unknown>;
    } catch {
      throw unavailable();
    }
  }

  private async redisOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw unavailable();
    }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException("安全验证服务暂时不可用，请稍后重试。");
}
function invalidProof(): ForbiddenException {
  return new ForbiddenException({
    code: "CAPTCHA_INVALID",
    message: "安全验证已失效，请重新获取验证码。",
  });
}
function limited(retryAfterSeconds: number, policy: string): HttpException {
  return new HttpException(
    {
      code: "RATE_LIMITED",
      message:
        policy === "sms-cooldown"
          ? `验证码已发送，请 ${retryAfterSeconds} 秒后重试。`
          : "验证码请求过于频繁，请稍后重试。",
      details: { retryAfterSeconds, policy },
    },
    429,
  );
}
