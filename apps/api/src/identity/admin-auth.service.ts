import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  type OnApplicationShutdown,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { AdminTokenAuthenticator } from "../access/admin-token-authenticator";
import { AuthTokenService } from "../access/auth-token.service";
import { seedAuthorizationCatalog } from "../access/authorization.seed";
import { PrismaService } from "../database/prisma.service";
import { normalizeChineseMobilePhone } from "../employee/phone";
import { seedRuntimePolicy } from "../model-configuration/runtime-policy.seed";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { seedPlatformSettings } from "../platform-settings/platform-settings.seed";
import { closeRedisClient, createLazyRedisClient } from "../redis/redis-client";
import type {
  InitializeInstallationDto,
  LoginAdminDto,
  PasswordLoginDto,
  PasswordRegisterDto,
  RequestAdminCodeDto,
} from "./admin-auth.dto";
import { activeAdminRoleBindingWhere } from "./admin-scope-policy";
import { AdminSmsService } from "./admin-sms.service";
import { hashPassword, normalizeUsername, verifyPassword } from "./password";
import { SmsPurpose } from "./sms-security.dto";
import { SMS_RETRY_SECONDS, SmsSecurityService } from "./sms-security.service";

const DEVELOPMENT_CODE = "000000";
const CODE_TTL_SECONDS = 300;
const MAX_CODE_ATTEMPTS = 5;

type RefreshResult = Readonly<{
  accessToken: string;
  expiresInSeconds: number;
  refreshExpiresAt: Date;
  refreshToken: string;
  sessionId: string;
}>;

@Injectable()
export class AdminAuthenticationService implements OnApplicationShutdown {
  private readonly redis = createLazyRedisClient("admin-authentication");
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthTokenService) private readonly tokens: AuthTokenService,
    @Inject(AdminTokenAuthenticator)
    private readonly tokenAuthenticator: AdminTokenAuthenticator,
    @Inject(PlatformSettingsReader)
    private readonly platformSettings: PlatformSettingsReader,
    @Inject(AdminSmsService) private readonly sms: AdminSmsService,
    @Inject(SmsSecurityService) private readonly security: SmsSecurityService,
  ) {}

  async requestCode(input: RequestAdminCodeDto, ip = "unknown") {
    const phone = normalizePhone(input.phone);
    const configuration = await this.sms.current();
    if (configuration.mode === "DEVELOPMENT") {
      if (process.env.NODE_ENV === "production") {
        throw new ServiceUnavailableException(
          "Production administrator authentication requires a real SMS provider",
        );
      }
      if (process.env.ENABLE_DEV_AUTH !== "true") {
        throw new ServiceUnavailableException("Development authentication delivery is disabled");
      }
    }

    const reservation = await this.security.authorize(
      phone,
      SmsPurpose.ADMIN_LOGIN,
      ip,
      input.captcha,
      configuration.mode === "DEVELOPMENT",
    );
    const eligible =
      configuration.mode === "DEVELOPMENT" ||
      (await this.prisma.adminUser.count({
        where: {
          phone,
          roleBindings: { some: activeAdminRoleBindingWhere },
          status: "ACTIVE",
        },
      })) > 0;
    if (!eligible) {
      return codeResponse(phone, configuration.delivery, false);
    }
    const code =
      configuration.mode === "DEVELOPMENT"
        ? DEVELOPMENT_CODE
        : randomInt(0, 1_000_000).toString().padStart(6, "0");
    await this.redis
      .multi()
      .set(this.codeKey(phone), codeDigest(phone, code), "EX", CODE_TTL_SECONDS)
      .del(this.attemptKey(phone))
      .exec();

    if (configuration.mode !== "DEVELOPMENT") {
      try {
        const delivery = await this.sms.send(configuration, {
          code,
          expiresInSeconds: CODE_TTL_SECONDS,
          phone,
        });
        await this.prisma.auditLog.create({
          data: {
            action: "admin-auth.code-delivered",
            actorType: "SYSTEM",
            metadata: {
              messageId: delivery.messageId,
              phoneMasked: maskPhone(phone),
              provider: delivery.provider,
            },
            resourceId: createHash("sha256").update(phone).digest("hex"),
            resourceType: "AdminLoginCode",
          },
        });
      } catch (error) {
        await this.redis.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1], KEYS[2]) end; return 0",
          2,
          this.codeKey(phone),
          this.attemptKey(phone),
          codeDigest(phone, code),
        );
        await this.security.releaseFailedSend(phone, reservation);
        throw error;
      }
    }

    return codeResponse(phone, configuration.delivery, configuration.mode === "DEVELOPMENT");
  }

  async login(input: LoginAdminDto, userAgent: string | undefined): Promise<RefreshResult> {
    const phone = normalizePhone(input.phone);
    await this.consumeCode(phone, input.code);

    const user = await this.prisma.adminUser.findFirst({
      select: { id: true },
      where: {
        phone,
        roleBindings: { some: activeAdminRoleBindingWhere },
        status: "ACTIVE",
      },
    });
    if (!user) {
      throw new UnauthorizedException("Phone or verification code is invalid");
    }

    return this.createSession(user.id, userAgent, true);
  }

  async passwordLogin(
    input: PasswordLoginDto,
    ip: string,
    userAgent?: string,
  ): Promise<RefreshResult> {
    const username = normalizeUsername(input.username);
    await this.security.verifyProof(username, SmsPurpose.PASSWORD_LOGIN, ip, input.captcha);
    const user = await this.prisma.adminUser.findUnique({ where: { username } });
    const matches = await verifyPassword(input.password, user?.passwordHash ?? null);
    const activeRoles = user
      ? await this.prisma.roleBinding.count({
          where: { userId: user.id, ...activeAdminRoleBindingWhere },
        })
      : 0;
    const activeEmployee = user?.employeeUserId
      ? await this.prisma.globalUser.count({
          where: {
            id: user.employeeUserId,
            status: "ACTIVE",
            memberships: {
              some: {
                status: "ACTIVE",
                seatStatus: "ENABLED",
                enterprise: { status: "ACTIVE" },
                tenant: { status: "ACTIVE" },
              },
            },
          },
        })
      : 0;
    if (!matches || !user || user.status !== "ACTIVE" || (!activeRoles && !activeEmployee))
      throw new UnauthorizedException("账号或密码不正确，或账号已停用");
    return this.createSession(user.id, userAgent);
  }

  async register(
    _input: PasswordRegisterDto,
    _ip: string,
    _userAgent?: string,
  ): Promise<RefreshResult> {
    throw new ForbiddenException("自助注册已关闭，请联系管理员创建账号");
  }

  async installationStatus() {
    const [administrators, organizations] = await Promise.all([
      this.prisma.adminUser.count(),
      this.prisma.tenant.count(),
    ]);
    return { initialized: administrators > 0 || organizations > 0 };
  }

  async initializeInstallation(
    input: InitializeInstallationDto,
    userAgent?: string,
  ): Promise<RefreshResult> {
    const expectedToken = process.env.INSTALLATION_TOKEN?.trim();
    if (!expectedToken || expectedToken.length < 32)
      throw new ServiceUnavailableException("请先通过部署引导生成安装密钥");
    if (!safeHashEquals(tokenHash(expectedToken), tokenHash(input.installationToken)))
      throw new UnauthorizedException("安装密钥无效");
    const username = normalizeUsername(input.username);
    const passwordHash = await hashPassword(input.password);
    const organizationName = input.organizationName.trim();
    let userId: string;
    try {
      userId = await this.prisma.$transaction(
        async (transaction) => {
          // Every API process must serialize the one-time installation check.
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(1936026726, 20261015)`;
          const [administrators, organizations] = await Promise.all([
            transaction.adminUser.count(),
            transaction.tenant.count(),
          ]);
          if (administrators > 0 || organizations > 0)
            throw new ConflictException("安装已完成，请登录；已有账号和企业不会被覆盖");
          await seedAuthorizationCatalog(transaction);
          await seedRuntimePolicy(transaction);
          await transaction.platformSetting.upsert({
            where: { key: "storage.provider" },
            create: {
              key: "storage.provider",
              group: "STORAGE",
              valueType: "ENUM",
              value: "LOCAL",
              updatedBy: "system:installation",
            },
            update: {},
          });
          await seedPlatformSettings(transaction);
          const roles = await transaction.role.findMany({
            where: {
              code: { in: ["PLATFORM_ADMIN", "TENANT_ADMIN", "ENTERPRISE_ADMIN"] },
              status: "ACTIVE",
            },
          });
          const platformRole = roles.find(({ code }) => code === "PLATFORM_ADMIN");
          const organizationRole = roles.find(
            ({ code }) =>
              code === (input.organizationType === "GROUP" ? "TENANT_ADMIN" : "ENTERPRISE_ADMIN"),
          );
          if (!platformRole || !organizationRole)
            throw new ServiceUnavailableException("基础管理员角色初始化失败");
          const user = await transaction.adminUser.create({
            data: { username, passwordHash, name: input.name },
          });
          const tenant = await transaction.tenant.create({
            data: { name: organizationName, customerType: input.organizationType },
          });
          await transaction.tenantCapabilityPolicy.create({ data: { tenantId: tenant.id } });
          const enterprise =
            input.organizationType === "SINGLE_ENTERPRISE"
              ? await transaction.enterprise.create({
                  data: {
                    name: organizationName,
                    tenantId: tenant.id,
                    code: `workspace-${randomUUID()}`,
                  },
                })
              : null;
          await transaction.roleBinding.create({
            data: {
              userId: user.id,
              roleId: organizationRole.id,
              scopeType: enterprise ? "ENTERPRISE" : "TENANT",
              scopeId: enterprise?.id ?? tenant.id,
              tenantId: tenant.id,
              ...(enterprise ? { enterpriseId: enterprise.id } : {}),
            },
          });
          await transaction.roleBinding.create({
            data: {
              userId: user.id,
              roleId: platformRole.id,
              scopeType: "PLATFORM",
              scopeId: "platform",
            },
          });
          await transaction.auditLog.create({
            data: {
              action: "installation.initialized",
              actorType: "USER",
              actorUserId: user.id,
              resourceType: "Tenant",
              resourceId: tenant.id,
              tenantId: tenant.id,
              ...(enterprise ? { enterpriseId: enterprise.id } : {}),
              metadata: { organizationType: input.organizationType, username },
            },
          });
          return user.id;
        },
        { timeout: 15000 },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new ConflictException("安装初始化发生冲突，请刷新安装状态后重试");
      throw error;
    }
    return this.createSession(userId, userAgent);
  }

  private async createSession(
    userId: string,
    userAgent?: string,
    verifiedPhone = false,
  ): Promise<RefreshResult> {
    const [refreshTtlSeconds, maxActiveSessions] = await Promise.all([
      this.platformSettings.number("security.admin_refresh_token_ttl_seconds"),
      this.platformSettings.number("security.max_active_admin_sessions"),
    ]);
    const now = new Date();
    const sessionId = randomUUID();
    const refreshExpiresAt = new Date(now.getTime() + refreshTtlSeconds * 1000);
    const refreshToken = createRefreshToken(sessionId);
    await this.prisma.$transaction(async (transaction) => {
      const activeSessions = await transaction.adminSession.findMany({
        orderBy: { lastUsedAt: "desc" },
        select: { id: true },
        where: { expiresAt: { gt: now }, revokedAt: null, userId },
      });
      const sessionsToRevoke = activeSessions.slice(maxActiveSessions - 1);
      if (sessionsToRevoke.length > 0) {
        await transaction.adminSession.updateMany({
          data: { revokeReason: "SESSION_LIMIT", revokedAt: now },
          where: { id: { in: sessionsToRevoke.map(({ id }) => id) } },
        });
      }
      await transaction.adminSession.create({
        data: {
          expiresAt: refreshExpiresAt,
          id: sessionId,
          refreshTokenHash: tokenHash(refreshToken),
          userAgent: normalizedUserAgent(userAgent),
          userId,
        },
      });
      await transaction.adminUser.update({
        data: { lastLoginAt: now, ...(verifiedPhone ? { phoneVerifiedAt: now } : {}) },
        where: { id: userId },
      });
      await transaction.auditLog.create({
        data: {
          action: "admin-session.login",
          actorType: "USER",
          actorUserId: userId,
          metadata: { sessionId },
          resourceId: sessionId,
          resourceType: "AdminSession",
        },
      });
    });

    return this.authResult(userId, sessionId, refreshToken, refreshExpiresAt);
  }

  async refresh(refreshToken: string | null): Promise<RefreshResult> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw new UnauthorizedException("Administrator refresh session is required");

    const now = new Date();
    const replacement = createRefreshToken(parsed.sessionId);
    const result = await this.prisma.$transaction(async (transaction) => {
      const session = await transaction.adminSession.findUnique({
        include: {
          user: {
            select: {
              id: true,
              roleBindings: {
                select: { id: true },
                take: 1,
                where: activeAdminRoleBindingWhere,
              },
              status: true,
              employeeUser: {
                select: {
                  status: true,
                  memberships: {
                    take: 1,
                    select: { id: true },
                    where: {
                      status: "ACTIVE",
                      seatStatus: "ENABLED",
                      enterprise: { status: "ACTIVE" },
                      tenant: { status: "ACTIVE" },
                    },
                  },
                },
              },
            },
          },
        },
        where: { id: parsed.sessionId },
      });
      const valid =
        session &&
        !session.revokedAt &&
        session.expiresAt > now &&
        session.user.status === "ACTIVE" &&
        (session.user.roleBindings.length > 0 ||
          (session.user.employeeUser?.status === "ACTIVE" &&
            session.user.employeeUser.memberships.length > 0)) &&
        safeHashEquals(session.refreshTokenHash, tokenHash(parsed.token));
      if (!valid) {
        if (session && !session.revokedAt) {
          await transaction.adminSession.update({
            data: {
              revokeReason:
                session.expiresAt <= now ? "REFRESH_EXPIRED" : "REFRESH_REPLAY_OR_INVALID",
              revokedAt: now,
            },
            where: { id: session.id },
          });
        }
        return null;
      }
      const rotated = await transaction.adminSession.updateMany({
        data: { lastUsedAt: now, refreshTokenHash: tokenHash(replacement) },
        where: {
          id: session.id,
          refreshTokenHash: session.refreshTokenHash,
          revokedAt: null,
        },
      });
      if (rotated.count !== 1) return null;
      return {
        expiresAt: session.expiresAt,
        sessionId: session.id,
        userId: session.user.id,
      };
    });
    if (!result) throw new UnauthorizedException("Administrator refresh session is invalid");
    return this.authResult(result.userId, result.sessionId, replacement, result.expiresAt);
  }

  async logout(refreshToken: string | null): Promise<void> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return;
    const session = await this.prisma.adminSession.findUnique({
      select: { refreshTokenHash: true, revokedAt: true, userId: true },
      where: { id: parsed.sessionId },
    });
    if (
      !session ||
      session.revokedAt ||
      !safeHashEquals(session.refreshTokenHash, tokenHash(parsed.token))
    ) {
      return;
    }
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.adminSession.update({
        data: { revokeReason: "LOGOUT", revokedAt: now },
        where: { id: parsed.sessionId },
      }),
      this.prisma.auditLog.create({
        data: {
          action: "admin-session.logout",
          actorType: "USER",
          actorUserId: session.userId,
          metadata: { sessionId: parsed.sessionId },
          resourceId: parsed.sessionId,
          resourceType: "AdminSession",
        },
      }),
    ]);
  }

  async logoutAll(authorization: string | undefined): Promise<void> {
    const { userId } = await this.tokenAuthenticator.authenticate(authorization);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.adminSession.updateMany({
        data: { revokeReason: "LOGOUT_ALL", revokedAt: now },
        where: { revokedAt: null, userId },
      }),
      this.prisma.auditLog.create({
        data: {
          action: "admin-session.logout-all",
          actorType: "USER",
          actorUserId: userId,
          resourceId: userId,
          resourceType: "AdminUser",
        },
      }),
    ]);
  }

  async onApplicationShutdown(): Promise<void> {
    await closeRedisClient(this.redis);
  }

  private authResult(
    userId: string,
    sessionId: string,
    refreshToken: string,
    refreshExpiresAt: Date,
  ): RefreshResult {
    return {
      accessToken: this.tokens.issueAdminAccessToken(userId, sessionId),
      expiresInSeconds: this.tokens.accessTokenTtlSeconds,
      refreshExpiresAt,
      refreshToken,
      sessionId,
    };
  }

  private async consumeCode(phone: string, code: string): Promise<void> {
    const attempts = await this.redis.incr(this.attemptKey(phone));
    if (attempts === 1) await this.redis.expire(this.attemptKey(phone), CODE_TTL_SECONDS);
    if (attempts > MAX_CODE_ATTEMPTS) {
      await this.redis.del(this.codeKey(phone));
      throw new UnauthorizedException("Verification code is invalid or expired");
    }
    const consumed = await this.redis.eval(
      "local value = redis.call('GET', KEYS[1]); if value == ARGV[1] then redis.call('DEL', KEYS[1]); redis.call('DEL', KEYS[2]); return 1; end; return 0;",
      2,
      this.codeKey(phone),
      this.attemptKey(phone),
      codeDigest(phone, code),
    );
    if (consumed !== 1) {
      throw new UnauthorizedException("Verification code is invalid or expired");
    }
  }

  private attemptKey(phone: string): string {
    return `${requiredEnv("REDIS_PREFIX")}:identity:admin-code-attempt:${phone}`;
  }

  private codeKey(phone: string): string {
    return `${requiredEnv("REDIS_PREFIX")}:identity:admin-code:${phone}`;
  }
}

function codeDigest(phone: string, code: string): string {
  return createHmac("sha256", requiredEnv("ADMIN_OTP_HMAC_SECRET"))
    .update(`${phone}:${code}`)
    .digest("hex");
}

function createRefreshToken(sessionId: string): string {
  return `${sessionId}.${randomBytes(32).toString("base64url")}`;
}

function parseRefreshToken(value: string | null): { sessionId: string; token: string } | null {
  if (!value || value.length > 200) return null;
  const separator = value.indexOf(".");
  if (separator < 1 || separator === value.length - 1) return null;
  const sessionId = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (!/^[0-9a-f-]{36}$/iu.test(sessionId) || !/^[A-Za-z0-9_-]{43}$/u.test(secret)) return null;
  return { sessionId, token: value };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeHashEquals(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "ascii");
  const actualBytes = Buffer.from(actual, "ascii");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function normalizePhone(phone: string): string {
  try {
    return normalizeChineseMobilePhone(phone);
  } catch (error) {
    throw new ConflictException(error instanceof Error ? error.message : "Phone is invalid");
  }
}

function normalizedUserAgent(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 300) : undefined;
}

function requiredEnv(name: "ADMIN_OTP_HMAC_SECRET" | "REDIS_PREFIX"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function maskPhone(phone: string): string {
  return phone.replace(/^(\d{3})\d+(\d{4})$/u, "$1****$2");
}

function codeResponse(phone: string, delivery: string, development: boolean) {
  return {
    retryAfterSeconds: SMS_RETRY_SECONDS,
    delivery,
    developmentCode: development ? DEVELOPMENT_CODE : undefined,
    expiresInSeconds: CODE_TTL_SECONDS,
    phoneMasked: maskPhone(phone),
  };
}
