import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import Redis from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminTokenAuthenticator } from "../access/admin-token-authenticator";
import type { PrismaService } from "../database/prisma.service";
import type { NotificationMailer } from "../notifications/notification-mailer";
import type { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { closeRedisClient, createLazyRedisClient } from "../redis/redis-client";
import { AdminEmailVerificationService } from "./admin-email-verification.service";
import type { SmsSecurityService } from "./sms-security.service";

describe("administrator email persistent send limits", { concurrent: false }, () => {
  const redis = createLazyRedisClient("admin-email-limit-tests");
  const user = {
    id: randomUUID(),
    email: "email-limit@example.test" as string | null,
    name: "测试管理员" as string | null,
    emailVerifiedAt: null,
  };
  const authenticate = vi.fn(async () => ({ userId: user.id }));
  const prisma = {
    adminUser: {
      findUnique: vi.fn(async () => user),
      findUniqueOrThrow: vi.fn(async () => user),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const settings = {
    resolveMany: vi.fn(
      async (keys: string[]) =>
        new Map(
          keys.map((key) => [
            key,
            {
              value: key.endsWith("smtp_sender")
                ? "sender@example.test"
                : key.endsWith("smtp_password")
                  ? "test-only"
                  : "",
            },
          ]),
        ),
    ),
  };
  const mailer = { sendEmailVerification: vi.fn(async () => {}) };
  const security = {
    challenge: vi.fn(async () => ({ required: false })),
    verifyProof: vi.fn(async () => {}),
  };
  const createService = () =>
    new AdminEmailVerificationService(
      { authenticate } as unknown as AdminTokenAuthenticator,
      prisma as unknown as PrismaService,
      settings as unknown as PlatformSettingsReader,
      mailer as unknown as NotificationMailer,
      security as unknown as SmsSecurityService,
    );
  const service = createService();
  const secondService = createService();
  const services = [service, secondService];
  const basePrefix = process.env.REDIS_PREFIX;
  const ip = "192.0.2.51";
  const authorization = "Bearer test-only";
  let prefix: string;

  beforeEach(() => {
    prefix = `${basePrefix}:email-limit:${randomUUID()}`;
    vi.stubEnv("REDIS_PREFIX", prefix);
    vi.stubEnv("ADMIN_WEB_ORIGIN", "http://localhost:3101");
    user.email = "email-limit@example.test";
    user.name = "测试管理员";
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await Promise.all(services.map((instance) => instance.onApplicationShutdown()));
    await closeRedisClient(redis);
  });

  function key(suffix: string) {
    return `${prefix}:identity:email-verification:${suffix}`;
  }
  const userHash = createHash("sha256").update(user.id).digest("hex");
  const cooldownKey = () => key(`cooldown:${userHash}`);

  it("reads the shared cooldown after a new page request or API instance and across email changes", async () => {
    expect(await service.status(authorization, ip)).toEqual({ retryAfterSeconds: 0 });
    await service.send(authorization, ip);
    const initial = await secondService.status(authorization, ip);
    expect(initial.retryAfterSeconds).toBeGreaterThan(0);
    expect(initial.retryAfterSeconds).toBeLessThanOrEqual(60);
    await redis.pexpire(cooldownKey(), 1200);
    expect(await service.status(authorization, ip)).toEqual({ retryAfterSeconds: 2 });
    user.email = "changed-email@example.test";
    expect(await secondService.status(authorization, ip)).toEqual({ retryAfterSeconds: 2 });
    await redis.del(cooldownKey());
    expect(await service.status(authorization, ip)).toEqual({ retryAfterSeconds: 0 });
  });

  it("refuses challenges and sends during cooldown before consuming CAP work", async () => {
    await service.send(authorization, ip);
    security.verifyProof.mockClear();
    await expect(service.challenge(authorization, ip)).rejects.toMatchObject({ status: 429 });
    await expect(service.send(authorization, ip)).rejects.toMatchObject({
      status: 429,
      response: { details: { retryAfterSeconds: expect.any(Number) } },
    });
    expect(security.challenge).not.toHaveBeenCalled();
    expect(security.verifyProof).not.toHaveBeenCalled();
    expect(mailer.sendEmailVerification).toHaveBeenCalledTimes(1);
  });

  it("keeps send reservations atomic across concurrent API instances", async () => {
    const results = await Promise.allSettled(
      services.map((instance) => instance.send(authorization, ip)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { status: 429 },
    });
    expect(mailer.sendEmailVerification).toHaveBeenCalledTimes(1);
    expect(await redis.get(key(`user-quarter:${userHash}`))).toBe("1");
  });

  it("retains cooldown and reports it when SMTP delivery fails", async () => {
    mailer.sendEmailVerification.mockRejectedValueOnce(new Error("test-only SMTP failure"));
    await expect(service.send(authorization, ip)).rejects.toMatchObject({
      status: 503,
      response: {
        code: "ADMIN_EMAIL_DELIVERY_FAILED",
        details: { retryAfterSeconds: expect.any(Number) },
      },
    });
    expect((await secondService.status(authorization, ip)).retryAfterSeconds).toBeGreaterThan(0);
    expect(prisma.adminUser.updateMany).toHaveBeenLastCalledWith({
      where: { id: user.id, emailVerificationTokenHash: expect.any(String) },
      data: { emailVerificationTokenHash: null, emailVerificationExpiresAt: null },
    });
  });

  it("keeps successful delivery successful if Redis becomes unavailable afterwards", async () => {
    mailer.sendEmailVerification.mockImplementationOnce(async () => {
      vi.spyOn(Redis.prototype, "eval").mockRejectedValue(new Error("test-only Redis outage"));
    });
    await expect(service.send(authorization, ip)).resolves.toEqual({
      sent: true,
      retryAfterSeconds: 60,
      expiresInSeconds: 1800,
    });
    expect(mailer.sendEmailVerification).toHaveBeenCalledTimes(1);
    await expect(service.status(authorization, ip)).rejects.toMatchObject({ status: 503 });
    await expect(service.send(authorization, ip)).rejects.toMatchObject({ status: 503 });
    expect(mailer.sendEmailVerification).toHaveBeenCalledTimes(1);
  });

  it("preserves the SMTP failure when Redis becomes unavailable during delivery", async () => {
    mailer.sendEmailVerification.mockImplementationOnce(async () => {
      vi.spyOn(Redis.prototype, "eval").mockRejectedValue(new Error("test-only Redis outage"));
      throw new Error("test-only SMTP failure");
    });
    await expect(service.send(authorization, ip)).rejects.toMatchObject({
      status: 503,
      response: {
        code: "ADMIN_EMAIL_DELIVERY_FAILED",
        details: { retryAfterSeconds: 60 },
      },
    });
    expect(mailer.sendEmailVerification).toHaveBeenCalledTimes(1);
  });

  it("returns the longest exhausted budget after the short cooldown expires", async () => {
    await redis.set(key(`user-quarter:${userHash}`), "3", "PX", 1500);
    await redis.set(key(`user-day:${userHash}`), "10", "PX", 5500);
    expect(await service.status(authorization, ip)).toEqual({ retryAfterSeconds: 6 });
    await expect(service.challenge(authorization, ip)).rejects.toMatchObject({
      response: { details: { retryAfterSeconds: 6 } },
    });
  });

  it("permits status requests before name and email are saved", async () => {
    user.email = null;
    user.name = null;
    expect(await service.status(authorization, ip)).toEqual({ retryAfterSeconds: 0 });
  });

  it("fails closed when Redis is unavailable", async () => {
    vi.spyOn(Redis.prototype, "eval").mockRejectedValue(new Error("test-only Redis outage"));
    await expect(service.status(authorization, ip)).rejects.toMatchObject({ status: 503 });
    await expect(service.challenge(authorization, ip)).rejects.toMatchObject({ status: 503 });
    await expect(service.send(authorization, ip)).rejects.toMatchObject({ status: 503 });
    expect(security.challenge).not.toHaveBeenCalled();
    expect(security.verifyProof).not.toHaveBeenCalled();
    expect(mailer.sendEmailVerification).not.toHaveBeenCalled();
  });
});
