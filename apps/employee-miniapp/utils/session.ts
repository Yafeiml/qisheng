import type { EmployeeApp, EmployeeSession } from "../types";

const SESSION_KEY = "xhs-agentic:employee-session:v1";
const ENTERPRISE_FILTER_KEY = "xhs-agentic:employee-enterprise-filter:v1";
const FIRST_GUIDE_KEY = "xhs-agentic:employee-first-guide:v1";
const FLASH_NOTICE_KEY = "xhs-agentic:employee-flash-notice:v1";

export function loadSession(): EmployeeSession | null {
  const value: unknown = wx.getStorageSync(SESSION_KEY);
  return isSession(value) ? value : null;
}

export function saveSession(session: EmployeeSession): void {
  wx.setStorageSync(SESSION_KEY, session);
  getApp<EmployeeApp>().globalData.session = session;
}

export function clearSession(): void {
  wx.removeStorageSync(SESSION_KEY);
  wx.removeStorageSync(ENTERPRISE_FILTER_KEY);
  getApp<EmployeeApp>().globalData.session = null;
}

export function loadEnterpriseFilter(): string {
  const value: unknown = wx.getStorageSync(ENTERPRISE_FILTER_KEY);
  return typeof value === "string" && value.length > 0 ? value : "ALL";
}

export function saveEnterpriseFilter(enterpriseId: string): void {
  wx.setStorageSync(ENTERPRISE_FILTER_KEY, enterpriseId);
}

export function hasSeenFirstGuide(): boolean {
  return wx.getStorageSync(FIRST_GUIDE_KEY) === true;
}

export function markFirstGuideSeen(): void {
  wx.setStorageSync(FIRST_GUIDE_KEY, true);
}

export function saveFlashNotice(notice: string): void {
  wx.setStorageSync(FLASH_NOTICE_KEY, notice);
}

export function consumeFlashNotice(): string {
  const value: unknown = wx.getStorageSync(FLASH_NOTICE_KEY);
  wx.removeStorageSync(FLASH_NOTICE_KEY);
  return typeof value === "string" ? value : "";
}

function isSession(value: unknown): value is EmployeeSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EmployeeSession>;
  return (
    typeof candidate.accessToken === "string" &&
    typeof candidate.phone === "string" &&
    Array.isArray(candidate.memberships)
  );
}
