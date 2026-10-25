import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { closeRedisClient, createLazyRedisClient } from "../redis/redis-client";
import { SmsPurpose } from "./sms-security.dto";
import { SmsSecurityService } from "./sms-security.service";

describe("SMS captcha and atomic budgets", { concurrent: false }, () => {
  const redis = createLazyRedisClient("sms-security-tests");
  const settings = { resolveMany: vi.fn(), boolean: vi.fn() };
  const reader = settings as unknown as PlatformSettingsReader;
  const service = new SmsSecurityService(reader);
  const basePrefix = process.env.REDIS_PREFIX;
  const phone = "13900009223";
  const ip = "192.0.2.50";
  let prefix: string;
  const cap = vi.fn();

  beforeEach(() => {
    settings.boolean.mockReset().mockResolvedValue(true);
    prefix = `${basePrefix}:sms-security:${randomUUID()}`;
    vi.stubEnv("REDIS_PREFIX", prefix);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_DEV_AUTH", "true");
    vi.stubEnv("SMS_CAP_ENDPOINT", "http://127.0.0.1:3022/test-site/");
    vi.stubEnv("SMS_CAP_SECRET", "test-only-cap-secret");
    settings.resolveMany.mockReset().mockImplementation(
      async () =>
        new Map([
          ["security.cap_endpoint", { value: process.env.SMS_CAP_ENDPOINT }],
          ["security.cap_secret", { value: process.env.SMS_CAP_SECRET }],
        ]),
    );
    cap
      .mockReset()
      .mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith("challenge")
                ? { token: randomUUID(), challenge: { c: 1, s: 16, d: 1 } }
                : url.endsWith("redeem")
                  ? { success: true, token: "test-site:redeemed:secret" }
                  : { success: true },
            ),
            { status: 200 },
          ),
      );
    vi.stubGlobal("fetch", cap);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await service.onApplicationShutdown();
    await closeRedisClient(redis);
  });
  async function proof(target = phone, purpose = SmsPurpose.ADMIN_LOGIN, source = ip) {
    const result = await service.challenge({ phone: target, purpose }, source);
    if (!result.token) throw new Error("Missing test challenge");
    return { token: result.token, solutions: [42] };
  }
  async function removeCooldown(target = phone) {
    await redis.del(
      `${prefix}:identity:sms-security:cooldown:${createHash("sha256").update(target).digest("hex")}`,
    );
  }

  it("does not require or contact Cap when the optional verification is disabled", async () => {
    settings.boolean.mockResolvedValue(false);
    await expect(
      service.passwordChallenge("owner", SmsPurpose.PASSWORD_LOGIN, ip),
    ).resolves.toEqual({ required: false });
    await expect(
      service.verifyProof("owner", SmsPurpose.PASSWORD_LOGIN, ip),
    ).resolves.toBeUndefined();
    expect(cap).not.toHaveBeenCalled();
    expect(settings.resolveMany).not.toHaveBeenCalled();
  });

  it("binds password proofs to the normalized account and purpose", async () => {
    const challenge = await service.passwordChallenge(" Owner ", SmsPurpose.PASSWORD_LOGIN, ip);
    if (!challenge.token) throw new Error("Missing challenge token");
    await expect(
      service.verifyProof("owner", SmsPurpose.PASSWORD_REGISTER, ip, {
        token: challenge.token,
        solutions: [42],
      }),
    ).rejects.toMatchObject({ status: 403 });
    const next = await service.passwordChallenge("owner", SmsPurpose.PASSWORD_LOGIN, ip);
    if (!next.token) throw new Error("Missing challenge token");
    await service.verifyProof("owner", SmsPurpose.PASSWORD_LOGIN, ip, {
      token: next.token,
      solutions: [42],
    });
  });

  it("requires a proof in production even when development auth was accidentally enabled", async () => {
    await expect(
      service.authorize(phone, SmsPurpose.ADMIN_LOGIN, ip, undefined, true),
    ).rejects.toThrow("安全验证已失效");
    expect(cap).not.toHaveBeenCalled();
  });

  it("binds email proofs to the saved address, account, purpose and trusted IP", async () => {
    const subject = "admin-email:user-1:owner@example.test";
    const challenge = await service.challenge(
      { phone: subject, purpose: "ADMIN_EMAIL_VERIFY" },
      ip,
    );
    if (!challenge.token) throw new Error("Missing challenge token");
    const emailProof = { token: challenge.token, solutions: [42] };
    await expect(
      service.verifyProof(`${subject}.changed`, "ADMIN_EMAIL_VERIFY", ip, emailProof),
    ).rejects.toThrow("安全验证已失效");
    const next = await service.challenge({ phone: subject, purpose: "ADMIN_EMAIL_VERIFY" }, ip);
    if (!next.token) throw new Error("Missing challenge token");
    const valid = { token: next.token, solutions: [42] };
    await service.verifyProof(subject, "ADMIN_EMAIL_VERIFY", ip, valid);
    await expect(service.verifyProof(subject, "ADMIN_EMAIL_VERIFY", ip, valid)).rejects.toThrow(
      "安全验证已失效",
    );
    await expect(service.verifyProof(subject, "ADMIN_EMAIL_VERIFY", ip)).rejects.toThrow(
      "安全验证已失效",
    );
  });
  it.each(["phone", "purpose", "ip"])("binds a challenge to its %s", async (changed) => {
    const captcha = await proof();
    await expect(
      service.authorize(
        changed === "phone" ? "13900009224" : phone,
        changed === "purpose" ? SmsPurpose.EMPLOYEE_BIND : SmsPurpose.ADMIN_LOGIN,
        changed === "ip" ? "192.0.2.51" : ip,
        captcha,
      ),
    ).rejects.toThrow("安全验证已失效");
    expect(cap).toHaveBeenCalledTimes(1);
  });
  it("consumes a proof once, and blocks cross-purpose resends for 60 seconds", async () => {
    const captcha = await proof();
    await service.authorize(phone, SmsPurpose.ADMIN_LOGIN, ip, captcha);
    expect(cap.mock.calls.map(([url]) => new URL(url).pathname.split("/").pop())).toEqual([
      "challenge",
      "redeem",
      "siteverify",
    ]);
    await expect(
      service.authorize(phone, SmsPurpose.EMPLOYEE_BIND, ip, captcha),
    ).rejects.toMatchObject({ status: 429, response: { details: { retryAfterSeconds: 60 } } });
    await removeCooldown();
    await expect(service.authorize(phone, SmsPurpose.ADMIN_LOGIN, ip, captcha)).rejects.toThrow(
      "安全验证已失效",
    );
  });
  it("allows only one concurrent reservation across independent API instances", async () => {
    const second = new SmsSecurityService(reader);
    try {
      const proofs = await Promise.all([proof(), proof()]);
      const results = await Promise.allSettled([
        service.authorize(phone, SmsPurpose.ADMIN_LOGIN, ip, proofs[0]),
        second.authorize(phone, SmsPurpose.ADMIN_LOGIN, ip, proofs[1]),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    } finally {
      await second.onApplicationShutdown();
    }
  });
  it("keeps cumulative phone budgets across failed sends and refuses stale cooldown releases", async () => {
    let old = "";
    for (let i = 0; i < 3; i++) {
      const lease = await service.authorize(phone, SmsPurpose.ADMIN_LOGIN, ip, await proof());
      await service.releaseFailedSend(phone, old);
      await expect(
        service.challenge({ phone, purpose: SmsPurpose.ADMIN_LOGIN }, ip),
      ).rejects.toMatchObject({ status: 429 });
      await service.releaseFailedSend(phone, lease);
      old = lease;
    }
    await expect(
      service.authorize(
        phone,
        SmsPurpose.EMPLOYEE_BIND,
        ip,
        await proof(phone, SmsPurpose.EMPLOYEE_BIND),
      ),
    ).rejects.toMatchObject({ status: 429, response: { details: { policy: "sms-budget" } } });
  });
  it("limits an IP that rotates destination phones", async () => {
    for (let i = 0; i < 20; i++) {
      const target = `1390001${String(i).padStart(4, "0")}`;
      await service.authorize(target, SmsPurpose.ADMIN_LOGIN, ip, await proof(target));
    }
    await expect(
      service.authorize(phone, SmsPurpose.ADMIN_LOGIN, ip, await proof()),
    ).rejects.toMatchObject({ status: 429 });
  });
  it("fails closed when Cap rejects a proof or is unavailable", async () => {
    const captcha = await proof();
    cap.mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 403 }));
    await expect(
      service.authorize(phone, SmsPurpose.ADMIN_LOGIN, ip, captcha),
    ).rejects.toMatchObject({ status: 403 });
    cap.mockRejectedValueOnce(new Error("test timeout"));
    await expect(
      service.challenge({ phone, purpose: SmsPurpose.ADMIN_LOGIN }, ip),
    ).rejects.toMatchObject({ status: 503 });
    cap.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: "unsupported", challenge: { c: 500, s: 32, d: 8 } })),
    );
    await expect(
      service.challenge({ phone, purpose: SmsPurpose.ADMIN_LOGIN }, ip),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("requires both Cap redemption and secret-bearing siteverify to succeed", async () => {
    const captcha = await proof();
    cap.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, token: "test:redeemed:token" })),
    );
    cap.mockResolvedValueOnce(new Response(JSON.stringify({ success: false })));
    await expect(
      service.authorize(phone, SmsPurpose.ADMIN_LOGIN, ip, captcha),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("does not return a development fallback when production configuration is missing", async () => {
    vi.stubEnv("SMS_CAP_SECRET", "");
    await expect(
      service.challenge({ phone, purpose: SmsPurpose.ADMIN_LOGIN }, ip),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("uses the saved Cap service for all requests without returning its secret", async () => {
    settings.resolveMany.mockResolvedValue(
      new Map([
        ["security.cap_endpoint", { value: "https://cap.example.com/saved-site" }],
        ["security.cap_secret", { value: "saved-cap-secret" }],
      ]),
    );
    const result = await service.challenge({ phone, purpose: SmsPurpose.ADMIN_LOGIN }, ip);
    expect(JSON.stringify(result)).not.toContain("saved-cap-secret");
    await service.authorize(phone, SmsPurpose.ADMIN_LOGIN, ip, {
      token: result.token as string,
      solutions: [42],
    });
    expect(cap.mock.calls.map(([url]) => url)).toEqual([
      "https://cap.example.com/saved-site/challenge",
      "https://cap.example.com/saved-site/redeem",
      "https://cap.example.com/saved-site/siteverify",
    ]);
    expect(JSON.parse(cap.mock.calls[2]?.[1].body)).toEqual({
      response: "test-site:redeemed:secret",
      secret: "saved-cap-secret",
    });
  });
  it("picks up settings changes on the next challenge without a restart", async () => {
    await proof();
    settings.resolveMany.mockResolvedValueOnce(
      new Map([
        ["security.cap_endpoint", { value: "https://cap.example.com/new-site/" }],
        ["security.cap_secret", { value: "new-cap-secret" }],
      ]),
    );
    await proof();
    expect(cap.mock.calls[1]?.[0]).toBe("https://cap.example.com/new-site/challenge");
  });
  it("fails closed before contacting Cap when reading settings fails", async () => {
    settings.resolveMany.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      service.challenge({ phone, purpose: SmsPurpose.ADMIN_LOGIN }, ip),
    ).rejects.toMatchObject({ status: 503 });
    expect(cap).not.toHaveBeenCalled();
  });
});
