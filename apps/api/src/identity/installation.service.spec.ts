import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { Prisma } from "@xhs-agentic/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedAuthorizationCatalog } from "../access/authorization.seed";
import { seedRuntimePolicy } from "../model-configuration/runtime-policy.seed";
import { OrganizationApplicationService } from "../organization/organization-application.service";
import { seedPlatformSettings } from "../platform-settings/platform-settings.seed";
import type { InitializeInstallationDto } from "./admin-auth.dto";
import { AdminAuthenticationService } from "./admin-auth.service";
import { verifyPassword } from "./password";

vi.mock("../access/authorization.seed", () => ({ seedAuthorizationCatalog: vi.fn() }));
vi.mock("../model-configuration/runtime-policy.seed", () => ({ seedRuntimePolicy: vi.fn() }));
vi.mock("../platform-settings/platform-settings.seed", () => ({ seedPlatformSettings: vi.fn() }));

function fixture() {
  const installationToken = randomBytes(32).toString("base64");
  vi.stubEnv("INSTALLATION_TOKEN", installationToken);
  const input: InitializeInstallationDto = {
    username: "owner",
    password: "Example-password-2026",
    name: "管理员",
    organizationName: "示例企业",
    organizationType: "SINGLE_ENTERPRISE",
    installationToken,
  };
  let users = 0;
  let tenants = 0;
  let pending = Promise.resolve<unknown>(undefined);
  const settings = new Map<string, Record<string, unknown>>();
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    adminUser: {
      count: vi.fn(async () => users),
      create: vi.fn(async ({ data }) => {
        users++;
        return { id: "owner-id", ...data };
      }),
    },
    tenant: {
      count: vi.fn(async () => tenants),
      create: vi.fn(async ({ data }) => {
        tenants++;
        return { id: "tenant-id", ...data };
      }),
    },
    enterprise: { create: vi.fn().mockResolvedValue({ id: "enterprise-id" }) },
    tenantCapabilityPolicy: { create: vi.fn().mockResolvedValue({}) },
    platformSetting: {
      upsert: vi.fn(async ({ where, create, update }) => {
        const existing = settings.get(where.key);
        const value = existing ? { ...existing, ...update } : create;
        settings.set(where.key, value);
        return value;
      }),
    },
    role: {
      findMany: vi.fn().mockResolvedValue(
        ["PLATFORM_ADMIN", "TENANT_ADMIN", "ENTERPRISE_ADMIN"].map((code) => ({
          id: code,
          code,
        })),
      ),
    },
    roleBinding: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const createSession = vi.fn().mockResolvedValue({ sessionId: "session-id" });
  const prisma = {
    adminUser: tx.adminUser,
    tenant: tx.tenant,
    $transaction: vi.fn((run) => {
      const result = pending.then(() => run(tx));
      pending = result.catch(() => undefined);
      return result;
    }),
  };
  const service = Object.assign(Object.create(AdminAuthenticationService.prototype), {
    prisma,
    createSession,
  }) as AdminAuthenticationService;
  return { service, prisma, tx, input, createSession, settings };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("one-time self-hosted installation", () => {
  it("seeds real platform defaults and encrypts configured fixture secrets with an independent key", async () => {
    vi.stubEnv("MODEL_CREDENTIAL_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("MODEL_CREDENTIAL_ENCRYPTION_KEY_VERSION", "installation-test-v1");
    vi.stubEnv("OBJECT_STORAGE_ACCESS_KEY", "fixture-access-key");
    vi.stubEnv("OBJECT_STORAGE_SECRET_KEY", "fixture-storage-secret");
    const { seedPlatformSettings: seed } = await vi.importActual<
      typeof import("../platform-settings/platform-settings.seed")
    >("../platform-settings/platform-settings.seed");
    const upsert = vi.fn().mockResolvedValue({});
    await seed({ platformSetting: { upsert } } as unknown as Prisma.TransactionClient);
    const secret = upsert.mock.calls.find(
      ([input]) => input.where.key === "storage.secret_access_key",
    )?.[0].create;
    expect(secret).toMatchObject({ keyVersion: "installation-test-v1", value: undefined });
    expect(secret?.ciphertext).toBeInstanceOf(Uint8Array);
    expect(JSON.stringify(upsert.mock.calls)).not.toContain("fixture-storage-secret");
  });

  it("refuses creating another root organization through the old platform endpoint", async () => {
    const transaction = vi.fn();
    const organizations = Object.assign(Object.create(OrganizationApplicationService.prototype), {
      accessContext: { requireSaasAdmin: () => ({ scope: { type: "PLATFORM" } }) },
      prisma: { $transaction: transaction },
    }) as OrganizationApplicationService;
    await expect(
      organizations.createTenant({ name: "另一个集团", customerType: "GROUP" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "refuses public registration, including invitations (%s)",
    async (invite) => {
      const { service, prisma } = fixture();
      await expect(
        service.register(
          {
            username: "employee",
            password: "Employee-password-2026",
            name: "员工",
            workspaceName: "不可创建的工作空间",
            invitationToken: invite ? "a".repeat(43) : undefined,
          },
          "192.0.2.3",
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("reports an empty installation without exposing any credential", async () => {
    const { service, input } = fixture();
    const status = await service.installationStatus();
    expect(status).toEqual({ initialized: false });
    expect(JSON.stringify(status)).not.toContain(input.installationToken);
  });

  it.each(["administrator", "organization"])(
    "treats an existing %s as initialized",
    async (kind) => {
      const { service, tx } = fixture();
      (kind === "administrator" ? tx.adminUser.count : tx.tenant.count).mockResolvedValue(1);
      await expect(service.installationStatus()).resolves.toEqual({ initialized: true });
    },
  );

  it.each(["missing", "weak", "incorrect"])(
    "rejects a %s installation credential before database work",
    async (kind) => {
      const { service, input, prisma } = fixture();
      if (kind === "missing") vi.stubEnv("INSTALLATION_TOKEN", "");
      if (kind === "weak") vi.stubEnv("INSTALLATION_TOKEN", "short");
      if (kind === "incorrect") input.installationToken = randomBytes(32).toString("base64");
      await expect(service.initializeInstallation(input)).rejects.toMatchObject({
        status: kind === "incorrect" ? 401 : 503,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("creates one enterprise, strong password and scoped administrator bindings", async () => {
    const { service, input, tx, createSession } = fixture();
    await expect(service.initializeInstallation(input, "test-browser")).resolves.toEqual({
      sessionId: "session-id",
    });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.adminUser.count.mock.invocationCallOrder[0] ?? 0,
    );
    expect(seedAuthorizationCatalog).toHaveBeenCalledWith(tx);
    expect(seedRuntimePolicy).toHaveBeenCalledWith(tx);
    expect(seedPlatformSettings).toHaveBeenCalledWith(tx);
    expect(tx.platformSetting.upsert).toHaveBeenCalledWith({
      where: { key: "storage.provider" },
      create: {
        key: "storage.provider",
        group: "STORAGE",
        valueType: "ENUM",
        value: "LOCAL",
        updatedBy: "system:installation",
      },
      update: {},
    });
    expect(tx.platformSetting.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(seedPlatformSettings).mock.invocationCallOrder[0] ?? 0,
    );
    expect(tx.tenant.create).toHaveBeenCalledWith({
      data: { name: input.organizationName, customerType: "SINGLE_ENTERPRISE" },
    });
    expect(tx.enterprise.create).toHaveBeenCalledOnce();
    expect(tx.roleBinding.create.mock.calls.map(([{ data }]) => data.roleId)).toEqual([
      "ENTERPRISE_ADMIN",
      "PLATFORM_ADMIN",
    ]);
    const [creation] = tx.adminUser.create.mock.calls;
    if (!creation) throw new Error("Expected one administrator creation");
    const saved = creation[0].data;
    expect(saved.passwordHash).not.toBe(input.password);
    await expect(verifyPassword(input.password, saved.passwordHash)).resolves.toBe(true);
    expect(createSession).toHaveBeenCalledWith("owner-id", "test-browser");
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(input.password);
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(input.installationToken);
  });

  it("creates a group without inventing child enterprises", async () => {
    const { service, input, tx } = fixture();
    input.organizationType = "GROUP";
    await service.initializeInstallation(input);
    expect(tx.tenant.create).toHaveBeenCalledWith({
      data: { name: input.organizationName, customerType: "GROUP" },
    });
    expect(tx.enterprise.create).not.toHaveBeenCalled();
    expect(tx.roleBinding.create).toHaveBeenCalledWith({
      data: {
        userId: "owner-id",
        roleId: "TENANT_ADMIN",
        scopeType: "TENANT",
        scopeId: "tenant-id",
        tenantId: "tenant-id",
      },
    });
  });

  it("keeps an explicit existing storage provider and credentials", async () => {
    const { service, input, settings } = fixture();
    settings.set("storage.provider", { value: "S3", updatedBy: "existing-admin" });
    const secret = { ciphertext: randomBytes(32), keyVersion: "existing-key" };
    settings.set("storage.secret_access_key", secret);
    await service.initializeInstallation(input);
    expect(settings.get("storage.provider")).toEqual({
      value: "S3",
      updatedBy: "existing-admin",
    });
    expect(settings.get("storage.secret_access_key")).toBe(secret);
  });

  it("does not create accounts or issue a session when the local storage default cannot persist", async () => {
    const { service, input, tx, createSession } = fixture();
    tx.platformSetting.upsert.mockRejectedValueOnce(new Error("storage default write failed"));
    await expect(service.initializeInstallation(input)).rejects.toThrow(
      "storage default write failed",
    );
    expect(tx.adminUser.create).not.toHaveBeenCalled();
    expect(tx.tenant.create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each(["administrator", "organization"])("never overwrites an existing %s", async (kind) => {
    const { service, input, tx } = fixture();
    (kind === "administrator" ? tx.adminUser.count : tx.tenant.count).mockResolvedValue(1);
    await expect(service.initializeInstallation(input)).rejects.toMatchObject({ status: 409 });
    expect(tx.adminUser.create).not.toHaveBeenCalled();
    expect(tx.tenant.create).not.toHaveBeenCalled();
    expect(seedAuthorizationCatalog).not.toHaveBeenCalled();
    expect(tx.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it("allows only one creation when installation requests are serialized by the database lock", async () => {
    const { service, input, tx } = fixture();
    const results = await Promise.allSettled([
      service.initializeInstallation(input),
      service.initializeInstallation({ ...input, username: "second-owner" }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(tx.adminUser.create).toHaveBeenCalledOnce();
    expect(tx.tenant.create).toHaveBeenCalledOnce();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });
});
