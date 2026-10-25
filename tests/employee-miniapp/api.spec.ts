import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ clearSession: vi.fn(), loadSession: vi.fn() }));
vi.mock("../../apps/employee-miniapp/utils/session", () => mocks);

import { apiRequest } from "../../apps/employee-miniapp/utils/api";

const request = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("wx", { request });
  mocks.loadSession.mockReturnValue({ accessToken: "employee-token" });
  request.mockImplementation((options) => options.success({ statusCode: 200, data: { ok: true } }));
});

describe("miniapp API request headers", () => {
  it("keeps employee authorization when passing an idempotency key", async () => {
    await apiRequest("/employee/notifications/subscriptions", {
      body: {
        authorizationGeneration: 1,
        identityVersion: 1,
        status: "accept",
        templateId: "template-1",
      },
      idempotencyKey: "miniapp-subscription-event-1",
      method: "POST",
    });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      header: {
        Authorization: "Bearer employee-token",
        "Idempotency-Key": "miniapp-subscription-event-1",
      },
      method: "POST",
    });
  });

  it("does not add an idempotency header to ordinary read requests", async () => {
    await apiRequest("/employee/tasks");
    expect(request.mock.calls[0]?.[0].header).toEqual({ Authorization: "Bearer employee-token" });
  });

  it.each(["/auth/employee/request-code", "/auth/employee/candidates", "/auth/captcha/challenge"])(
    "does not send an existing employee token to the public %s route",
    async (path) => {
      await apiRequest(path, { method: "POST" });
      expect(request.mock.calls[0]?.[0].header).toEqual({});
    },
  );

  it("preserves an explicit token even for a public auth request", async () => {
    await apiRequest("/auth/employee/candidates", { token: "explicit-token" });
    expect(request.mock.calls[0]?.[0].header).toEqual({ Authorization: "Bearer explicit-token" });
  });

  it("preserves an explicitly anonymous request to a protected route", async () => {
    await apiRequest("/employee/tasks", { token: "" });
    expect(request.mock.calls[0]?.[0].header).toEqual({});
  });

  it("keeps a valid employee session when phone verification returns 401", async () => {
    request.mockImplementation((options) =>
      options.success({ statusCode: 401, data: { message: "验证码错误或已过期" } }),
    );
    await expect(apiRequest("/auth/employee/candidates", { method: "POST" })).rejects.toThrow(
      "验证码错误或已过期",
    );
    expect(mocks.clearSession).not.toHaveBeenCalled();
  });

  it("clears the rejected current session after a protected request returns 401", async () => {
    request.mockImplementation((options) =>
      options.success({ statusCode: 401, data: { message: "登录已过期" } }),
    );
    await expect(apiRequest("/employee/tasks")).rejects.toThrow("登录已过期");
    expect(mocks.clearSession).toHaveBeenCalledOnce();
  });

  it("keeps a new session when an earlier token's request returns 401", async () => {
    request.mockImplementation(() => undefined);
    const pending = apiRequest("/employee/tasks");
    mocks.loadSession.mockReturnValue({ accessToken: "new-employee-token" });
    request.mock.calls[0]?.[0].success({
      statusCode: 401,
      data: { message: "旧登录已过期" },
    });
    await expect(pending).rejects.toThrow("旧登录已过期");
    expect(mocks.clearSession).not.toHaveBeenCalled();
  });
});
