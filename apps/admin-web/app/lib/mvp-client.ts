import type { components } from "@xhs-agentic/contracts";
import { randomBrowserId } from "./browser-capabilities";

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.trim().replace(/\/$/u, "") || "/api";

export function storageObjectUrl(value: string, apiBaseUrl = API_BASE_URL): string {
  return value.startsWith("/api/storage/objects/")
    ? `${apiBaseUrl.replace(/\/$/u, "")}${value.slice(4)}`
    : value;
}

export type CursorPage<T> = Readonly<{
  items: readonly T[];
  pageInfo: Readonly<{ hasNextPage: boolean; nextCursor: string | null }>;
}>;

export function cursorPagePath(path: string, cursor: string | null, limit = 50): string {
  const separator = path.includes("?") ? "&" : "?";
  const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
  return `${path}${separator}limit=${limit}${cursorQuery}`;
}

export async function apiRequestAllCursorPages<T>(
  path: string,
  options: Readonly<{ token?: string }> = {},
): Promise<readonly T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: CursorPage<T> = await apiRequest<CursorPage<T>>(
      cursorPagePath(path, cursor, 100),
      options,
    );
    items.push(...page.items);
    cursor = page.pageInfo.nextCursor;
    if (cursor) {
      if (seen.has(cursor)) throw new Error("Pagination cursor repeated unexpectedly");
      seen.add(cursor);
    }
  } while (cursor);
  return items;
}

export type MvpSession = Readonly<{
  accessTokenExpiresAt: string | null;
  adminAccess: AdminSessionProfile;
  adminPhone: string;
  adminToken: string;
  employeePhone: string;
  employeeToken: string;
  enterpriseId: string;
  enterpriseName: string;
  mode: "DEVELOPMENT" | "FORMAL";
  platformToken: string;
  platformAccess: AdminSessionProfile;
  tenantId: string;
  tenantName: string;
}>;

export type AdminSessionProfile = components["schemas"]["AdminSessionProfileDto"];
export type AdminScopeProfile = components["schemas"]["AdminSessionScopeDto"];
type DevelopmentAdminTokenResponse = components["schemas"]["DevelopmentAdminTokenResponseDto"];
type EmployeeTokenResponse = components["schemas"]["EmployeeTokenResponseDto"];
type TenantResponse = components["schemas"]["TenantDto"];
type EnterpriseResponse = components["schemas"]["EnterpriseDto"];

export type AdminEnterpriseContext = Readonly<{
  enterpriseId: string;
  enterpriseName: string;
  roleName: string;
  tenantId: string;
  tenantName: string;
}>;

export function consoleNavigationPermissions(session: MvpSession): readonly string[] {
  return uniquePermissions(
    session.adminAccess.scopes.filter(
      (scope) =>
        scope.tenant?.id === session.tenantId &&
        (scope.scopeType === "TENANT" || scope.enterprise?.id === session.enterpriseId),
    ),
  );
}

export function platformNavigationPermissions(session: MvpSession): readonly string[] {
  return uniquePermissions(
    session.platformAccess.scopes.filter((scope) => scope.scopeType === "PLATFORM"),
  );
}

function uniquePermissions(scopes: readonly AdminScopeProfile[]): readonly string[] {
  return [...new Set(scopes.flatMap(({ permissions }) => permissions))];
}

const SESSION_KEY = "xhs-agentic:mvp-session:v1";
const PLATFORM_PHONE = "13800000000";
const ADMIN_PHONE = "13800000001";
const EMPLOYEE_PHONES = ["13600000001", "13600000002", "13600000003"] as const;
const requestActivityListeners = new Set<() => void>();
type UnauthorizedRecovery = (expiredToken: string) => Promise<string | null>;
let unauthorizedRecovery: UnauthorizedRecovery | null = null;
const API_PRELOAD_TTL_MS = 30_000;
const preloadedApiRequests = new Map<
  string,
  Readonly<{ expiresAt: number; promise: Promise<unknown> }>
>();
let activeTrackedRequests = 0;

export function currentTrackedRequestCount(): number {
  return activeTrackedRequests;
}

export function subscribeRequestActivity(listener: () => void): () => void {
  requestActivityListeners.add(listener);
  return () => requestActivityListeners.delete(listener);
}

export function registerUnauthorizedRecovery(recovery: UnauthorizedRecovery): () => void {
  unauthorizedRecovery = recovery;
  return () => {
    if (unauthorizedRecovery === recovery) unauthorizedRecovery = null;
  };
}

export async function trackedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return withTrackedRequest(() => fetch(input, init));
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export function hasApiErrorCode(reason: unknown, code: string): boolean {
  return reason instanceof ApiError && isRecord(reason.body) && reason.body.code === code;
}

type ApiRequestOptions = Readonly<{
  token?: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  skipUnauthorizedRecovery?: boolean;
}>;

export function preloadApiRequest<T>(
  path: string,
  options: Readonly<Pick<ApiRequestOptions, "headers" | "token">> = {},
): Promise<T> {
  const key = apiPreloadKey(path, options);
  const cached = preloadedApiRequests.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise as Promise<T>;
  if (cached) preloadedApiRequests.delete(key);

  const promise = performApiRequest<T>(path, { ...options, method: "GET" }, false);
  preloadedApiRequests.set(key, {
    expiresAt: Date.now() + API_PRELOAD_TTL_MS,
    promise,
  });
  void promise.catch(() => {
    if (preloadedApiRequests.get(key)?.promise === promise) preloadedApiRequests.delete(key);
  });
  return promise;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  if (method === "GET") {
    const key = apiPreloadKey(path, options);
    const cached = preloadedApiRequests.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      preloadedApiRequests.delete(key);
      return cached.promise as Promise<T>;
    }
    if (cached) preloadedApiRequests.delete(key);
  } else {
    preloadedApiRequests.clear();
  }
  return performApiRequest<T>(path, options, true);
}

async function performApiRequest<T>(
  path: string,
  options: ApiRequestOptions,
  trackActivity: boolean,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const method = options.method ?? "GET";
  if (method !== "GET" && !headers.has("idempotency-key")) {
    headers.set("idempotency-key", randomBrowserId());
  }
  const request = (token: string | undefined) => {
    const requestHeaders = new Headers(headers);
    if (token) requestHeaders.set("authorization", `Bearer ${token}`);
    else requestHeaders.delete("authorization");
    return fetch(`${API_BASE_URL}${path}`, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "include",
      headers: requestHeaders,
      method,
    });
  };
  const operation = async () => {
    let response = await request(options.token);
    if (
      response.status === 401 &&
      options.token &&
      !options.skipUnauthorizedRecovery &&
      unauthorizedRecovery
    ) {
      const replacementToken = await unauthorizedRecovery(options.token);
      if (replacementToken) response = await request(replacementToken);
    }
    const text = await response.text();
    const body = text ? safeJson(text) : null;
    if (!response.ok) {
      const message =
        response.status === 401 && options.token
          ? "登录状态已过期，请重新登录"
          : isRecord(body) && typeof body.message === "string"
            ? body.message
            : text;
      throw new ApiError(
        message || `API request failed (${response.status})`,
        response.status,
        body,
      );
    }
    return body as T;
  };
  return trackActivity ? withTrackedRequest(operation) : operation();
}

function apiPreloadKey(
  path: string,
  options: Readonly<Pick<ApiRequestOptions, "headers" | "token">>,
): string {
  const headers = [...new Headers(options.headers).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join("|");
  return `${options.token ?? ""}\u0000${path}\u0000${headers}`;
}

async function withTrackedRequest<T>(operation: () => Promise<T>): Promise<T> {
  activeTrackedRequests += 1;
  notifyRequestActivity();
  try {
    return await operation();
  } finally {
    activeTrackedRequests = Math.max(0, activeTrackedRequests - 1);
    notifyRequestActivity();
  }
}

function notifyRequestActivity(): void {
  for (const listener of requestActivityListeners) listener();
}

export function loadMvpSession(): MvpSession | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(SESSION_KEY);
  if (!value) return null;
  try {
    return JSON.parse(value) as MvpSession;
  } catch {
    window.localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function saveMvpSession(session: MvpSession): void {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearMvpSession(): void {
  window.localStorage.removeItem(SESSION_KEY);
}

export async function refreshMvpSession(session: MvpSession): Promise<MvpSession> {
  if (session.mode === "FORMAL") {
    const refreshedToken = await apiRequest<FormalTokenResponse>("/auth/admin/refresh", {
      method: "POST",
      skipUnauthorizedRecovery: true,
    });
    const adminAccess = await adminSessionProfile(refreshedToken.accessToken, true);
    const selected = selectAvailableContext(session, adminAccess, false);
    const refreshed = {
      ...session,
      ...selected,
      accessTokenExpiresAt: accessTokenExpiresAt(refreshedToken.expiresInSeconds),
      adminAccess,
      adminPhone: adminAccess.phone ?? "",
      adminToken: refreshedToken.accessToken,
      platformAccess: adminAccess,
      platformToken: refreshedToken.accessToken,
    };
    saveMvpSession(refreshed);
    return refreshed;
  }

  const [platform, admin, employee] = await Promise.all([
    developmentAdminToken(PLATFORM_PHONE),
    developmentAdminToken(session.adminPhone),
    apiRequest<EmployeeTokenResponse>("/auth/dev/employee-bind", {
      body: { enterpriseIds: [session.enterpriseId], phone: session.employeePhone },
      method: "POST",
    }),
  ]);
  const [platformAccess, adminAccess] = await Promise.all([
    adminSessionProfile(platform.accessToken, true),
    adminSessionProfile(admin.accessToken, true),
  ]);
  const selected = selectAvailableContext(session, adminAccess, true);
  const refreshed = {
    ...session,
    ...selected,
    accessTokenExpiresAt: accessTokenExpiresAt(
      Math.min(platform.expiresInSeconds, admin.expiresInSeconds),
    ),
    adminAccess,
    adminToken: admin.accessToken,
    employeeToken: employee.accessToken,
    platformToken: platform.accessToken,
    platformAccess,
  };
  saveMvpSession(refreshed);
  return refreshed;
}

export async function bootstrapMvp(): Promise<MvpSession> {
  const platform = await developmentAdminToken(PLATFORM_PHONE);
  const tenants = await apiRequest<TenantResponse[]>("/platform/tenants", {
    token: platform.accessToken,
  });
  let tenant = tenants.find(({ name }) => name === "XHS MVP 演示集团");
  if (!tenant) {
    tenant = await apiRequest<TenantResponse>("/platform/tenants", {
      body: { customerType: "GROUP", name: "XHS MVP 演示集团" },
      method: "POST",
      token: platform.accessToken,
    });
  }
  const enterprises = await apiRequest<EnterpriseResponse[]>(
    `/platform/tenants/${tenant.id}/enterprises`,
    { token: platform.accessToken },
  );
  let enterprise =
    enterprises.find(({ code }) => code === "MVP_DEMO") ??
    enterprises.find(({ name }) => name === "明澈眼科 · 上海院区");
  if (!enterprise) {
    enterprise = await apiRequest<EnterpriseResponse>(
      `/platform/tenants/${tenant.id}/enterprises`,
      {
        body: {
          brandName: "明澈眼科",
          city: "上海",
          industry: "医疗健康",
          name: "明澈眼科 · 上海院区",
        },
        method: "POST",
        token: platform.accessToken,
      },
    );
  }
  await apiRequest(`/platform/tenants/${tenant.id}/admins`, {
    body: { phone: ADMIN_PHONE, reason: "初始化本机集团主管理员" },
    method: "POST",
    token: platform.accessToken,
  });
  const admin = await developmentAdminToken(ADMIN_PHONE);
  const imported = await apiRequest<components["schemas"]["MembershipImportResponseDto"]>(
    `/console/tenants/${tenant.id}/enterprises/${enterprise.id}/memberships/import`,
    {
      body: {
        members: EMPLOYEE_PHONES.map((phone, index) => ({
          employeeNo: `DEMO-${index + 1}`,
          name: ["林晓", "陈雨", "周宁"][index],
          phone,
        })),
      },
      method: "POST",
      token: admin.accessToken,
    },
  );
  for (const membership of imported.memberships) {
    if (membership.seatStatus !== "ENABLED") {
      await apiRequest(
        `/console/tenants/${tenant.id}/enterprises/${enterprise.id}/memberships/${membership.id}/enable`,
        {
          body: { reason: "初始化本机 MVP 员工任务参与状态" },
          method: "POST",
          token: admin.accessToken,
        },
      );
    }
  }
  const materials = await apiRequest<components["schemas"]["MaterialResponseDto"][]>(
    `/console/tenants/${tenant.id}/enterprises/${enterprise.id}/materials`,
    { token: admin.accessToken },
  );
  if (materials.length === 0) {
    await apiRequest(`/console/tenants/${tenant.id}/enterprises/${enterprise.id}/materials`, {
      body: {
        authorizationConfirmed: true,
        content:
          "全飞秒 Pro 资料：设备能力、规范术前评估、个体化适用条件和真实服务流程需要同时说明。",
        structuredFacts: {
          compliance: "效果存在个体差异，应以专业评估为准",
          device: "专业设备与规范流程共同影响体验",
        },
        tags: ["全飞秒Pro", "设备", "术前评估"],
        title: "全飞秒 Pro 授权基础资料",
        type: "TEXT",
      },
      method: "POST",
      token: admin.accessToken,
    });
  }
  const employee = await apiRequest<EmployeeTokenResponse>("/auth/dev/employee-bind", {
    body: { enterpriseIds: [enterprise.id], phone: EMPLOYEE_PHONES[0] },
    method: "POST",
  });
  const [platformAccess, adminAccess] = await Promise.all([
    adminSessionProfile(platform.accessToken, true),
    adminSessionProfile(admin.accessToken, true),
  ]);
  const session: MvpSession = {
    accessTokenExpiresAt: accessTokenExpiresAt(
      Math.min(platform.expiresInSeconds, admin.expiresInSeconds),
    ),
    adminAccess,
    adminPhone: ADMIN_PHONE,
    adminToken: admin.accessToken,
    employeePhone: EMPLOYEE_PHONES[0],
    employeeToken: employee.accessToken,
    enterpriseId: enterprise.id,
    enterpriseName: enterprise.name,
    mode: "DEVELOPMENT",
    platformToken: platform.accessToken,
    platformAccess,
    tenantId: tenant.id,
    tenantName: tenant.name,
  };
  saveMvpSession(session);
  return session;
}

export async function loginPasswordAdmin(
  input: Readonly<{
    username: string;
    password: string;
    captcha?: { token: string; solutions: number[] };
  }>,
): Promise<MvpSession> {
  return createFormalSession(
    await apiRequest<FormalTokenResponse>("/auth/admin/password-login", {
      body: input,
      method: "POST",
    }),
  );
}

export async function initializeInstallation(
  input: Readonly<{
    username: string;
    password: string;
    name: string;
    organizationName: string;
    organizationType: "SINGLE_ENTERPRISE" | "GROUP";
    installationToken: string;
  }>,
): Promise<MvpSession> {
  return createFormalSession(
    await apiRequest<FormalTokenResponse>("/auth/admin/installation", {
      body: input,
      method: "POST",
    }),
  );
}

async function createFormalSession(token: FormalTokenResponse): Promise<MvpSession> {
  const adminAccess = await adminSessionProfile(token.accessToken);
  const contexts = adminEnterpriseContextsFromProfile(adminAccess);
  const selected = contexts[0];
  const tenant = adminAccess.scopes.find((scope) => scope.scopeType === "TENANT")?.tenant;
  const session: MvpSession = {
    accessTokenExpiresAt: accessTokenExpiresAt(token.expiresInSeconds),
    adminAccess,
    adminPhone: adminAccess.phone ?? "",
    adminToken: token.accessToken,
    employeePhone: "",
    employeeToken: "",
    enterpriseId: selected?.enterpriseId ?? "",
    enterpriseName: selected?.enterpriseName ?? "",
    mode: "FORMAL",
    platformAccess: adminAccess,
    platformToken: token.accessToken,
    tenantId: selected?.tenantId ?? tenant?.id ?? "",
    tenantName: selected?.tenantName ?? tenant?.name ?? "",
  };
  saveMvpSession(session);
  return session;
}

export async function logoutFormalAdmin(): Promise<void> {
  try {
    await apiRequest("/auth/admin/logout", { method: "POST" });
  } finally {
    clearMvpSession();
  }
}

export function adminEnterpriseContexts(session: MvpSession): AdminEnterpriseContext[] {
  return adminEnterpriseContextsFromProfile(session.adminAccess);
}

export function selectedAdminEnterpriseContext(
  session: MvpSession,
): AdminEnterpriseContext | undefined {
  return adminEnterpriseContexts(session).find(
    ({ enterpriseId }) => enterpriseId === session.enterpriseId,
  );
}

export function selectedAdminRoleName(session: MvpSession): string {
  return selectedAdminEnterpriseContext(session)?.roleName ?? "后台管理员";
}

export async function synchronizeAdminAccess(session: MvpSession): Promise<MvpSession> {
  const adminAccess = await adminSessionProfile(session.adminToken);
  const selected = selectAvailableContext(session, adminAccess, false);
  const synchronized = {
    ...session,
    ...selected,
    adminAccess,
    platformAccess: session.mode === "FORMAL" ? adminAccess : session.platformAccess,
  };
  saveMvpSession(synchronized);
  return synchronized;
}

export async function synchronizePlatformAccess(session: MvpSession): Promise<MvpSession> {
  const platformAccess = await adminSessionProfile(session.platformToken);
  const synchronized = {
    ...session,
    platformAccess,
    ...(session.mode === "FORMAL" ? { adminAccess: platformAccess } : {}),
  };
  saveMvpSession(synchronized);
  return synchronized;
}

function adminEnterpriseContextsFromProfile(
  profile: AdminSessionProfile,
): AdminEnterpriseContext[] {
  const contexts = profile.scopes.flatMap((scope) => {
    if (!scope.tenant) return [];
    if (scope.scopeType === "TENANT") {
      return scope.inheritedEnterprises.map((enterprise) => ({
        enterpriseId: enterprise.id,
        enterpriseName: enterprise.name,
        roleName: scope.role.name,
        tenantId: scope.tenant?.id ?? "",
        tenantName: scope.tenant?.name ?? "",
      }));
    }
    if (scope.scopeType === "ENTERPRISE" && scope.enterprise) {
      return [
        {
          enterpriseId: scope.enterprise.id,
          enterpriseName: scope.enterprise.name,
          roleName: scope.role.name,
          tenantId: scope.tenant.id,
          tenantName: scope.tenant.name,
        },
      ];
    }
    return [];
  });
  const merged = new Map<string, AdminEnterpriseContext>();
  for (const context of contexts) {
    const existing = merged.get(context.enterpriseId);
    if (!existing) {
      merged.set(context.enterpriseId, context);
      continue;
    }
    const roles = [...new Set([...existing.roleName.split(" + "), context.roleName])];
    merged.set(context.enterpriseId, { ...existing, roleName: roles.join(" + ") });
  }
  return [...merged.values()].sort(
    (left, right) =>
      left.tenantName.localeCompare(right.tenantName, "zh-CN") ||
      left.enterpriseName.localeCompare(right.enterpriseName, "zh-CN"),
  );
}

export function selectAdminEnterprise(session: MvpSession, enterpriseId: string): MvpSession {
  const context = adminEnterpriseContexts(session).find(
    (candidate) => candidate.enterpriseId === enterpriseId,
  );
  if (!context) throw new Error("当前管理员无权进入所选企业");
  const updated = {
    ...session,
    enterpriseId: context.enterpriseId,
    enterpriseName: context.enterpriseName,
    tenantId: context.tenantId,
    tenantName: context.tenantName,
  };
  saveMvpSession(updated);
  return updated;
}

export async function bindEmployeePhone(session: MvpSession, phone: string): Promise<MvpSession> {
  const employee = await apiRequest<EmployeeTokenResponse>("/auth/dev/employee-bind", {
    body: { phone },
    method: "POST",
  });
  const updated = { ...session, employeePhone: phone, employeeToken: employee.accessToken };
  saveMvpSession(updated);
  return updated;
}

type FormalTokenResponse = components["schemas"]["AdminTokenResponseDto"];

async function developmentAdminToken(phone: string): Promise<DevelopmentAdminTokenResponse> {
  return apiRequest<DevelopmentAdminTokenResponse>("/auth/dev/admin-token", {
    body: { phone },
    method: "POST",
  });
}

function adminSessionProfile(
  token: string,
  skipUnauthorizedRecovery = false,
): Promise<AdminSessionProfile> {
  return apiRequest<AdminSessionProfile>("/auth/admin/session", {
    skipUnauthorizedRecovery,
    token,
  });
}

function selectAvailableContext(
  previous: MvpSession,
  adminAccess: AdminSessionProfile,
  required: boolean,
): Pick<MvpSession, "enterpriseId" | "enterpriseName" | "tenantId" | "tenantName"> {
  const session = { ...previous, adminAccess };
  const contexts = adminEnterpriseContexts(session);
  const selected =
    contexts.find(({ enterpriseId }) => enterpriseId === previous.enterpriseId) ?? contexts[0];
  if (selected) return selected;
  if (required) throw new Error("管理员没有可访问的企业作用域");
  const tenant = adminAccess.scopes.find((scope) => scope.scopeType === "TENANT")?.tenant;
  return {
    enterpriseId: "",
    enterpriseName: "",
    tenantId: tenant?.id ?? "",
    tenantName: tenant?.name ?? "",
  };
}

function accessTokenExpiresAt(expiresInSeconds: number): string {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
