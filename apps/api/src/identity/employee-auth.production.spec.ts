import "reflect-metadata";

import { randomUUID } from "node:crypto";
import { HttpException, ServiceUnavailableException } from "@nestjs/common";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { closeRedisClient, createLazyRedisClient } from "../redis/redis-client";
import type { AdminSmsConfiguration, AdminSmsService } from "./admin-sms.service";
import { EmployeeAuthenticationService } from "./employee-auth.service";
import type { EmployeeBindingService } from "./employee-binding.service";
import type { SmsSecurityService } from "./sms-security.service";

describe("employee production SMS authentication", { concurrent: false }, () => {
  const prefix = `${process.env.REDIS_PREFIX}:employee-auth:${randomUUID()}`;
  const redis = createLazyRedisClient("employee-auth-test");
  const phone = "13900009022";
  const key = `${prefix}:identity:employee-code:${phone}`;
  const debugKey = `${prefix}:identity:employee-debug-code:${phone}`;
  const configuration: AdminSmsConfiguration = {
    apiKey: "test-gateway-key",
    delivery: "HTTP_SMS_GATEWAY",
    endpoint: "https://sms.example.com/send",
    mode: "HTTP",
    provider: "TEST",
    sender: "TEST",
    templateId: "TEST",
    timeoutMs: 1000,
  };
  const sms = { current: vi.fn(), send: vi.fn() };
  const security = { authorize: vi.fn(), releaseFailedSend: vi.fn() };
  const binding = {
    bindVerifiedPhone: vi.fn(),
    listBindableMemberships: vi.fn(),
  };
  const debug = { enabled: false, phones: "", ips: "", until: "" };
  const settings = {
    resolveMany: vi.fn(
      async () =>
        new Map([
          ["miniapp.debug_code_enabled", { value: debug.enabled }],
          ["miniapp.debug_code_phones", { value: debug.phones }],
          ["miniapp.debug_code_ips", { value: debug.ips }],
          ["miniapp.debug_code_until", { value: debug.until }],
        ]),
    ),
  };
  const service = new EmployeeAuthenticationService(
    binding as unknown as EmployeeBindingService,
    sms as unknown as AdminSmsService,
    security as unknown as SmsSecurityService,
    settings as unknown as PlatformSettingsReader,
  );

  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Even a mistaken development-auth flag must never enable the fixed code in production.
    vi.stubEnv("ENABLE_DEV_AUTH", "true");
    Object.assign(debug, { enabled: false, phones: "", ips: "", until: "" });
    vi.stubEnv("REDIS_PREFIX", prefix);
    vi.clearAllMocks();
    security.authorize.mockReset().mockResolvedValue("test-reservation");
    security.releaseFailedSend.mockResolvedValue(undefined);
    sms.current.mockResolvedValue(configuration);
    sms.send.mockResolvedValue({ messageId: "test-message", provider: "TEST" });
    binding.listBindableMemberships.mockResolvedValue([{ enterpriseId: "test-enterprise" }]);
    binding.bindVerifiedPhone.mockResolvedValue({ audience: "xhs-employee-miniapp" });
    await redis.del(key, debugKey);
  });

  afterEach(async () => {
    await redis.del(key, debugKey);
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await service.onApplicationShutdown();
    await closeRedisClient(redis);
  });

  it("delivers a random six-digit code, stores only its digest and consumes it once", async () => {
    const result = await service.requestCode({ phone });
    expect(result).toMatchObject({ delivery: "HTTP_SMS_GATEWAY", expiresInSeconds: 300 });
    expect(result).not.toHaveProperty("developmentCode");
    const sent = sms.send.mock.calls[0]?.[1] as { code: string; purpose: string };
    expect(sent.code).toMatch(/^\d{6}$/u);
    expect(sent.purpose).toBe("EMPLOYEE_BIND");
    const stored = await redis.get(key);
    expect(stored).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored).not.toBe(sent.code);
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    expect(await redis.ttl(key)).toBeLessThanOrEqual(300);
    await expect(service.candidates({ phone, code: sent.code })).resolves.toHaveProperty(
      "candidates",
    );
    await expect(
      service.bind({ phone, code: sent.code, enterpriseIds: ["test-enterprise"] }),
    ).resolves.toMatchObject({ audience: "xhs-employee-miniapp" });
    await expect(service.bind({ phone, code: sent.code })).rejects.toThrow("验证码错误或已过期");
    expect(binding.bindVerifiedPhone).toHaveBeenCalledTimes(1);
  });

  it("refuses a development SMS provider in production without issuing a code", async () => {
    sms.current.mockResolvedValue({ mode: "DEVELOPMENT", delivery: "DEVELOPMENT_ADAPTER" });
    await expect(service.requestCode({ phone })).rejects.toThrow("需要配置正式短信通道");
    expect(sms.send).not.toHaveBeenCalled();
    expect(await redis.get(key)).toBeNull();
  });

  it("removes an undelivered code so a failed send can be retried", async () => {
    sms.send.mockRejectedValueOnce(new ServiceUnavailableException("test delivery failure"));
    await expect(service.requestCode({ phone })).rejects.toThrow("test delivery failure");
    expect(security.releaseFailedSend).toHaveBeenCalledWith(phone, "test-reservation");
    expect(await redis.get(key)).toBeNull();
    await expect(service.requestCode({ phone })).resolves.toHaveProperty(
      "delivery",
      "HTTP_SMS_GATEWAY",
    );
    expect(sms.send).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate sends and incorrect codes without consuming the valid code", async () => {
    await service.requestCode({ phone });
    security.authorize.mockRejectedValueOnce(new HttpException("验证码已发送", 429));
    await expect(service.requestCode({ phone })).rejects.toThrow("验证码已发送");
    expect(sms.send).toHaveBeenCalledTimes(1);
    const code = sms.send.mock.calls[0]?.[1].code as string;
    const wrongCode = code === "000000" ? "000001" : "000000";
    await expect(service.bind({ phone, code: wrongCode })).rejects.toThrow("验证码错误或已过期");
    expect(binding.bindVerifiedPhone).not.toHaveBeenCalled();
    await expect(service.bind({ phone, code })).resolves.toHaveProperty(
      "audience",
      "xhs-employee-miniapp",
    );
  });

  it("blocks SMS delivery when security verification fails", async () => {
    security.authorize.mockRejectedValueOnce(new HttpException("CAPTCHA_INVALID", 403));
    await expect(service.requestCode({ phone })).rejects.toThrow("CAPTCHA_INVALID");
    expect(sms.send).not.toHaveBeenCalled();
    expect(await redis.get(key)).toBeNull();
  });

  it("invalidates an employee code after five failed guesses across both verification endpoints", async () => {
    await service.requestCode({ phone });
    const code = sms.send.mock.calls[0]?.[1].code as string;
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) {
      await expect(
        i % 2 ? service.bind({ phone, code: wrong }) : service.candidates({ phone, code: wrong }),
      ).rejects.toThrow("验证码错误或已过期");
    }
    await expect(service.bind({ phone, code })).rejects.toThrow("验证码错误或已过期");
    expect(binding.bindVerifiedPhone).not.toHaveBeenCalled();
  });

  it("a resend replaces the previous code only after security authorizes it", async () => {
    await service.requestCode({ phone });
    await service.requestCode({ phone });
    const code = sms.send.mock.calls[1]?.[1].code as string;
    await expect(service.bind({ phone, code })).resolves.toHaveProperty("audience");
  });

  it("preserves explicit local development authentication without sending SMS", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(service.requestCode({ phone })).resolves.toMatchObject({
      delivery: "DEVELOPMENT_ADAPTER",
      developmentCode: "000000",
    });
    expect(sms.current).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
  });

  it("uses real SMS outside production when development authentication is disabled", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ENABLE_DEV_AUTH", "false");
    const result = await service.requestCode({ phone });
    expect(result.delivery).toBe("HTTP_SMS_GATEWAY");
    expect(result).not.toHaveProperty("developmentCode");
    expect(sms.send).toHaveBeenCalledTimes(1);
  });

  it("keeps the temporary code disabled without explicit phone and expiry configuration", async () => {
    vi.stubEnv("EMPLOYEE_DEBUG_CODE_ENABLED", "true");
    vi.stubEnv("EMPLOYEE_DEBUG_CODE_PHONES", phone);
    vi.stubEnv("EMPLOYEE_DEBUG_CODE_IPS", "*");
    vi.stubEnv("EMPLOYEE_DEBUG_CODE_UNTIL", "never");
    // Legacy environment values cannot bypass the database-backed platform switch.
    await expect(service.requestDebugCode({ phone })).rejects.toThrow("未启用");
    debug.enabled = true;
    debug.phones = "13900009023";
    debug.ips = "192.0.2.33";
    debug.until = new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/u, "Z");
    await expect(service.requestDebugCode({ phone })).rejects.toThrow("未启用");
    debug.phones = phone;
    await expect(service.requestDebugCode({ phone }, "192.0.2.34")).rejects.toThrow("未启用");
    debug.until = new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
    await expect(service.requestDebugCode({ phone })).rejects.toThrow("未启用");
    expect(security.authorize).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
  });

  it("issues only an eligible allowlisted employee a limited debug OTP without touching real SMS", async () => {
    debug.enabled = true;
    debug.phones = phone;
    debug.ips = "192.0.2.33";
    debug.until = new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/u, "Z");
    const captcha = { token: "checked", solutions: [1] };
    const result = await service.requestDebugCode({ phone, captcha }, "192.0.2.33");
    expect(result).toMatchObject({ delivery: "TEMPORARY_DEBUG", developmentCode: "000000" });
    expect(security.authorize).toHaveBeenCalledWith(phone, "EMPLOYEE_BIND", "192.0.2.33", captcha);
    expect(sms.current).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
    expect(await redis.get(key)).toBeNull();
    expect(await redis.get(debugKey)).toMatch(/^[0-9a-f]{64}$/u);
    expect(await redis.ttl(debugKey)).toBeGreaterThan(0);
    await expect(service.candidates({ phone, code: "000000" })).rejects.toThrow("验证码错误");
    await expect(
      service.debugCandidates({ phone, code: "000000" }, "192.0.2.33"),
    ).resolves.toHaveProperty("candidates");
    await expect(service.debugBind({ phone, code: "000000" }, "192.0.2.34")).rejects.toThrow(
      "未启用",
    );
    await expect(service.debugBind({ phone, code: "123456" }, "192.0.2.33")).rejects.toThrow(
      "验证码错误",
    );
    await expect(
      service.debugBind(
        { phone, code: "000000", enterpriseIds: ["test-enterprise"] },
        "192.0.2.33",
      ),
    ).resolves.toMatchObject({ audience: "xhs-employee-miniapp" });
    await expect(service.debugBind({ phone, code: "000000" }, "192.0.2.33")).rejects.toThrow(
      "验证码错误",
    );
    expect(binding.bindVerifiedPhone).toHaveBeenCalledTimes(1);
  });

  it("disables even an already issued debug code after the test window expires", async () => {
    debug.enabled = true;
    debug.phones = phone;
    debug.ips = "192.0.2.33";
    debug.until = new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/u, "Z");
    await service.requestDebugCode({ phone }, "192.0.2.33");
    debug.until = new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
    await expect(service.debugCandidates({ phone, code: "000000" }, "192.0.2.33")).rejects.toThrow(
      "未启用",
    );
    await expect(service.debugBind({ phone, code: "000000" }, "192.0.2.33")).rejects.toThrow(
      "未启用",
    );
    expect(binding.bindVerifiedPhone).not.toHaveBeenCalled();
  });

  it("accepts explicitly unrestricted debug settings while retaining proof, issuance TTL and single use", async () => {
    debug.enabled = true;
    debug.phones = phone;
    debug.ips = "*";
    debug.until = "never";
    const captcha = { token: "verified-proof", solutions: [1] };
    await expect(
      service.requestDebugCode({ phone, captcha }, "198.51.100.4"),
    ).resolves.toMatchObject({ delivery: "TEMPORARY_DEBUG", developmentCode: "000000" });
    expect(security.authorize).toHaveBeenCalledWith(
      phone,
      "EMPLOYEE_BIND",
      "198.51.100.4",
      captcha,
    );
    expect(await redis.ttl(debugKey)).toBeGreaterThan(0);
    expect(await redis.ttl(debugKey)).toBeLessThanOrEqual(300);
    await expect(
      service.debugCandidates({ phone, code: "000000" }, "203.0.113.21"),
    ).resolves.toHaveProperty("candidates");
    await expect(
      service.debugBind({ phone, code: "000000" }, "::ffff:192.0.2.6"),
    ).resolves.toHaveProperty("audience", "xhs-employee-miniapp");
    await expect(service.debugBind({ phone, code: "000000" }, "198.51.100.4")).rejects.toThrow(
      "验证码错误",
    );
    expect(sms.send).not.toHaveBeenCalled();
  });

  it("does not issue an unrestricted debug code when Cap validation fails", async () => {
    debug.enabled = true;
    debug.phones = phone;
    debug.ips = "*";
    debug.until = "never";
    security.authorize.mockRejectedValueOnce(new HttpException("CAPTCHA_INVALID", 403));
    await expect(service.requestDebugCode({ phone }, "203.0.113.21")).rejects.toThrow(
      "CAPTCHA_INVALID",
    );
    expect(await redis.get(debugKey)).toBeNull();
    expect(sms.send).not.toHaveBeenCalled();
  });
});
