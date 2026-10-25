import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { OrganizationApplicationService } from "./organization-application.service";

function fixture() {
  const principal = { userId: "owner", scope: { type: "TENANT", tenantId: "tenant" } };
  const transaction = {
    tenant: { findFirst: vi.fn().mockResolvedValue({ id: "tenant", customerType: "GROUP" }) },
    enterprise: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(async ({ data }) => ({ id: "enterprise", status: "ACTIVE", ...data })),
    },
    auditLog: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    adminUser: { create: vi.fn() },
    roleBinding: { create: vi.fn() },
  };
  const prisma = {
    enterprise: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (run) => run(transaction)),
  };
  const capacity = vi.fn().mockResolvedValue(undefined);
  const service = Object.assign(Object.create(OrganizationApplicationService.prototype), {
    accessContext: { requireSaasAdmin: () => principal },
    capabilities: { assertEnterpriseCapacityIfConfigured: capacity },
    industries: { assertAvailable: vi.fn().mockResolvedValue(undefined) },
    prisma,
  }) as OrganizationApplicationService;
  return { service, transaction, prisma, principal, capacity };
}

describe("administrator-managed enterprises", () => {
  it("refuses the retired phone-only administrator option before creating anything", async () => {
    const { service, transaction, prisma } = fixture();
    await expect(
      service.createEnterprise("tenant", { name: "示例企业", administratorPhone: "13900000001" }),
    ).rejects.toThrow("账号管理");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(transaction.adminUser.create).not.toHaveBeenCalled();
  });

  it("creates a child enterprise with its capacity check and audit, without making login accounts", async () => {
    const { service, transaction, capacity } = fixture();
    await expect(service.createEnterprise("tenant", { name: "示例企业" })).resolves.toMatchObject({
      id: "enterprise",
      name: "示例企业",
      code: expect.stringMatching(/^ENT_[A-F0-9]{32}$/u),
    });
    expect(capacity).toHaveBeenCalledWith("tenant", 1, transaction);
    expect(transaction.auditLog.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          action: "enterprise.create",
          actorUserId: "owner",
          tenantId: "tenant",
          stateAfter: expect.objectContaining({ administratorAssigned: false }),
        }),
      ],
    });
    expect(transaction.adminUser.create).not.toHaveBeenCalled();
    expect(transaction.roleBinding.create).not.toHaveBeenCalled();
  });

  it("keeps the single-enterprise limit", async () => {
    const { service, transaction } = fixture();
    transaction.tenant.findFirst.mockResolvedValue({
      id: "tenant",
      customerType: "SINGLE_ENTERPRISE",
    });
    transaction.enterprise.count.mockResolvedValue(1);
    await expect(service.createEnterprise("tenant", { name: "另一家企业" })).rejects.toThrow(
      "single-enterprise",
    );
    expect(transaction.enterprise.create).not.toHaveBeenCalled();
  });

  it("rejects a foreign tenant before opening a transaction", async () => {
    const { service, prisma } = fixture();
    await expect(
      service.createEnterprise("another-tenant", { name: "示例企业" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a missing or inactive root organization", async () => {
    const { service, transaction } = fixture();
    transaction.tenant.findFirst.mockResolvedValue(null);
    await expect(service.createEnterprise("tenant", { name: "示例企业" })).rejects.toMatchObject({
      status: 404,
    });
    expect(transaction.enterprise.create).not.toHaveBeenCalled();
  });

  it("does not bypass the configured enterprise capacity", async () => {
    const { service, transaction, capacity } = fixture();
    capacity.mockRejectedValue(new Error("capacity exceeded"));
    await expect(service.createEnterprise("tenant", { name: "示例企业" })).rejects.toThrow(
      "capacity exceeded",
    );
    expect(transaction.enterprise.create).not.toHaveBeenCalled();
  });
});
