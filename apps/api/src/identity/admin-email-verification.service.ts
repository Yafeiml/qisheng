import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  type OnApplicationShutdown,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AdminTokenAuthenticator } from "../access/admin-token-authenticator";
import { allowedOrigins } from "../configure-application";
import { PrismaService } from "../database/prisma.service";
import { NotificationMailer, resolveMailConfiguration } from "../notifications/notification-mailer";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { closeRedisClient, createLazyRedisClient } from "../redis/redis-client";
import type { CaptchaProofDto } from "./sms-security.dto";
import { RESERVE_SEND_BUDGET, SmsSecurityService } from "./sms-security.service";

const EMAIL_SEND_RETRY_SECONDS = 60;
const READ_SEND_WAIT = `
local wait = math.max(0, redis.call('PTTL', KEYS[1]))
for i = 2, #KEYS do
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  if count >= tonumber(ARGV[i - 1]) then
    wait = math.max(wait, redis.call('PTTL', KEYS[i]))
  end
end
return math.ceil(wait / 1000)
`;

@Injectable()
export class AdminEmailVerificationService implements OnApplicationShutdown {
  private readonly redis = createLazyRedisClient("admin-email-verification", {
    commandTimeout: 2000,
  });

  constructor(
    @Inject(AdminTokenAuthenticator) private readonly authenticator: AdminTokenAuthenticator,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader,
    @Inject(NotificationMailer) private readonly mailer: NotificationMailer,
    @Inject(SmsSecurityService) private readonly security: SmsSecurityService,
  ) {}

  async status(authorization: string | undefined, ip: string) {
    const { userId } = await this.authenticator.authenticate(authorization);
    const user = await this.prisma.adminUser.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    return { retryAfterSeconds: await this.retryAfter(userId, user.email, ip) };
  }

  async challenge(authorization: string | undefined, ip: string) {
    const user = await this.account(authorization);
    await this.assertAvailable(user.id, user.email, ip);
    return this.security.challenge(
      { phone: this.subject(user), purpose: "ADMIN_EMAIL_VERIFY" },
      ip,
    );
  }

  async send(authorization: string | undefined, ip: string, proof?: CaptchaProofDto) {
    const user = await this.account(authorization);
    await this.assertAvailable(user.id, user.email, ip);
    const configuration = await resolveMailConfiguration(this.settings, user.email);
    if (!configuration)
      throw new ServiceUnavailableException("请联系平台管理员配置通知邮件的 SMTP 发件服务");
    const origin = new URL(allowedOrigins()[0] ?? "");
    if (
      origin.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        ["localhost", "127.0.0.1"].includes(origin.hostname)
      )
    ) {
      throw new ServiceUnavailableException("管理员网站地址必须配置为 HTTPS");
    }
    await this.security.verifyProof(this.subject(user), "ADMIN_EMAIL_VERIFY", ip, proof);
    await this.reserve(user.id, user.email, ip);
    const token = randomBytes(32).toString("hex");
    const tokenHash = hash(token);
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    const claimed = await this.prisma.adminUser.updateMany({
      where: { id: user.id, email: user.email, emailVerifiedAt: null, status: "ACTIVE" },
      data: { emailVerificationTokenHash: tokenHash, emailVerificationExpiresAt: expiresAt },
    });
    if (!claimed.count) throw new ConflictException("个人资料已改变，请刷新后重试");
    const link = new URL("/verify-email", origin.origin);
    // A fragment keeps the bearer token out of HTTP access logs and referrer headers.
    link.hash = `token=${token}`;
    try {
      await this.mailer.sendEmailVerification(configuration, link.toString());
    } catch {
      await this.prisma.adminUser.updateMany({
        where: { id: user.id, emailVerificationTokenHash: tokenHash },
        data: { emailVerificationTokenHash: null, emailVerificationExpiresAt: null },
      });
      throw new ServiceUnavailableException({
        code: "ADMIN_EMAIL_DELIVERY_FAILED",
        message: "验证邮件发送失败，请稍后重试或联系平台管理员检查 SMTP 配置",
        details: {
          retryAfterSeconds: await this.retryAfter(user.id, user.email, ip).catch(
            () => EMAIL_SEND_RETRY_SECONDS,
          ),
        },
      });
    }
    return {
      sent: true,
      retryAfterSeconds: await this.retryAfter(user.id, user.email, ip).catch(
        () => EMAIL_SEND_RETRY_SECONDS,
      ),
      expiresInSeconds: 1800,
    };
  }

  async confirm(token: string) {
    const verified = await this.prisma.adminUser.updateMany({
      where: {
        emailVerificationTokenHash: hash(token),
        emailVerificationExpiresAt: { gt: new Date() },
        emailVerifiedAt: null,
        email: { not: null },
        status: "ACTIVE",
      },
      data: {
        emailVerifiedAt: new Date(),
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null,
      },
    });
    if (!verified.count)
      throw new BadRequestException("验证链接已失效或已使用，请在个人中心重新发送验证邮件");
    return { verified: true };
  }

  private async account(authorization: string | undefined) {
    const { userId } = await this.authenticator.authenticate(authorization);
    const user = await this.prisma.adminUser.findUnique({ where: { id: userId } });
    if (!user?.email || !user.name?.trim()) throw new ConflictException("请先保存姓名和邮箱");
    if (user.emailVerifiedAt) throw new ConflictException("当前邮箱已验证");
    return { ...user, email: user.email };
  }

  private subject(user: { id: string; email: string }) {
    return `admin-email:${user.id}:${user.email}`;
  }

  private budget(userId: string, email: string | null, ip: string) {
    const prefix = process.env.REDIS_PREFIX;
    if (!prefix) throw new ServiceUnavailableException("邮件限流服务尚未配置");
    const key = (suffix: string) => `${prefix}:identity:email-verification:${suffix}`;
    const budgets: [string, number, number][] = [
      [`user-quarter:${hash(userId)}`, 3, 900],
      [`user-day:${hash(userId)}`, 10, 86400],
      [`ip-hour:${hash(ip)}`, 20, 3600],
      [`ip-day:${hash(ip)}`, 100, 86400],
      ["all-day", 1000, 86400],
    ];
    if (email) {
      budgets.push(
        [`email-quarter:${hash(email.toLowerCase())}`, 3, 900],
        [`email-day:${hash(email.toLowerCase())}`, 10, 86400],
      );
    }
    return {
      keys: [key(`cooldown:${hash(userId)}`), ...budgets.map(([suffix]) => key(suffix))],
      budgets,
    };
  }

  private async retryAfter(userId: string, email: string | null, ip: string) {
    const { keys, budgets } = this.budget(userId, email, ip);
    try {
      const seconds = await this.redis.eval(
        READ_SEND_WAIT,
        keys.length,
        ...keys,
        ...budgets.map(([, limit]) => limit),
      );
      if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 0)
        throw new Error();
      return seconds;
    } catch {
      throw new ServiceUnavailableException("邮件限流服务暂时不可用，请稍后重试");
    }
  }

  private async assertAvailable(userId: string, email: string, ip: string) {
    const seconds = await this.retryAfter(userId, email, ip);
    if (seconds > 0) throw rateLimited(seconds);
  }

  private async reserve(userId: string, email: string, ip: string) {
    const { keys, budgets } = this.budget(userId, email, ip);
    let result: unknown;
    try {
      result = await this.redis.eval(
        RESERVE_SEND_BUDGET,
        keys.length,
        ...keys,
        randomUUID(),
        EMAIL_SEND_RETRY_SECONDS,
        ...budgets.flatMap(([, limit, ttl]) => [limit, ttl]),
      );
      if (!Array.isArray(result) || result.length !== 2 || !result.every(Number.isInteger))
        throw new Error();
    } catch {
      throw new ServiceUnavailableException("邮件限流服务暂时不可用，请稍后重试");
    }
    if (result[0] !== 0) throw rateLimited(result[1]);
  }

  async onApplicationShutdown() {
    await closeRedisClient(this.redis);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rateLimited(retryAfterSeconds: number): HttpException {
  return new HttpException(
    {
      code: "RATE_LIMITED",
      message: "验证邮件请求过于频繁，请稍后重试",
      details: { retryAfterSeconds },
    },
    429,
  );
}
