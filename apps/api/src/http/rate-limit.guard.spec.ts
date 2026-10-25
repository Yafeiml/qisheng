import { describe, expect, it } from "vitest";
import { rateLimitPolicies } from "./rate-limit.guard";

describe("rate limit policy classification", () => {
  it.each([
    "/auth/admin/account/email/challenge",
    "/auth/admin/account/email/send",
    "/auth/admin/email/confirm",
  ])("limits email verification work by trusted IP: %s", (path) => {
    const policies = rateLimitPolicies({
      headers: { "x-forwarded-for": "spoofed" },
      ip: "192.0.2.3",
      method: "POST",
      originalUrl: path,
    });
    expect(policies).toContainEqual({
      name: path.endsWith("confirm") ? "admin-email-confirm-ip" : "admin-email-request-ip",
      subject: "192.0.2.3",
      limit: path.endsWith("confirm") ? 30 : 20,
      windowMs: 600000,
    });
  });
  it("limits captcha work by trusted request IP rather than a spoofable forwarded header", () => {
    const policies = rateLimitPolicies({
      headers: { "x-forwarded-for": "spoofed" },
      ip: "192.0.2.3",
      method: "POST",
      originalUrl: "/auth/captcha/challenge",
    });
    expect(policies).toContainEqual({
      name: "sms-challenge-ip",
      subject: "192.0.2.3",
      limit: 20,
      windowMs: 600000,
    });
  });
  it("uses independent source and subject limits for formal authentication", () => {
    expect(
      rateLimitPolicies({
        body: { phone: "13800000000" },
        headers: {},
        ip: "127.0.0.1",
        method: "POST",
        originalUrl: "/auth/admin/login",
      }).map(({ name }) => name),
    ).toEqual(["global-ip", "auth-ip", "auth-subject"]);
  });

  it.each(["/auth/admin/register", "/auth/admin/password-login", "/auth/admin/installation"])(
    "limits password work by IP and normalized account: %s",
    (path) => {
      const policies = rateLimitPolicies({
        body: { username: " Owner " },
        headers: {},
        ip: "192.0.2.5",
        method: "POST",
        originalUrl: path,
      });
      expect(policies.map(({ name }) => name)).toEqual(["global-ip", "auth-ip", "auth-subject"]);
      expect(policies[2]?.subject).toBe("owner");
    },
  );

  it("keeps development adapters out of formal login buckets", () => {
    expect(
      rateLimitPolicies({
        body: { phone: "13800000000" },
        headers: {},
        ip: "127.0.0.1",
        method: "POST",
        originalUrl: "/auth/dev/admin-token",
      }).map(({ name }) => name),
    ).toEqual(["global-ip", "development-auth-ip"]);
  });

  it.each([
    ["GET", "/auth/admin/session"],
    ["POST", "/auth/admin/refresh"],
    ["POST", "/auth/admin/logout"],
    ["POST", "/auth/admin/logout-all"],
  ])("keeps established session operations out of credential attack buckets", (method, path) => {
    expect(
      rateLimitPolicies({
        headers: {},
        ip: "127.0.0.1",
        method,
        originalUrl: path,
      }).map(({ name }) => name),
    ).toEqual(["global-ip"]);
  });

  it.each([
    "/auth/admin/request-code",
    "/auth/admin/login",
    "/auth/employee/request-code",
    "/auth/employee/bind",
    "/auth/employee/candidates",
    "/auth/employee/debug/request-code",
    "/auth/employee/debug/candidates",
    "/auth/employee/debug/bind",
  ])("protects credential endpoint %s by source and phone", (path) => {
    expect(
      rateLimitPolicies({
        body: { phone: "13800000000" },
        headers: {},
        ip: "127.0.0.1",
        method: "POST",
        originalUrl: path,
      }).map(({ name }) => name),
    ).toEqual(["global-ip", "auth-ip", "auth-subject"]);
  });

  it("limits SMS tests independently by IP and destination phone", () => {
    const policies = rateLimitPolicies({
      headers: {},
      method: "POST",
      originalUrl: "/platform/settings/admin-sms/test",
      ip: "127.0.0.1",
      body: { phone: "13800138000" },
    });
    expect(policies).toContainEqual({
      name: "admin-sms-test-phone",
      subject: "13800138000",
      limit: 1,
      windowMs: 60000,
    });
    expect(policies).toContainEqual({
      name: "admin-sms-test-ip",
      subject: "127.0.0.1",
      limit: 5,
      windowMs: 60000,
    });
  });

  it("does not make liveness dependent on the limiter", () => {
    expect(
      rateLimitPolicies({
        headers: {},
        method: "GET",
        originalUrl: "/health/live",
      }),
    ).toEqual([]);
  });
});
