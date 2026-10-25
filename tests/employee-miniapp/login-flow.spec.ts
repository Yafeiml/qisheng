import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BindCandidate,
  EmployeeMembership,
  EmployeeSession,
} from "../../apps/employee-miniapp/types";

const mocks = vi.hoisted(() => ({
  ApiError: class extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
    ) {
      super(message);
    }
  },
  request: vi.fn(),
  loadSession: vi.fn(),
  saveSession: vi.fn(),
  saveEnterpriseFilter: vi.fn(),
  saveFlashNotice: vi.fn(),
  solveSmsChallenge: vi.fn(),
}));

vi.mock("../../apps/employee-miniapp/utils/api", () => ({
  ApiError: mocks.ApiError,
  apiRequest: mocks.request,
  getApiBaseUrl: () => "https://example.invalid/api",
  messageOf: (error: Error) => error.message,
}));
vi.mock("../../apps/employee-miniapp/utils/session", () => ({
  loadSession: mocks.loadSession,
  saveSession: mocks.saveSession,
  saveEnterpriseFilter: mocks.saveEnterpriseFilter,
  saveFlashNotice: mocks.saveFlashNotice,
}));
vi.mock("../../apps/employee-miniapp/utils/generated/captcha", () => ({
  retrySeconds: () => 0,
  solveSmsChallenge: mocks.solveSmsChallenge,
}));

type LoginPage = {
  data: {
    authMode: string;
    busy: boolean;
    candidates: (BindCandidate & { selected: boolean })[];
    code: string;
    debugUnavailable: boolean;
    developmentCode: string;
    error: string;
    joinMode: boolean;
    phone: string;
    notice: string;
    retryRemaining: number;
    selectedCount: number;
    stage: string;
  };
  setData(data: object): void;
  loadCandidates(): Promise<void>;
  bindSelected(): Promise<void>;
  completeAuthentication(ids: string[], joining: boolean): Promise<void>;
  onPhoneInput(event: { detail: { value: string } }): void;
  onCodeInput(event: { detail: { value: string } }): void;
  requestCode(): Promise<void>;
  useFormalSms(): void;
  backToPhone(): void;
};

const bound = candidate("enterprise-bound", true);
const pending = candidate("enterprise-pending", false);
const relaunch = vi.fn();
const navigateBack = vi.fn();
const showToast = vi.fn();
const reviewCodeResponse = {
  delivery: "TEMPORARY_DEBUG",
  developmentCode: "000000",
  expiresInSeconds: 300,
  phoneMasked: "138****8000",
  retryAfterSeconds: 60,
};
const smsCodeResponse = {
  delivery: "ALIYUN_SMS",
  expiresInSeconds: 300,
  phoneMasked: "136****3063",
  retryAfterSeconds: 60,
};
const captchaProof = { token: "review-proof", solutions: [1] };
let pageDefinition: LoginPage;

beforeAll(async () => {
  vi.stubGlobal("Page", (definition: LoginPage) => {
    pageDefinition = definition;
  });
  vi.stubGlobal("wx", {
    reLaunch: relaunch,
    navigateBack,
    showToast,
    getStorageSync: () => 0,
    setStorageSync: vi.fn(),
  });
  await import("../../apps/employee-miniapp/pages/login/login");
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadSession.mockReturnValue(null);
  mocks.solveSmsChallenge.mockResolvedValue(captchaProof);
});

describe("employee login after phone verification", () => {
  it("defaults to formal SMS verification", () => {
    expect(pageDefinition.data.authMode).toBe("SMS");
  });

  it("requests and verifies the review phone through the server-controlled temporary lane", async () => {
    mocks.request.mockImplementation((path: string) => {
      if (path === "/auth/captcha/challenge") return { required: true };
      if (path === "/auth/employee/debug/request-code") return reviewCodeResponse;
      if (path === "/auth/employee/debug/candidates") {
        return { candidates: [bound], phoneMasked: "138****8000" };
      }
      if (path === "/auth/employee/debug/bind") {
        return { accessToken: "review-token", memberships: [membership(bound)] };
      }
      throw new Error(`Unexpected review request: ${path}`);
    });
    const page = makePage();
    page.data.phone = "13800138000";
    await page.requestCode();
    expect(page.data.authMode).toBe("TEMPORARY_DEBUG");
    expect(page.data.code).toBe("000000");
    expect(page.data.developmentCode).toBe("000000");
    expect(mocks.solveSmsChallenge).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledWith(
      "/auth/employee/debug/request-code",
      expect.objectContaining({ body: { phone: "13800138000", captcha: captchaProof } }),
    );
    await page.loadCandidates();
    expect(mocks.request).toHaveBeenCalledWith(
      "/auth/employee/debug/bind",
      expect.objectContaining({
        body: { code: "000000", phone: "13800138000", enterpriseIds: [bound.enterpriseId] },
      }),
    );
    expect(mocks.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "review-token", phone: "13800138000" }),
    );
  });

  it("uses SMS for every other phone even after a temporary login mode", async () => {
    mocks.request.mockImplementation((path: string) =>
      path === "/auth/captcha/challenge" ? { required: true } : smsCodeResponse,
    );
    const page = makePage();
    page.data.authMode = "TEMPORARY_DEBUG";
    page.data.developmentCode = "000000";
    await page.requestCode();
    expect(page.data.authMode).toBe("SMS");
    expect(page.data.code).toBe("");
    expect(page.data.developmentCode).toBe("");
    expect(mocks.request).toHaveBeenCalledWith(
      "/auth/employee/request-code",
      expect.objectContaining({ body: { phone: "13800000099", captcha: captchaProof } }),
    );
  });

  it("reports a disabled review lane without inventing a code or sending SMS", async () => {
    mocks.request.mockImplementation((path: string) => {
      if (path === "/auth/captcha/challenge") return { required: true };
      throw new mocks.ApiError("临时验证码接口未启用。", 404);
    });
    const page = makePage();
    page.data.phone = "13800138000";
    page.data.stage = "PHONE";
    page.data.developmentCode = "000000";
    await page.requestCode();
    expect(page.data.stage).toBe("PHONE");
    expect(page.data.code).toBe("");
    expect(page.data.developmentCode).toBe("");
    expect(page.data.debugUnavailable).toBe(true);
    expect(page.data.error).toContain("尚未在正式服务启用");
    expect(mocks.request.mock.calls.map(([path]) => path)).toEqual([
      "/auth/captcha/challenge",
      "/auth/employee/debug/request-code",
    ]);
  });

  it("honors an explicit SMS fallback for the review phone", async () => {
    mocks.request.mockImplementation((path: string) =>
      path === "/auth/captcha/challenge" ? { required: true } : smsCodeResponse,
    );
    const page = makePage();
    page.data.phone = "13800138000";
    page.useFormalSms();
    await page.requestCode();
    expect(page.data.authMode).toBe("SMS");
    expect(mocks.request).toHaveBeenCalledWith(
      "/auth/employee/request-code",
      expect.objectContaining({ body: { phone: "13800138000", captcha: captchaProof } }),
    );
    expect(page.data.developmentCode).toBe("");
  });

  it("clears review state when changing phone and selects the lane again for a later review login", async () => {
    const page = makePage();
    page.data.phone = "13800138000";
    page.data.authMode = "TEMPORARY_DEBUG";
    page.data.code = "000000";
    page.data.developmentCode = "000000";
    page.data.debugUnavailable = true;
    page.data.notice = "限时调试验证码已生成，不会发送短信。";
    page.onPhoneInput({ detail: { value: "13800000099" } });
    expect(page.data.authMode).toBe("SMS");
    expect(page.data.code).toBe("");
    expect(page.data.developmentCode).toBe("");
    expect(page.data.debugUnavailable).toBe(false);
    expect(page.data.notice).toBe("");
    page.onPhoneInput({ detail: { value: "13800138000" } });
    page.useFormalSms();
    page.onPhoneInput({ detail: { value: "13800000099" } });
    page.onPhoneInput({ detail: { value: "13800138000" } });
    mocks.request.mockImplementation((path: string) =>
      path === "/auth/captcha/challenge" ? { required: true } : reviewCodeResponse,
    );
    await page.requestCode();
    expect(page.data.authMode).toBe("TEMPORARY_DEBUG");
    expect(page.data.developmentCode).toBe("000000");
  });

  it("clears the temporary code when returning to the phone step", () => {
    const page = makePage();
    page.data.developmentCode = "000000";
    page.data.debugUnavailable = true;
    page.backToPhone();
    expect(page.data.developmentCode).toBe("");
    expect(page.data.debugUnavailable).toBe(false);
  });

  it("signs in already-bound employees without asking them to bind again", async () => {
    mocks.request.mockImplementation((path: string) =>
      path.endsWith("candidates")
        ? { candidates: [bound], phoneMasked: "136****3063" }
        : { accessToken: "new-token", memberships: [membership(bound)] },
    );
    const page = makePage();
    await page.loadCandidates();
    expect(page.data.stage).toBe("CODE");
    expect(mocks.request).toHaveBeenCalledWith(
      "/auth/employee/bind",
      expect.objectContaining({
        body: { code: "123456", phone: "13800000099", enterpriseIds: [bound.enterpriseId] },
      }),
    );
    expect(mocks.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "new-token", memberships: [membership(bound)] }),
    );
    expect(mocks.saveFlashNotice).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalledWith({ url: "/pages/tasks/tasks" });
  });

  it("logs into existing enterprises without silently joining newly offered ones", async () => {
    mocks.request.mockImplementation((path: string) =>
      path.endsWith("candidates")
        ? { candidates: [bound, pending], phoneMasked: "136****3063" }
        : { accessToken: "new-token", memberships: [membership(bound)] },
    );
    await makePage().loadCandidates();
    expect(mocks.request.mock.calls.at(-1)?.[1].body.enterpriseIds).toEqual([bound.enterpriseId]);
  });

  it("offers selection only when joining for the first time", async () => {
    mocks.request.mockImplementation((path: string) =>
      path.endsWith("candidates")
        ? { candidates: [pending], phoneMasked: "136****3063" }
        : { accessToken: "new-token", memberships: [membership(pending)] },
    );
    const page = makePage();
    await page.loadCandidates();
    expect(page.data.stage).toBe("SELECT");
    expect(page.data.selectedCount).toBe(1);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await page.bindSelected();
    expect(mocks.saveFlashNotice).toHaveBeenCalledWith("已加入：企业 enterprise-pending");
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("shows only new enterprises when an existing employee chooses to join more", async () => {
    const existing: EmployeeSession = {
      accessToken: "old-token",
      memberships: [membership(bound)],
      phone: "13800000099",
    };
    mocks.loadSession.mockReturnValue(existing);
    mocks.request.mockImplementation((path: string) =>
      path.endsWith("candidates")
        ? { candidates: [bound, pending], phoneMasked: "136****3063" }
        : { accessToken: "new-token", memberships: [membership(pending)] },
    );
    const page = makePage(true);
    await page.loadCandidates();
    expect(page.data.candidates.map(({ enterpriseId }) => enterpriseId)).toEqual([
      pending.enterpriseId,
    ]);
    await page.bindSelected();
    expect(mocks.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ memberships: [membership(bound), membership(pending)] }),
    );
    expect(mocks.saveEnterpriseFilter).not.toHaveBeenCalled();
  });

  it("returns to tasks when joining has no unbound enterprises", async () => {
    mocks.loadSession.mockReturnValue({
      accessToken: "old-token",
      memberships: [membership(bound)],
      phone: "13800000099",
    });
    mocks.request.mockResolvedValue({ candidates: [bound], phoneMasked: "136****3063" });
    await makePage(true).loadCandidates();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(navigateBack).toHaveBeenCalledWith({ delta: 1 });
    expect(mocks.saveFlashNotice).toHaveBeenCalledWith("已加入全部可用企业，无需再次绑定。");
  });

  it("does not retain the previous phone's enterprises after binding another phone", async () => {
    mocks.loadSession.mockReturnValue({
      accessToken: "old-token",
      memberships: [membership(bound)],
      phone: "13800000001",
    });
    mocks.request.mockResolvedValue({
      accessToken: "new-phone-token",
      memberships: [membership(pending)],
    });
    await makePage(true).completeAuthentication([pending.enterpriseId], true);
    expect(mocks.saveSession).toHaveBeenCalledWith({
      accessToken: "new-phone-token",
      memberships: [membership(pending)],
      phone: "13800000099",
    });
    expect(mocks.saveEnterpriseFilter).toHaveBeenCalledWith("ALL");
  });

  it("authenticates a different already-bound phone instead of returning to the previous account", async () => {
    mocks.loadSession.mockReturnValue({
      accessToken: "old-token",
      memberships: [membership(bound)],
      phone: "13800000001",
    });
    mocks.request.mockImplementation((path: string) =>
      path.endsWith("candidates")
        ? { candidates: [bound], phoneMasked: "136****3063" }
        : { accessToken: "new-phone-token", memberships: [membership(bound)] },
    );
    await makePage(true).loadCandidates();
    expect(mocks.request).toHaveBeenCalledWith(
      "/auth/employee/bind",
      expect.objectContaining({
        body: { code: "123456", phone: "13800000099", enterpriseIds: [bound.enterpriseId] },
      }),
    );
    expect(navigateBack).not.toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalledWith({ url: "/pages/tasks/tasks" });
    expect(mocks.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "new-phone-token", phone: "13800000099" }),
    );
  });

  it("keeps the independent temporary verification lane available for development", async () => {
    mocks.request.mockResolvedValue({
      accessToken: "debug-token",
      memberships: [membership(bound)],
    });
    const page = makePage();
    page.data.authMode = "TEMPORARY_DEBUG";
    page.data.code = "000000";
    await page.completeAuthentication([bound.enterpriseId], false);
    expect(mocks.request).toHaveBeenCalledWith(
      "/auth/employee/debug/bind",
      expect.objectContaining({ body: expect.objectContaining({ code: "000000" }) }),
    );
  });

  it("does not change credentials while verification is in progress", () => {
    const page = makePage();
    page.data.busy = true;
    page.onPhoneInput({ detail: { value: "13800000001" } });
    page.onCodeInput({ detail: { value: "654321" } });
    expect(page.data.phone).toBe("13800000099");
    expect(page.data.code).toBe("123456");
  });
});

function makePage(joinMode = false): LoginPage {
  return {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      candidates: [],
      code: "123456",
      joinMode,
      phone: "13800000099",
      selectedCount: 0,
      stage: "CODE",
    },
    setData(data: object) {
      Object.assign(this.data, data);
    },
  };
}

function candidate(enterpriseId: string, alreadyBound: boolean): BindCandidate {
  return {
    alreadyBound,
    departmentName: "信息科",
    employeeName: "王亚飞",
    enterpriseId,
    enterpriseName: `企业 ${enterpriseId}`,
    membershipId: `member-${enterpriseId}`,
    tenantId: "tenant-1",
    tenantName: "集团",
  };
}

function membership({
  enterpriseId,
  enterpriseName,
  membershipId,
  tenantId,
}: BindCandidate): EmployeeMembership {
  return { enterpriseId, enterpriseName, membershipId, tenantId };
}
