import { miniappConfig } from "../config";
import type { EmployeeApp, EmployeeSession } from "../types";

// A new deployment must never receive credentials saved for a different API.
const instance = miniappConfig.apiBaseUrl.replace(/\/+$/u, "");
const SESSION_KEY = `qisheng:employee:${instance}:session:v2`;
const ENTERPRISE_FILTER_KEY = `qisheng:employee:${instance}:enterprise-filter:v2`;
const FIRST_GUIDE_KEY = `qisheng:employee:${instance}:first-guide:v2`;
const FLASH_NOTICE_KEY = `qisheng:employee:${instance}:flash-notice:v2`;

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
