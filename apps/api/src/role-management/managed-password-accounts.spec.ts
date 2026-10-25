import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import { verifyPassword } from "../identity/password";
import { type CreateAdminUserDto, GrantScopeType } from "./role-management.dto";
import { RoleManagementService } from "./role-management.service";

const password = "Example-password123";

function fixture() {
  const actor = {
    userId: "owner",
    scope: { type: "ENTERPRISE", tenantId: "tenant", enterpriseId: "enterprise" },
    permissions: ["enterprise.role.manage", "enterprise.material.read"],
  };
  const user = {
    id: "account",
    username: "operator.one",
    name: "运营人员",
    email: null,
    phone: null,
    status: "ACTIVE",
    adminSessions: [],
    organizationProfiles: [],
    roleBindings: [],
  };
  const role = {
    id: "role",
    code: "CONTENT_OPERATOR",
    scopeType: "ENTERPRISE",
    permissions: [{ permission: { code: "enterprise.material.read" } }],
  };
  const tx = {
    role: {
      findMany: vi.fn().mockResolvedValue([role]),
      findFirst: vi.fn().mockResolvedValue(role),
    },
    adminUser: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(user),
      update: vi.fn().mockResolvedValue(user),
      findUniqueOrThrow: vi.fn().mockResolvedValue(user),
    },
    adminOrganizationProfile: { upsert: vi.fn().mockResolvedValue({}) },
    roleBinding: {
      upsert: vi.fn().mockResolvedValue({ id: "binding" }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "binding",
        createdAt: new Date(),
        role: { code: "PLATFORM_ADMIN" },
        user,
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const transaction = vi.fn(async (run) => run(tx));
  const service = new RoleManagementService(
    { $transaction: transaction } as unknown as PrismaService,
    { requireSaasAdmin: () => actor } as unknown as RequestAccessContext,
  );
  const input: CreateAdminUserDto = {
    username: "Operator.One",
    password,
    name: "运营人员",
    scopeType: GrantScopeType.ENTERPRISE,
    enterpriseId: "enterprise",
    roleCodes: [role.code],
  };
  const create = () => service.createAdminUserFromEnterprise("tenant", "enterprise", input);
  return { service, actor, user, role, tx, input, create, transaction };
}

describe("managed administrator password accounts", () => {
  it("creates an account with a hashed password and keeps password material out of responses and audit", async () => {
    const { create, tx } = fixture();
    const result = await create();
    const data = tx.adminUser.create.mock.calls[0]?.[0].data;
    expect(data.username).toBe("operator.one");
    expect(await verifyPassword(password, data.passwordHash)).toBe(true);
    expect(JSON.stringify({ result, audit: tx.auditLog.create.mock.calls })).not.toContain(
      password,
    );
    expect(JSON.stringify({ result, audit: tx.auditLog.create.mock.calls })).not.toContain(
      "scrypt$",
    );
    expect(tx.roleBinding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: "account",
          roleId: "role",
          tenantId: "tenant",
          enterpriseId: "enterprise",
        }),
      }),
    );
  });

  it("can create an additional platform administrator through the existing protected grant", async () => {
    const { service, actor, tx } = fixture();
    actor.scope.type = "PLATFORM";
    await expect(
      service.grantPlatformAdministrator({
        username: "operator.one",
        password,
        name: "系统管理员",
      }),
    ).resolves.toMatchObject({ userId: "account", username: "operator.one" });
    expect(
      await verifyPassword(password, tx.adminUser.create.mock.calls[0]?.[0].data.passwordHash),
    ).toBe(true);
  });

  it("rejects an unknown account without a new password", async () => {
    const { input, create, tx } = fixture();
    delete input.password;
    await expect(create()).rejects.toThrow("新增账号时请设置登录密码");
    expect(tx.adminUser.create).not.toHaveBeenCalled();
  });

  it("never overwrites an existing account's password through an authorization request", async () => {
    const { create, tx, user } = fixture();
    tx.adminUser.findUnique.mockResolvedValue({ ...user, passwordHash: "existing-hash" });
    await expect(create()).rejects.toThrow("授权时请留空密码");
    expect(tx.adminUser.update).not.toHaveBeenCalled();
    expect(tx.roleBinding.upsert).not.toHaveBeenCalled();
  });

  it("still grants an existing password account when the password is omitted", async () => {
    const { input, create, tx, user } = fixture();
    delete input.password;
    tx.adminUser.findUnique.mockResolvedValue({ ...user, passwordHash: "existing-hash" });
    await expect(create()).resolves.toMatchObject({ username: "operator.one" });
    expect(tx.adminUser.create).not.toHaveBeenCalled();
    expect(tx.adminUser.update).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ passwordHash: expect.anything() }),
      where: expect.anything(),
    });
  });

  it("rejects weak new passwords before creating an account", async () => {
    const { input, create, tx } = fixture();
    input.password = "weak";
    await expect(create()).rejects.toThrow("密码须为");
    expect(tx.adminUser.create).not.toHaveBeenCalled();
  });

  it("keeps role permission escalation checks ahead of account creation", async () => {
    const { create, role, tx } = fixture();
    role.permissions.push({ permission: { code: "platform.access.manage" } });
    await expect(create()).rejects.toThrow("permissions you do not hold");
    expect(tx.adminUser.create).not.toHaveBeenCalled();
  });

  it("rejects a different enterprise before starting a transaction", async () => {
    const { create, actor, transaction } = fixture();
    actor.scope.enterpriseId = "other-enterprise";
    await expect(create()).rejects.toThrow("scope");
    expect(transaction).not.toHaveBeenCalled();
  });
});
