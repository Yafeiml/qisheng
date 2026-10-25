import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { GenerationStatusService } from "./generation-status.service";

function fixture(scope: object = { type: "TENANT", tenantId: "tenant" }) {
  const prisma = {
    enterprise: { findMany: vi.fn().mockResolvedValue([{ id: "e1" }, { id: "e2" }, { id: "e3" }]) },
    modelRoute: {
      findMany: vi.fn().mockResolvedValue([
        { id: "platform", scopeType: "PLATFORM", scopeId: "platform", enterpriseId: null },
        { id: "tenant-route", scopeType: "TENANT", scopeId: "tenant", enterpriseId: null },
        { id: "enterprise-route", scopeType: "ENTERPRISE", scopeId: "e1", enterpriseId: "e1" },
      ]),
    },
  };
  const qualifications = {
    runtimeHealthForRoutes: vi.fn().mockResolvedValue(
      new Map([
        ["tenant-route", { state: "REVALIDATION_REQUIRED", notificationStatus: "SENT" }],
        ["enterprise-route", { state: "HEALTHY", notificationStatus: null }],
      ]),
    ),
  };
  const service = new GenerationStatusService(
    prisma as never,
    { requireSaasAdmin: () => ({ scope }) } as never,
    qualifications as never,
  );
  return { service, prisma, qualifications };
}

describe("organization generation status", () => {
  it("batches inherited routes and counts only affected enterprises without exposing provider details", async () => {
    const f = fixture();
    const result = await f.service.current("tenant");
    expect(result.affectedEnterpriseCount).toBe(2);
    expect(result.notices).toEqual([
      expect.objectContaining({
        notificationStatus: "SENT",
        affectedEnterpriseCount: 2,
        message: expect.stringContaining("已通知平台管理员"),
      }),
    ]);
    expect(f.qualifications.runtimeHealthForRoutes).toHaveBeenCalledWith([
      "enterprise-route",
      "tenant-route",
    ]);
    expect(f.prisma.enterprise.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant", status: "ACTIVE" } }),
    );
    expect(JSON.stringify(result)).not.toContain("tenant-route");
  });
  it("rejects cross-tenant and cross-enterprise access before reading any data", async () => {
    const f = fixture({ type: "ENTERPRISE", tenantId: "tenant", enterpriseId: "e1" });
    await expect(f.service.current("other", "e1")).rejects.toThrow();
    await expect(f.service.current("tenant", "e2")).rejects.toThrow();
    await expect(f.service.current("tenant")).rejects.toThrow();
    expect(f.prisma.enterprise.findMany).not.toHaveBeenCalled();
  });
  it("scopes enterprise reads and never claims an undelivered notification was sent", async () => {
    const f = fixture({ type: "ENTERPRISE", tenantId: "tenant", enterpriseId: "e1" });
    f.prisma.enterprise.findMany.mockResolvedValue([{ id: "e1" }]);
    f.qualifications.runtimeHealthForRoutes.mockResolvedValue(
      new Map([
        ["enterprise-route", { state: "REVALIDATION_REQUIRED", notificationStatus: "FAILED" }],
      ]),
    );
    const result = await f.service.current("tenant", "e1");
    expect(result.affectedEnterpriseCount).toBe(1);
    expect(result.notices[0]?.message).not.toContain("已通知");
    expect(f.prisma.enterprise.findMany.mock.calls[0]?.[0].where).toMatchObject({
      tenantId: "tenant",
      id: "e1",
    });
  });
});
