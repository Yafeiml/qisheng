import { createHmac, randomInt } from "node:crypto";
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnApplicationShutdown,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { normalizeChineseMobilePhone } from "../employee/phone";
import { miniappDebugAllows, miniappDebugKeys } from "../platform-settings/miniapp-debug-settings";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { closeRedisClient, createLazyRedisClient } from "../redis/redis-client";
import { AdminSmsService } from "./admin-sms.service";
import type {
  BindEmployeeDto,
  RequestEmployeeCodeDto,
  VerifyEmployeeCodeDto,
} from "./employee-auth.dto";
import { EmployeeBindingService } from "./employee-binding.service";
import { SmsPurpose } from "./sms-security.dto";
import { SMS_RETRY_SECONDS, SmsSecurityService } from "./sms-security.service";

const DEVELOPMENT_CODE = "000000";
const CODE_TTL_SECONDS = 300;
const VERIFY_CODE = `
local digest = redis.call('GET', KEYS[1])
if not digest then return 0 end
local attempts = tonumber(redis.call('GET', KEYS[2]) or '0')
if attempts >= 5 then redis.call('DEL', KEYS[1]); return 0 end
if digest == ARGV[1] then
  if ARGV[2] == 'consume' then redis.call('DEL', KEYS[1], KEYS[2]) end
  return 1
end
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('EXPIRE', KEYS[2], 300) end
if count >= 5 then redis.call('DEL', KEYS[1]) end
return 0
`;

@Injectable()
export class EmployeeAuthenticationService implements OnApplicationShutdown {
  private readonly redis = createLazyRedisClient("employee-authentication");

  constructor(
    @Inject(EmployeeBindingService)
    private readonly binding: EmployeeBindingService,
    @Inject(AdminSmsService) private readonly sms: AdminSmsService,
    @Inject(SmsSecurityService) private readonly security: SmsSecurityService,
    @Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader,
  ) {}

  async requestCode(input: RequestEmployeeCodeDto, ip = "unknown") {
    const phone = normalizePhone(input.phone);
    const development =
      process.env.NODE_ENV !== "production" && process.env.ENABLE_DEV_AUTH === "true";
    const configuration = development ? null : await this.sms.current();
    if (configuration?.mode === "DEVELOPMENT") {
      throw new ServiceUnavailableException("员工短信登录需要配置正式短信通道，请联系平台管理员。");
    }
    const reservation = await this.security.authorize(
      phone,
      SmsPurpose.EMPLOYEE_BIND,
      ip,
      input.captcha,
      development,
    );
    const code = development ? DEVELOPMENT_CODE : String(randomInt(0, 1_000_000)).padStart(6, "0");
    const digest = codeDigest(phone, code);
    await this.redis
      .multi()
      .set(this.codeKey(phone), digest, "EX", CODE_TTL_SECONDS)
      .del(this.attemptKey(phone))
      .exec();
    if (configuration) {
      try {
        await this.sms.send(configuration, {
          code,
          expiresInSeconds: CODE_TTL_SECONDS,
          phone,
          purpose: "EMPLOYEE_BIND",
        });
      } catch (error) {
        await this.redis.eval(
          "local value = redis.call('GET', KEYS[1]); if value == ARGV[1] then return redis.call('DEL', KEYS[1]); end; return 0;",
          1,
          this.codeKey(phone),
          digest,
        );
        await this.security.releaseFailedSend(phone, reservation);
        throw error;
      }
    }
    return {
      retryAfterSeconds: SMS_RETRY_SECONDS,
      delivery: configuration?.delivery ?? "DEVELOPMENT_ADAPTER",
      ...(development ? { developmentCode: code } : {}),
      expiresInSeconds: CODE_TTL_SECONDS,
      phoneMasked: maskPhone(phone),
    };
  }

  // Temporary test lane: separate endpoints and Redis keys leave real SMS codes untouched.
  async requestDebugCode(input: RequestEmployeeCodeDto, ip = "unknown") {
    const phone = normalizePhone(input.phone);
    await this.assertDebugAccess(phone, ip);
    await this.binding.listBindableMemberships(phone);
    await this.security.authorize(phone, SmsPurpose.EMPLOYEE_BIND, ip, input.captcha);
    await this.redis
      .multi()
      .set(this.debugCodeKey(phone), codeDigest(phone, DEVELOPMENT_CODE), "EX", CODE_TTL_SECONDS)
      .del(this.debugAttemptKey(phone))
      .exec();
    return {
      retryAfterSeconds: SMS_RETRY_SECONDS,
      delivery: "TEMPORARY_DEBUG",
      developmentCode: DEVELOPMENT_CODE,
      expiresInSeconds: CODE_TTL_SECONDS,
      phoneMasked: maskPhone(phone),
    };
  }

  async debugCandidates(input: VerifyEmployeeCodeDto, ip = "unknown") {
    const phone = normalizePhone(input.phone);
    await this.assertDebugAccess(phone, ip);
    const valid = await this.redis.eval(
      VERIFY_CODE,
      2,
      this.debugCodeKey(phone),
      this.debugAttemptKey(phone),
      codeDigest(phone, input.code),
      "check",
    );
    if (valid !== 1) throw new UnauthorizedException("验证码错误或已过期，请重新获取。");
    return {
      candidates: await this.binding.listBindableMemberships(phone),
      phoneMasked: maskPhone(phone),
    };
  }

  async debugBind(input: BindEmployeeDto, ip = "unknown") {
    const phone = normalizePhone(input.phone);
    await this.assertDebugAccess(phone, ip);
    const consumed = await this.redis.eval(
      VERIFY_CODE,
      2,
      this.debugCodeKey(phone),
      this.debugAttemptKey(phone),
      codeDigest(phone, input.code),
      "consume",
    );
    if (consumed !== 1) throw new UnauthorizedException("验证码错误或已过期，请重新获取。");
    return this.binding.bindVerifiedPhone({ enterpriseIds: input.enterpriseIds, phone });
  }

  async bind(input: BindEmployeeDto) {
    const phone = normalizePhone(input.phone);
    const expected = codeDigest(phone, input.code);
    const consumed = await this.redis.eval(
      VERIFY_CODE,
      2,
      this.codeKey(phone),
      this.attemptKey(phone),
      expected,
      "consume",
    );
    if (consumed !== 1) {
      throw new UnauthorizedException("验证码错误或已过期，请检查验证码或重新获取。");
    }
    return this.binding.bindVerifiedPhone({ enterpriseIds: input.enterpriseIds, phone });
  }

  async candidates(input: VerifyEmployeeCodeDto) {
    const phone = normalizePhone(input.phone);
    const valid = await this.redis.eval(
      VERIFY_CODE,
      2,
      this.codeKey(phone),
      this.attemptKey(phone),
      codeDigest(phone, input.code),
      "check",
    );
    if (valid !== 1) {
      throw new UnauthorizedException("验证码错误或已过期，请检查验证码或重新获取。");
    }
    return {
      candidates: await this.binding.listBindableMemberships(phone),
      phoneMasked: maskPhone(phone),
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await closeRedisClient(this.redis);
  }

  private async assertDebugAccess(phone: string, ip: string): Promise<void> {
    const values = await this.settings.resolveMany(miniappDebugKeys);
    if (
      !miniappDebugAllows(
        {
          enabled: values.get("miniapp.debug_code_enabled")?.value === true,
          phones: String(values.get("miniapp.debug_code_phones")?.value ?? ""),
          ips: String(values.get("miniapp.debug_code_ips")?.value ?? ""),
          until: String(values.get("miniapp.debug_code_until")?.value ?? ""),
        },
        phone,
        ip,
      )
    ) {
      throw new NotFoundException("临时验证码接口未启用。");
    }
  }

  private codeKey(phone: string): string {
    return `${requiredEnv("REDIS_PREFIX")}:identity:employee-code:${phone}`;
  }
  private attemptKey(phone: string): string {
    return `${requiredEnv("REDIS_PREFIX")}:identity:employee-code-attempt:${phone}`;
  }
  private debugCodeKey(phone: string): string {
    return `${requiredEnv("REDIS_PREFIX")}:identity:employee-debug-code:${phone}`;
  }
  private debugAttemptKey(phone: string): string {
    return `${requiredEnv("REDIS_PREFIX")}:identity:employee-debug-code-attempt:${phone}`;
  }
}

function codeDigest(phone: string, code: string): string {
  const secret = requiredEnv("EMPLOYEE_OTP_HMAC_SECRET");
  return createHmac("sha256", secret).update(`${phone}:${code}`).digest("hex");
}

function normalizePhone(value: string): string {
  try {
    return normalizeChineseMobilePhone(value);
  } catch (error) {
    throw new ConflictException(error instanceof Error ? error.message : "Phone is invalid");
  }
}

function requiredEnv(name: "REDIS_PREFIX" | "EMPLOYEE_OTP_HMAC_SECRET"): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function maskPhone(phone: string): string {
  return phone.replace(/^(\d{3})\d+(\d{4})$/u, "$1****$2");
}
