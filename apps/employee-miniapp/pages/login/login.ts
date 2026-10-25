import { miniappConfig } from "../../config";
import type { BindCandidate, EmployeeMembership } from "../../types";
import { apiRequest, getApiBaseUrl, messageOf } from "../../utils/api";
import { retrySeconds, type SmsChallenge, solveSmsChallenge } from "../../utils/generated/captcha";
import {
  loadSession,
  saveEnterpriseFilter,
  saveFlashNotice,
  saveSession,
} from "../../utils/session";

interface CandidateView extends BindCandidate {
  selected: boolean;
}

type EmployeeAuthMode = "PASSWORD" | "SMS";

interface LoginData {
  authMode: EmployeeAuthMode;
  busy: boolean;
  candidates: CandidateView[];
  code: string;
  developmentCode: string;
  error: string;
  joinMode: boolean;
  notice: string;
  phone: string;
  phoneMasked: string;
  username: string;
  password: string;
  smsLoginEnabled: boolean;
  selectedCount: number;
  stage: "PHONE" | "CODE" | "SELECT";
  retryRemaining: number;
  securityProgress: number;
}

Page({
  retryTimer: undefined as number | undefined,
  passwordAttempt: 0,
  active: true,
  data: {
    authMode: "PASSWORD",
    busy: false,
    candidates: [],
    code: "",
    developmentCode: "",
    error: "",
    joinMode: false,
    notice: "",
    phone: "",
    phoneMasked: "",
    username: "",
    password: "",
    smsLoginEnabled: miniappConfig.smsLoginEnabled,
    selectedCount: 0,
    stage: "PHONE",
    retryRemaining: 0,
    securityProgress: -1,
  } as LoginData,

  onShow() {
    this.active = true;
    this.refreshCountdown();
    this.retryTimer = setInterval(() => this.refreshCountdown(), 500);
  },
  onHide() {
    this.active = false;
    this.passwordAttempt += 1;
    this.setData({ busy: false, password: "", securityProgress: -1 });
    if (this.retryTimer !== undefined) clearInterval(this.retryTimer);
    this.retryTimer = undefined;
  },
  onUnload() {
    this.onHide();
  },
  refreshCountdown() {
    const until =
      Number(wx.getStorageSync(`xhs:sms-retry:${getApiBaseUrl()}:${this.data.phone}`)) || 0;
    this.setData({ retryRemaining: Math.max(0, Math.ceil((until - Date.now()) / 1000)) });
  },
  startCountdown(phone: string, seconds: number) {
    wx.setStorageSync(`xhs:sms-retry:${getApiBaseUrl()}:${phone}`, Date.now() + seconds * 1000);
    this.refreshCountdown();
  },

  onLoad(options: Record<string, string | undefined>) {
    const session = loadSession();
    const joinMode = options.mode === "join" && miniappConfig.smsLoginEnabled;
    if (session && !joinMode) {
      wx.redirectTo({ url: "/pages/tasks/tasks" });
      return;
    }
    this.setData({
      authMode: joinMode ? "SMS" : "PASSWORD",
      joinMode,
      phone: session?.phone ?? "",
    });
  },

  onUsernameInput(event: { detail: { value: string } }) {
    if (!this.data.busy) this.setData({ username: event.detail.value.trim(), error: "" });
  },

  onPasswordInput(event: { detail: { value: string } }) {
    if (!this.data.busy) this.setData({ password: event.detail.value, error: "" });
  },

  useSmsLogin() {
    if (this.data.busy || !miniappConfig.smsLoginEnabled) return;
    this.backToPhone();
    this.setData({ authMode: "SMS", password: "" });
  },

  usePasswordLogin() {
    if (this.data.busy) return;
    this.backToPhone();
    this.setData({ authMode: "PASSWORD", joinMode: false, password: "" });
  },

  async loginPassword() {
    if (this.data.busy) return;
    const username = this.data.username.trim();
    const password = this.data.password;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/u.test(username)) {
      this.setData({ error: "请输入管理员创建的账号（3–64 位字母、数字或 _ . -）" });
      return;
    }
    if (password.length < 12 || password.length > 128) {
      this.setData({ error: "请输入 12–128 位账号密码" });
      return;
    }
    this.setData({ busy: true, error: "", notice: "", securityProgress: 0 });
    const attempt = ++this.passwordAttempt;
    try {
      const challenge = await apiRequest<SmsChallenge>("/auth/captcha/password-challenge", {
        method: "POST",
        body: { username, purpose: "PASSWORD_LOGIN" },
      });
      if (!this.active || attempt !== this.passwordAttempt) return;
      const captcha = await solveSmsChallenge(
        challenge,
        (securityProgress) => {
          if (this.active && attempt === this.passwordAttempt) this.setData({ securityProgress });
        },
        () => !this.active || attempt !== this.passwordAttempt,
      );
      if (!this.active || attempt !== this.passwordAttempt) return;
      this.setData({ securityProgress: -1 });
      const account = await apiRequest<{ accessToken: string }>("/auth/admin/password-login", {
        method: "POST",
        body: { username, password, ...(captcha ? { captcha } : {}) },
      });
      if (!this.active || attempt !== this.passwordAttempt) return;
      const employee = await apiRequest<{
        accessToken: string;
        memberships: EmployeeMembership[];
      }>("/auth/employee/web-session", { method: "POST", token: account.accessToken });
      if (!this.active || attempt !== this.passwordAttempt) return;
      saveEnterpriseFilter("ALL");
      saveSession({
        accessToken: employee.accessToken,
        memberships: employee.memberships,
        phone: "",
        username,
      });
      this.setData({ password: "" });
      wx.reLaunch({ url: "/pages/tasks/tasks" });
    } catch (reason) {
      if (this.active && attempt === this.passwordAttempt)
        this.setData({ error: messageOf(reason) });
    } finally {
      if (this.active && attempt === this.passwordAttempt)
        this.setData({ busy: false, password: "", securityProgress: -1 });
    }
  },

  onPhoneInput(event: { detail: { value: string } }) {
    if (this.data.busy) return;
    const phone = event.detail.value.trim();
    this.setData({
      authMode: "SMS",
      code: "",
      developmentCode: "",
      error: "",
      notice: "",
      phone,
    });
    this.refreshCountdown();
  },

  onCodeInput(event: { detail: { value: string } }) {
    if (this.data.busy) return;
    this.setData({ code: event.detail.value.trim(), error: "" });
  },

  async requestCode() {
    if (!miniappConfig.smsLoginEnabled || this.data.busy || this.data.retryRemaining > 0) return;
    if (!/^1[3-9]\d{9}$/u.test(this.data.phone)) {
      this.setData({ error: "请输入正确的 11 位手机号" });
      return;
    }
    this.setData({
      authMode: "SMS",
      busy: true,
      code: "",
      developmentCode: "",
      error: "",
      notice: "",
    });
    try {
      this.setData({ securityProgress: 0 });
      const challenge = await apiRequest<SmsChallenge>("/auth/captcha/challenge", {
        method: "POST",
        body: { phone: this.data.phone, purpose: "EMPLOYEE_BIND" },
      });
      const captcha = await solveSmsChallenge(
        challenge,
        (securityProgress) => this.setData({ securityProgress }),
        () => !this.active,
      );
      if (!this.active) return;
      this.setData({ securityProgress: -1 });
      const result = await apiRequest<{
        delivery: string;
        developmentCode?: string;
        expiresInSeconds: number;
        phoneMasked: string;
        retryAfterSeconds: number;
      }>("/auth/employee/request-code", {
        body: { phone: this.data.phone, ...(captcha ? { captcha } : {}) },
        method: "POST",
      });
      this.startCountdown(this.data.phone, result.retryAfterSeconds);
      this.setData({
        code: "",
        developmentCode: result.developmentCode ?? "",
        notice:
          result.delivery === "DEVELOPMENT_ADAPTER"
            ? "开发短信适配器已发送验证码；它不会调用真实短信服务。"
            : "验证码已发送，请在 5 分钟内完成绑定。",
        phoneMasked: result.phoneMasked,
        stage: "CODE",
      });
    } catch (reason) {
      const retry = retrySeconds(reason);
      if (retry > 0) this.startCountdown(this.data.phone, retry);
      this.setData({ error: messageOf(reason) });
    } finally {
      this.setData({ busy: false, securityProgress: -1 });
    }
  },

  async loadCandidates() {
    if (!miniappConfig.smsLoginEnabled || this.data.busy) return;
    if (!/^\d{6}$/u.test(this.data.code)) {
      this.setData({ error: "请输入 6 位验证码" });
      return;
    }
    this.setData({ busy: true, error: "", notice: "" });
    try {
      const result = await apiRequest<{ candidates: BindCandidate[]; phoneMasked: string }>(
        "/auth/employee/candidates",
        {
          body: { code: this.data.code, phone: this.data.phone },
          method: "POST",
        },
      );
      const existing = result.candidates.filter((candidate) => candidate.alreadyBound);
      const newCandidates = result.candidates.filter((candidate) => !candidate.alreadyBound);
      const existingSession = loadSession();
      if (
        existing.length > 0 &&
        (!this.data.joinMode || !existingSession || existingSession.phone !== this.data.phone)
      ) {
        await this.completeAuthentication(
          existing.map(({ enterpriseId }) => enterpriseId),
          false,
        );
        return;
      }
      if (this.data.joinMode && newCandidates.length === 0) {
        saveFlashNotice("已加入全部可用企业，无需再次绑定。");
        wx.navigateBack({ delta: 1 });
        return;
      }
      const candidates = (this.data.joinMode ? newCandidates : result.candidates).map(
        (candidate) => ({ ...candidate, selected: true }),
      );
      this.setData({
        candidates,
        phoneMasked: result.phoneMasked,
        selectedCount: candidates.length,
        stage: "SELECT",
      });
    } catch (reason) {
      this.setData({ error: messageOf(reason) });
    } finally {
      this.setData({ busy: false });
    }
  },

  toggleCandidate(event: { currentTarget: { dataset: { enterpriseId?: string } } }) {
    if (this.data.busy) return;
    const enterpriseId = event.currentTarget.dataset.enterpriseId;
    if (!enterpriseId) return;
    const candidates = this.data.candidates.map((candidate) =>
      candidate.enterpriseId === enterpriseId
        ? { ...candidate, selected: !candidate.selected }
        : candidate,
    );
    this.setData({
      candidates,
      selectedCount: candidates.filter(({ selected }) => selected).length,
    });
  },

  async bindSelected() {
    if (!miniappConfig.smsLoginEnabled || this.data.busy) return;
    const enterpriseIds = this.data.candidates
      .filter(({ selected }) => selected)
      .map(({ enterpriseId }) => enterpriseId);
    if (enterpriseIds.length === 0) {
      this.setData({ error: "请至少选择一家要加入的企业" });
      return;
    }
    this.setData({ busy: true, error: "", notice: "" });
    try {
      await this.completeAuthentication(enterpriseIds, true);
    } catch (reason) {
      this.setData({ error: messageOf(reason) });
    } finally {
      this.setData({ busy: false });
    }
  },

  async completeAuthentication(enterpriseIds: string[], joining: boolean) {
    if (!miniappConfig.smsLoginEnabled) return;
    const result = await apiRequest<{
      accessToken: string;
      memberships: EmployeeMembership[];
    }>("/auth/employee/bind", {
      body: {
        code: this.data.code,
        enterpriseIds,
        phone: this.data.phone,
      },
      method: "POST",
    });
    const stored = loadSession();
    const previous = stored?.phone === this.data.phone ? stored : null;
    const memberships = mergeMemberships(previous?.memberships ?? [], result.memberships);
    const previousEnterpriseIds = new Set(
      (previous?.memberships ?? []).map(({ enterpriseId }) => enterpriseId),
    );
    const newlyJoinedNames = joining
      ? result.memberships
          .filter(({ enterpriseId }) => !previousEnterpriseIds.has(enterpriseId))
          .map(({ enterpriseName }) => enterpriseName)
      : [];
    if (stored?.phone !== this.data.phone) saveEnterpriseFilter("ALL");
    saveSession({ accessToken: result.accessToken, memberships, phone: this.data.phone });
    if (joining) {
      saveFlashNotice(
        newlyJoinedNames.length > 0
          ? `已加入：${newlyJoinedNames.join("、")}`
          : "所选企业已完成绑定，没有重复创建员工关系。",
      );
      wx.showToast({
        icon: "success",
        title: newlyJoinedNames.length > 0 ? "企业已加入" : "绑定已确认",
      });
    }
    wx.reLaunch({ url: "/pages/tasks/tasks" });
  },

  backToPhone() {
    this.setData({
      candidates: [],
      code: "",
      developmentCode: "",
      error: "",
      notice: "",
      selectedCount: 0,
      stage: "PHONE",
    });
  },
});

function mergeMemberships(
  previous: EmployeeMembership[],
  current: EmployeeMembership[],
): EmployeeMembership[] {
  const rows = new Map(previous.map((membership) => [membership.membershipId, membership]));
  for (const membership of current) rows.set(membership.membershipId, membership);
  return [...rows.values()];
}
