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
  config: { smsLoginEnabled: false },
}));

vi.mock("../../apps/employee-miniapp/config", () => ({ miniappConfig: mocks.config }));
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
    developmentCode: string;
    error: string;
    joinMode: boolean;
    phone: string;
    notice: string;
    retryRemaining: number;
    selectedCount: number;
    stage: string;
    username: string;
    password: string;
  };
  active: boolean;
  passwordAttempt: number;
  setData(data: object): void;
  loadCandidates(): Promise<void>;
  bindSelected(): Promise<void>;
  completeAuthentication(ids: string[], joining: boolean): Promise<void>;
  onPhoneInput(event: { detail: { value: string } }): void;
  onCodeInput(event: { detail: { value: string } }): void;
  requestCode(): Promise<void>;
  useSmsLogin(): void;
  usePasswordLogin(): void;
  loginPassword(): Promise<void>;
  onLoad(options: Record<string, string | undefined>): void;
  onHide(): void;
  onUsernameInput(event: { detail: { value: string } }): void;
  onPasswordInput(event: { detail: { value: string } }): void;
  backToPhone(): void;
};

const bound = candidate("enterprise-bound", true);
const pending = candidate("enterprise-pending", false);
const relaunch = vi.fn();
const navigateBack = vi.fn();
const showToast = vi.fn();
const redirectTo = vi.fn();
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
    redirectTo,
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
  mocks.config.smsLoginEnabled = true;
});

describe("employee account password login", () => {
  it("defaults to account login and leaves SMS opt-in", () => {
    expect(pageDefinition.data.authMode).toBe("PASSWORD");
    const page = makePage();
    mocks.config.smsLoginEnabled = false;
    page.onLoad({ mode: "join" });
    expect(page.data.authMode).toBe("PASSWORD");
    expect(page.data.joinMode).toBe(false);
    page.useSmsLogin();
    expect(page.data.authMode).toBe("PASSWORD");
  });

  it("exchanges a password session and persists only the employee token", async () => {
    mocks.request.mockImplementation((path: string) => {
      if (path === "/auth/captcha/password-challenge") return { required: true };
      if (path === "/auth/admin/password-login") return { accessToken: "short-admin-token" };
      if (path === "/auth/employee/web-session")
        return { accessToken: "employee-token", memberships: [membership(bound)] };
      throw new Error(`Unexpected password request: ${path}`);
    });
    const page = makePage();
    await page.loginPassword();
    expect(mocks.solveSmsChallenge).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledWith("/auth/captcha/password-challenge", {
      method: "POST",
      body: { username: "employee.demo", purpose: "PASSWORD_LOGIN" },
    });
    expect(mocks.request).toHaveBeenCalledWith("/auth/admin/password-login", {
      method: "POST",
      body: { username: "employee.demo", password: "Demo-password-123", captcha: captchaProof },
    });
    expect(mocks.request).toHaveBeenCalledWith("/auth/employee/web-session", {
      method: "POST",
      token: "short-admin-token",
    });
    expect(mocks.saveSession).toHaveBeenCalledWith({
      accessToken: "employee-token",
      memberships: [membership(bound)],
      phone: "",
      username: "employee.demo",
    });
    expect(mocks.saveSession).toHaveBeenCalledOnce();
    expect(mocks.saveEnterpriseFilter).toHaveBeenCalledWith("ALL");
    expect(page.data.password).toBe("");
    expect(page.data.busy).toBe(false);
    expect(relaunch).toHaveBeenCalledWith({ url: "/pages/tasks/tasks" });
  });

  it.each(["/auth/admin/password-login", "/auth/employee/web-session"])(
    "never stores the account token after %s fails",
    async (failurePath) => {
      mocks.request.mockImplementation((path: string) => {
        if (path === failurePath) throw new mocks.ApiError("账号或员工身份不可用", 401);
        return path === "/auth/captcha/password-challenge"
          ? { required: false }
          : { accessToken: "short-admin-token" };
      });
      const page = makePage();
      await page.loginPassword();
      expect(mocks.saveSession).not.toHaveBeenCalled();
      expect(relaunch).not.toHaveBeenCalled();
      expect(page.data.error).toBe("账号或员工身份不可用");
      expect(page.data.password).toBe("");
      expect(page.data.busy).toBe(false);
    },
  );

  it("uses account login without a proof when password captcha is disabled", async () => {
    mocks.solveSmsChallenge.mockResolvedValue(undefined);
    mocks.request.mockImplementation((path: string) => {
      if (path === "/auth/captcha/password-challenge") return { required: false };
      return path === "/auth/admin/password-login"
        ? { accessToken: "short-admin-token" }
        : { accessToken: "employee-token", memberships: [membership(bound)] };
    });
    const page = makePage();
    await page.loginPassword();
    expect(mocks.request).toHaveBeenCalledWith("/auth/admin/password-login", {
      method: "POST",
      body: { username: "employee.demo", password: "Demo-password-123" },
    });
    expect(mocks.saveSession).toHaveBeenCalledOnce();
  });

  it("does not log in after the password page was hidden and shown again", async () => {
    let finishLogin!: (value: { accessToken: string }) => void;
    const accountResponse = new Promise<{ accessToken: string }>((resolve) => {
      finishLogin = resolve;
    });
    mocks.request.mockImplementation((path: string) =>
      path === "/auth/captcha/password-challenge" ? { required: false } : accountResponse,
    );
    const page = makePage();
    const attempt = page.loginPassword();
    await vi.waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("/auth/admin/password-login", expect.anything()),
    );
    page.onHide();
    page.active = true;
    finishLogin({ accessToken: "late-account-token" });
    await attempt;
    expect(mocks.request).not.toHaveBeenCalledWith("/auth/employee/web-session", expect.anything());
    expect(mocks.saveSession).not.toHaveBeenCalled();
    expect(page.data.password).toBe("");
  });

  it("does not send invalid credentials or duplicate login requests", async () => {
    const page = makePage();
    page.data.username = "bad account";
    await page.loginPassword();
    expect(page.data.error).toContain("管理员创建的账号");
    page.data.username = "employee.demo";
    page.data.password = "short";
    await page.loginPassword();
    expect(page.data.error).toContain("12–128");
    page.data.busy = true;
    await page.loginPassword();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("blocks all SMS and binding requests when the deployment disabled SMS", async () => {
    mocks.config.smsLoginEnabled = false;
    const page = makePage();
    await page.requestCode();
    await page.loadCandidates();
    await page.bindSelected();
    await page.completeAuthentication([bound.enterpriseId], false);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.saveSession).not.toHaveBeenCalled();
  });
});

describe("optional employee SMS login", () => {
  it("uses ordinary SMS for every phone, including a former review number", async () => {
    mocks.request.mockImplementation((path: string) =>
      path === "/auth/captcha/challenge" ? { required: true } : smsCodeResponse,
    );
    const page = makePage();
    page.data.phone = "13800138000";
    page.useSmsLogin();
    expect(page.data.password).toBe("");
    await page.requestCode();
    expect(page.data.authMode).toBe("SMS");
    expect(mocks.request).toHaveBeenCalledWith(
      "/auth/employee/request-code",
      expect.objectContaining({ body: { phone: "13800138000", captcha: captchaProof } }),
    );
    expect(mocks.request.mock.calls.some(([path]) => path.includes("/debug/"))).toBe(false);
  });

  it("clears verification state when switching back to account login", () => {
    const page = makePage(true);
    page.data.developmentCode = "000000";
    page.usePasswordLogin();
    expect(page.data.authMode).toBe("PASSWORD");
    expect(page.data.joinMode).toBe(false);
    expect(page.data.developmentCode).toBe("");
    page.onPhoneInput({ detail: { value: "13800000099" } });
    expect(page.data.authMode).toBe("SMS");
    expect(page.data.code).toBe("");
  });

  it("clears the temporary code when returning to the phone step", () => {
    const page = makePage();
    page.data.developmentCode = "000000";
    page.backToPhone();
    expect(page.data.developmentCode).toBe("");
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

  it("does not change credentials while verification is in progress", () => {
    const page = makePage();
    page.data.busy = true;
    page.onPhoneInput({ detail: { value: "13800000001" } });
    page.onCodeInput({ detail: { value: "654321" } });
    expect(page.data.phone).toBe("13800000099");
    expect(page.data.code).toBe("123456");
    page.onUsernameInput({ detail: { value: "other.employee" } });
    page.onPasswordInput({ detail: { value: "new-password-123" } });
    expect(page.data.username).toBe("employee.demo");
    expect(page.data.password).toBe("Demo-password-123");
  });
});

function makePage(joinMode = false): LoginPage {
  return {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      authMode: "SMS",
      candidates: [],
      code: "123456",
      joinMode,
      phone: "13800000099",
      selectedCount: 0,
      stage: "CODE",
      username: "employee.demo",
      password: "Demo-password-123",
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
    employeeName: "演示员工",
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
