import "reflect-metadata";
import { Prisma } from "@xhs-agentic/database";
import { describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import { ADMIN_ACCESS_REQUIREMENT } from "../access/require-admin-access.decorator";
import type { PrismaService } from "../database/prisma.service";
import { IDEMPOTENT_OPERATION } from "../http/idempotent.decorator";
import { EmployeeWebInvitationController } from "./employee-web.controller";
import { EmployeeWebService } from "./employee-web.service";
import { verifyPassword } from "./password";

const input = { username: "Employee.One", password: "Example-password123" };

function fixture() {
  const actor = {
    userId: "admin",
    scope: { type: "ENTERPRISE", tenantId: "tenant", enterpriseId: "enterprise" },
  };
  const tx = {
    enterpriseMembership: {
      findFirst: vi.fn().mockResolvedValue({ id: "member", name: "示例员工" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    globalUser: { create: vi.fn().mockResolvedValue({ id: "employee" }) },
    adminUser: { create: vi.fn().mockResolvedValue({ id: "account" }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const transaction = vi.fn(async (run) => run(tx));
  const service = new EmployeeWebService(
    { $transaction: transaction } as unknown as PrismaService,
    {} as never,
    {} as never,
    { requireSaasAdmin: () => actor } as unknown as RequestAccessContext,
  );
  return { service, actor, tx, transaction };
}

describe("administrator-created employee web accounts", () => {
  it("requires the existing membership management permission and idempotency", () => {
    const method = EmployeeWebInvitationController.prototype.createAccount;
    expect(Reflect.getMetadata(ADMIN_ACCESS_REQUIREMENT, method)).toEqual({
      scope: "ENTERPRISE",
      permissions: ["enterprise.membership.manage"],
    });
    expect(Reflect.getMetadata(IDEMPOTENT_OPERATION, method)).toBe(true);
  });

  it("hashes the new password and atomically binds only the administrator's enabled member", async () => {
    const { service, tx, transaction } = fixture();
    const result = await service.createAccount("member", input);
    expect(result).toEqual({ userId: "account", username: "employee.one", membershipId: "member" });
    expect(transaction).toHaveBeenCalledOnce();
    const created = tx.adminUser.create.mock.calls[0]?.[0].data;
    expect(created).toMatchObject({
      username: "employee.one",
      name: "示例员工",
      employeeUserId: "employee",
    });
    expect(await verifyPassword(input.password, created.passwordHash)).toBe(true);
    expect(created.passwordHash).not.toBe(input.password);
    expect(tx.enterpriseMembership.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "member",
        tenantId: "tenant",
        enterpriseId: "enterprise",
        globalUserId: null,
        seatStatus: "ENABLED",
        status: { in: ["ACTIVE", "PENDING_BIND"] },
        enterprise: { status: "ACTIVE" },
        tenant: { status: "ACTIVE" },
      }),
      data: expect.objectContaining({
        globalUserId: "employee",
        status: "ACTIVE",
        webInvitationHash: null,
        webInvitationExpiresAt: null,
      }),
    });
    expect(JSON.stringify({ result, audit: tx.auditLog.create.mock.calls })).not.toContain(
      input.password,
    );
    expect(JSON.stringify({ result, audit: tx.auditLog.create.mock.calls })).not.toContain(
      "scrypt$",
    );
  });

  it("rejects a non-enterprise scope before starting a transaction", async () => {
    const { service, actor, transaction } = fixture();
    actor.scope.type = "TENANT";
    await expect(service.createAccount("member", input)).rejects.toThrow("企业范围");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not create an account when the member does not match scope and eligibility", async () => {
    const { service, tx } = fixture();
    tx.enterpriseMembership.findFirst.mockResolvedValue(null);
    await expect(service.createAccount("member", input)).rejects.toThrow("成员不存在");
    expect(tx.globalUser.create).not.toHaveBeenCalled();
    expect(tx.adminUser.create).not.toHaveBeenCalled();
  });

  it("aborts without an audit when member eligibility changes during the transaction", async () => {
    const { service, tx } = fixture();
    tx.enterpriseMembership.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.createAccount("member", input)).rejects.toThrow("成员状态已变化");
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("translates a duplicate username without exposing the database error", async () => {
    const { service, tx } = fixture();
    tx.adminUser.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique username", {
        code: "P2002",
        clientVersion: "7.10.0",
        meta: { target: ["username"] },
      }),
    );
    await expect(service.createAccount("member", input)).rejects.toThrow("账号已存在");
    expect(tx.enterpriseMembership.updateMany).not.toHaveBeenCalled();
  });

  it("rejects weak passwords before creating database records", async () => {
    const { service, transaction } = fixture();
    await expect(service.createAccount("member", { ...input, password: "short" })).rejects.toThrow(
      "密码须为",
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not issue new self-registration invitations", async () => {
    const { service, transaction } = fixture();
    await expect(service.invitation("member")).rejects.toThrow("自助注册已关闭");
    expect(transaction).not.toHaveBeenCalled();
  });
});
