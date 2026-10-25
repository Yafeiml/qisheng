import type { BindCandidate, EmployeeMembership } from "../../types";
import { ApiError, apiRequest, getApiBaseUrl, messageOf } from "../../utils/api";
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

const REVIEW_LOGIN_PHONE = "13800138000";
type EmployeeAuthMode = "TEMPORARY_DEBUG" | "SMS";
const employeeAuthPaths = {
  TEMPORARY_DEBUG: {
    request: "/auth/employee/debug/request-code",
    candidates: "/auth/employee/debug/candidates",
    bind: "/auth/employee/debug/bind",
  },
  SMS: {
    request: "/auth/employee/request-code",
    candidates: "/auth/employee/candidates",
    bind: "/auth/employee/bind",
  },
} as const;

interface LoginData {
  authMode: EmployeeAuthMode;
  busy: boolean;
  candidates: CandidateView[];
  code: string;
  developmentCode: string;
  debugUnavailable: boolean;
  error: string;
  joinMode: boolean;
  notice: string;
  phone: string;
  phoneMasked: string;
  selectedCount: number;
  stage: "PHONE" | "CODE" | "SELECT";
  retryRemaining: number;
  securityProgress: number;
}

Page({
  retryTimer: undefined as number | undefined,
  active: true,
  forceFormalSms: false,
  data: {
    authMode: "SMS",
    busy: false,
    candidates: [],
    code: "",
    developmentCode: "",
    debugUnavailable: false,
    error: "",
    joinMode: false,
    notice: "",
    phone: "",
    phoneMasked: "",
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
    const joinMode = options.mode === "join";
    if (session && !joinMode) {
      wx.redirectTo({ url: "/pages/tasks/tasks" });
      return;
    }
    this.setData({ joinMode, phone: session?.phone ?? "" });
  },

  onPhoneInput(event: { detail: { value: string } }) {
    if (this.data.busy) return;
    const phone = event.detail.value.trim();
    if (phone !== this.data.phone) this.forceFormalSms = false;
    this.setData({
      authMode: "SMS",
      code: "",
      developmentCode: "",
      debugUnavailable: false,
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

  useFormalSms() {
    if (this.data.busy) return;
    this.forceFormalSms = true;
    this.setData({
      authMode: "SMS",
      code: "",
      developmentCode: "",
      debugUnavailable: false,
      error: "",
      notice: "已切换为正式短信验证。点击发送后，验证码将通过短信送达。",
    });
  },

  async requestCode() {
    if (this.data.busy || this.data.retryRemaining > 0) return;
    if (!/^1[3-9]\d{9}$/u.test(this.data.phone)) {
      this.setData({ error: "请输入正确的 11 位手机号" });
      return;
    }
    const mode: EmployeeAuthMode =
      this.data.phone === REVIEW_LOGIN_PHONE && !this.forceFormalSms ? "TEMPORARY_DEBUG" : "SMS";
    this.setData({
      authMode: mode,
      busy: true,
      code: "",
      developmentCode: "",
      debugUnavailable: false,
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
      }>(employeeAuthPaths[mode].request, {
        body: { phone: this.data.phone, ...(captcha ? { captcha } : {}) },
        method: "POST",
      });
      this.startCountdown(this.data.phone, result.retryAfterSeconds);
      this.setData({
        code: result.delivery === "TEMPORARY_DEBUG" ? "000000" : "",
        developmentCode: result.developmentCode ?? "",
        notice:
          result.delivery === "TEMPORARY_DEBUG"
            ? "限时调试验证码已生成，不会发送短信。"
            : result.delivery === "DEVELOPMENT_ADAPTER"
              ? "开发短信适配器已发送验证码；它不会调用真实短信服务。"
              : "验证码已发送，请在 5 分钟内完成绑定。",
        phoneMasked: result.phoneMasked,
        stage: "CODE",
      });
    } catch (reason) {
      const retry = retrySeconds(reason);
      if (retry > 0) this.startCountdown(this.data.phone, retry);
      const debugUnavailable =
        mode === "TEMPORARY_DEBUG" &&
        reason instanceof ApiError &&
        reason.statusCode === 404 &&
        (reason.message === "临时验证码接口未启用。" ||
          reason.message.includes("Cannot POST /auth/employee/debug/request-code"));
      this.setData({
        debugUnavailable,
        error: debugUnavailable
          ? "临时调试验证码尚未在正式服务启用。可改用正式短信验证，或等待服务更新。"
          : messageOf(reason),
      });
    } finally {
      this.setData({ busy: false, securityProgress: -1 });
    }
  },

  async loadCandidates() {
    if (!/^\d{6}$/u.test(this.data.code)) {
      this.setData({ error: "请输入 6 位验证码" });
      return;
    }
    this.setData({ busy: true, error: "", notice: "" });
    try {
      const result = await apiRequest<{ candidates: BindCandidate[]; phoneMasked: string }>(
        employeeAuthPaths[this.data.authMode].candidates,
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
    const result = await apiRequest<{
      accessToken: string;
      memberships: EmployeeMembership[];
    }>(employeeAuthPaths[this.data.authMode].bind, {
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
      debugUnavailable: false,
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
