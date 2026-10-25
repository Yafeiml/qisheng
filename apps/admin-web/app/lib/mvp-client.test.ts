import { describe, expect, it, vi } from "vitest";
import {
  type AdminScopeProfile,
  type AdminSessionProfile,
  ApiError,
  adminEnterpriseContexts,
  apiRequest,
  consoleNavigationPermissions,
  currentTrackedRequestCount,
  hasApiErrorCode,
  initializeInstallation,
  type MvpSession,
  platformNavigationPermissions,
  preloadApiRequest,
  refreshMvpSession,
  registerUnauthorizedRecovery,
  selectedAdminRoleName,
  storageObjectUrl,
} from "./mvp-client";

const tenantId = "tenant-a";
const enterpriseId = "enterprise-a";

it("resolves only local object URLs against the configured API base", () => {
  const path = "/api/storage/objects/signed-token?download=1";
  expect(storageObjectUrl(path)).toBe(path);
  expect(storageObjectUrl(path, "/api")).toBe(path);
  expect(storageObjectUrl(path, "https://api.example.test")).toBe(
    "https://api.example.test/storage/objects/signed-token?download=1",
  );
  expect(storageObjectUrl(path, "https://api.example.test/v1/")).toBe(
    "https://api.example.test/v1/storage/objects/signed-token?download=1",
  );
  for (const value of [
    "https://s3.example.test/bucket/private-file?signature=private",
    "https://edge.example.test/assets/signed-token",
    "data:image/png;base64,aGVsbG8=",
    "/assets/signed-token",
    "/api/storage/objects-not-local/file",
  ])
    expect(storageObjectUrl(value, "https://api.example.test/v1")).toBe(value);
});

it("matches structured API error codes without treating plain messages as field errors", () => {
  const code = "ADMIN_EMAIL_ALREADY_EXISTS";
  expect(hasApiErrorCode(new ApiError("邮箱已占用", 409, { code }), code)).toBe(true);
  for (const reason of [new Error(code), new ApiError(code, 409, null), { code }, null]) {
    expect(hasApiErrorCode(reason, code)).toBe(false);
  }
});

function scope(
  overrides: Partial<AdminScopeProfile> &
    Pick<AdminScopeProfile, "permissions" | "scopeId" | "scopeType">,
): AdminScopeProfile {
  return {
    enterprise: null,
    inheritedEnterprises: [],
    role: { code: "TEST", name: "测试角色" },
    tenant: null,
    ...overrides,
  };
}

function profile(scopes: readonly AdminScopeProfile[]): AdminSessionProfile {
  return {
    audience: "xhs-saas-admin",
    name: "测试管理员",
    phone: "13800000000",
    username: null,
    scopes: [...scopes],
    sessionId: null,
    userId: "user-a",
  };
}

function session(
  adminScopes: readonly AdminScopeProfile[],
  platformScopes: readonly AdminScopeProfile[] = [],
): MvpSession {
  return {
    accessTokenExpiresAt: null,
    adminAccess: profile(adminScopes),
    adminPhone: "13800000001",
    adminToken: "admin-token",
    employeePhone: "13600000001",
    employeeToken: "employee-token",
    enterpriseId,
    enterpriseName: "企业 A",
    mode: "DEVELOPMENT",
    platformAccess: profile(platformScopes),
    platformToken: "platform-token",
    tenantId,
    tenantName: "集团 A",
  };
}

describe("navigation permission isolation", () => {
  it("does not inherit an enterprise RoleBinding from another enterprise", () => {
    const permissions = consoleNavigationPermissions(
      session([
        scope({
          enterprise: { id: enterpriseId, name: "企业 A" },
          permissions: ["material.read"],
          scopeId: enterpriseId,
          scopeType: "ENTERPRISE",
          tenant: { customerType: "GROUP", id: tenantId, name: "集团 A" },
        }),
        scope({
          enterprise: { id: "enterprise-b", name: "企业 B" },
          permissions: ["campaign.manage"],
          scopeId: "enterprise-b",
          scopeType: "ENTERPRISE",
          tenant: { customerType: "GROUP", id: tenantId, name: "集团 A" },
        }),
      ]),
    );

    expect(permissions).toEqual(["material.read"]);
  });

  it("applies a Tenant RoleBinding to the selected enterprise in that tenant", () => {
    const permissions = consoleNavigationPermissions(
      session([
        scope({
          inheritedEnterprises: [{ id: enterpriseId, name: "企业 A" }],
          permissions: ["campaign.read", "enterprise.membership.read"],
          scopeId: tenantId,
          scopeType: "TENANT",
          tenant: { customerType: "GROUP", id: tenantId, name: "集团 A" },
        }),
        scope({
          permissions: ["geo.manage"],
          scopeId: "tenant-b",
          scopeType: "TENANT",
          tenant: { customerType: "GROUP", id: "tenant-b", name: "集团 B" },
        }),
      ]),
    );

    expect(permissions).toEqual(["campaign.read", "enterprise.membership.read"]);
  });

  it("keeps platform permissions separate from console permissions", () => {
    const current = session(
      [
        scope({
          enterprise: { id: enterpriseId, name: "企业 A" },
          permissions: ["campaign.read"],
          scopeId: enterpriseId,
          scopeType: "ENTERPRISE",
          tenant: { customerType: "GROUP", id: tenantId, name: "集团 A" },
        }),
      ],
      [
        scope({
          permissions: ["platform.model.manage"],
          scopeId: "platform",
          scopeType: "PLATFORM",
        }),
        scope({
          enterprise: { id: enterpriseId, name: "企业 A" },
          permissions: ["material.manage"],
          scopeId: enterpriseId,
          scopeType: "ENTERPRISE",
          tenant: { customerType: "GROUP", id: tenantId, name: "集团 A" },
        }),
      ],
    );

    expect(consoleNavigationPermissions(current)).toEqual(["campaign.read"]);
    expect(platformNavigationPermissions(current)).toEqual(["platform.model.manage"]);
  });

  it("shows every effective role for the selected enterprise instead of the first profile scope", () => {
    const current = session([
      scope({
        inheritedEnterprises: [{ id: enterpriseId, name: "企业 A" }],
        permissions: ["tenant.dashboard.read"],
        role: { code: "TENANT_ADMIN", name: "集团主管理员" },
        scopeId: tenantId,
        scopeType: "TENANT",
        tenant: { customerType: "GROUP", id: tenantId, name: "集团 A" },
      }),
      scope({
        enterprise: { id: enterpriseId, name: "企业 A" },
        permissions: ["campaign.manage"],
        role: { code: "ENTERPRISE_ADMIN", name: "企业管理员" },
        scopeId: enterpriseId,
        scopeType: "ENTERPRISE",
        tenant: { customerType: "GROUP", id: tenantId, name: "集团 A" },
      }),
    ]);

    expect(adminEnterpriseContexts(current)).toEqual([
      expect.objectContaining({ roleName: "集团主管理员 + 企业管理员" }),
    ]);
    expect(selectedAdminRoleName(current)).toBe("集团主管理员 + 企业管理员");
  });
});

describe("API tab preloading", () => {
  it("reuses a prefetched GET response without showing tracked loading activity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: ["ready"] }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const preload = preloadApiRequest<{ items: string[] }>("/test/tab-preload", {
      token: "test-token",
    });
    expect(currentTrackedRequestCount()).toBe(0);

    await expect(
      apiRequest<{ items: string[] }>("/test/tab-preload", { token: "test-token" }),
    ).resolves.toEqual({ items: ["ready"] });
    await preload;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("API session recovery", () => {
  it("initializes a group without child enterprises and retains its context after refresh", async () => {
    const groupProfile = profile([
      scope({
        scopeId: "platform",
        scopeType: "PLATFORM",
        permissions: ["platform.settings.manage"],
      }),
      scope({
        scopeId: tenantId,
        scopeType: "TENANT",
        tenant: { id: tenantId, name: "集团 A", customerType: "GROUP" },
        permissions: ["tenant.enterprise.manage"],
      }),
    ]);
    const jsonResponse = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accessToken: "first-token", expiresInSeconds: 3600 }))
      .mockResolvedValueOnce(jsonResponse(groupProfile))
      .mockResolvedValueOnce(jsonResponse({ accessToken: "next-token", expiresInSeconds: 3600 }))
      .mockResolvedValueOnce(jsonResponse(groupProfile));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { localStorage: { setItem: vi.fn() } });
    try {
      const initialized = await initializeInstallation({
        username: "group_owner",
        name: "集团管理员",
        password: "Example-password123",
        organizationName: "集团 A",
        organizationType: "GROUP",
        installationToken: "fixture-installation-proof",
      });
      expect(initialized).toMatchObject({ tenantId, tenantName: "集团 A", enterpriseId: "" });
      expect(fetchMock.mock.calls[0]?.[0]).toContain("/auth/admin/installation");
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toMatchObject({
        organizationType: "GROUP",
      });
      await expect(refreshMvpSession(initialized)).resolves.toMatchObject({
        tenantId,
        tenantName: "集团 A",
        enterpriseId: "",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("renews once after a 401 and retries with the same idempotency key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Access token is invalid or expired" }), {
          headers: { "content-type": "application/json" },
          status: 401,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ saved: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const recovery = vi.fn().mockResolvedValue("renewed-token");
    const unregister = registerUnauthorizedRecovery(recovery);
    try {
      await expect(
        apiRequest("/test/session-recovery", {
          body: { value: "safe-retry" },
          method: "POST",
          token: "expired-token",
        }),
      ).resolves.toEqual({ saved: true });

      expect(recovery).toHaveBeenCalledOnce();
      expect(recovery).toHaveBeenCalledWith("expired-token");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      const retriedHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
      expect(firstHeaders.get("authorization")).toBe("Bearer expired-token");
      expect(retriedHeaders.get("authorization")).toBe("Bearer renewed-token");
      expect(retriedHeaders.get("idempotency-key")).toBe(firstHeaders.get("idempotency-key"));
    } finally {
      unregister();
      vi.unstubAllGlobals();
    }
  });
});
