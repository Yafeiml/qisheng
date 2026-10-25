import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignService } from "./campaign.service";

const now = new Date("2026-10-15T10:00:00Z");

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const task = {
    id: "task",
    tenantId: "tenant",
    enterpriseId: "enterprise",
    membershipId: "member",
    membership: { publisherContext: null },
    employeeContentId: "content",
    status: "AVAILABLE",
    visibleAt: new Date(now.getTime() - 1000),
    expiresAt: new Date(now.getTime() + 3600_000),
    campaign: {
      id: "campaign",
      title: "门店日常",
      status: "ACTIVE",
      selectionSnapshot: null as Record<string, unknown> | null,
    },
    enterprise: { id: "enterprise", name: "示例门店" },
    employeeContent: {
      revision: 2,
      title: "门店日常",
      body: "今天整理了门店的展示区。",
      hashtags: ["工作日常"],
      riskAssessment: { passed: true, unresolvedBlocks: [] as string[] },
      synthetic: false,
      images: [],
    },
    factsConfirmedAt: null as Date | null,
    factsConfirmedRevision: null as number | null,
    factsReturnedAt: null as Date | null,
    factsReturnReason: null as string | null,
    copiedAt: null as Date | null,
    downloadedAt: null as Date | null,
    registry: null,
    submissions: [],
  };
  const tx = {
    distributionTask: {
      updateMany: vi.fn().mockImplementation(async ({ data }) => {
        Object.assign(task, data);
        return { count: 1 };
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const findFirst = vi.fn().mockResolvedValue(task);
  const service = Object.assign(Object.create(CampaignService.prototype), {
    accessContext: {
      requireEmployee: () => ({ userId: "employee-user", membershipIds: ["member"] }),
    },
    reconcileEmployeeTasks: vi.fn().mockResolvedValue(undefined),
    imageDelivery: { signImages: vi.fn().mockResolvedValue([]) },
    prisma: {
      distributionTask: { findFirst, updateMany: tx.distributionTask.updateMany },
      $transaction: vi.fn(async (run) => run(tx)),
    },
  }) as CampaignService;
  return { service, task, tx, findFirst };
}

afterEach(() => vi.useRealTimers());

describe("employee confirmation for generic campaigns", () => {
  it("records a generic task's current revision and the employee audit instead of requiring a medical plan", async () => {
    const { service, task, tx } = fixture();
    await expect(
      service.confirmEmployeeFacts("task", { revision: 2, confirmed: true }),
    ).resolves.toMatchObject({
      id: "task",
      contentRevision: 2,
      contentVisible: true,
      factsConfirmationRequired: true,
      factsConfirmed: true,
    });
    expect(task.factsConfirmedAt).toEqual(now);
    expect(task.factsConfirmedRevision).toBe(2);
    expect(tx.distributionTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "task",
          membershipId: { in: ["member"] },
          status: "AVAILABLE",
          employeeContent: { revision: 2 },
          visibleAt: { lte: now },
          expiresAt: { gt: now },
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "employee-content.facts-confirmed",
        actorUserId: "employee-user",
        resourceId: "content",
        stateAfter: { revision: 2, confirmed: true },
      }),
    });
  });

  it("requires task ownership before confirming", async () => {
    const { service, tx, findFirst } = fixture();
    findFirst.mockResolvedValue(null);
    await expect(
      service.confirmEmployeeFacts("someone-elses-task", { revision: 2, confirmed: true }),
    ).rejects.toThrow("authenticated user");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "someone-elses-task", membershipId: { in: ["member"] } },
      }),
    );
    expect(tx.distributionTask.updateMany).not.toHaveBeenCalled();
  });

  it.each(["stale", "locked", "expired", "completed", "blocked", "malformed-medical"])(
    "rejects %s tasks without recording a confirmation",
    async (scenario) => {
      const { service, task, tx } = fixture();
      if (scenario === "locked") task.visibleAt = new Date(now.getTime() + 1000);
      if (scenario === "expired") task.expiresAt = now;
      if (scenario === "completed") task.status = "COMPLETED";
      if (scenario === "blocked") task.employeeContent.riskAssessment.unresolvedBlocks = ["unsafe"];
      if (scenario === "malformed-medical")
        task.campaign.selectionSnapshot = { schemaVersion: "old-poster" };
      await expect(
        service.confirmEmployeeFacts("task", {
          revision: scenario === "stale" ? 1 : 2,
          confirmed: true,
        }),
      ).rejects.toThrow();
      expect(tx.distributionTask.updateMany).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("allows returning a generic task and requires a new content version before reconfirming", async () => {
    const { service, task, tx } = fixture();
    await service.confirmEmployeeFacts("task", {
      revision: 2,
      confirmed: false,
      reason: "FACTS_MISMATCH",
    });
    expect(task.factsReturnedAt).toEqual(now);
    expect(tx.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: "employee-content.facts-returned",
        reason: "FACTS_MISMATCH",
      }),
    });
    await expect(
      service.confirmEmployeeFacts("task", { revision: 2, confirmed: true }),
    ).rejects.toThrow("已退回");
    task.employeeContent.revision = 3;
    await service.confirmEmployeeFacts("task", { revision: 3, confirmed: true });
    expect(task.factsReturnedAt).toBeNull();
    expect(task.factsConfirmedRevision).toBe(3);
  });

  it("does not audit confirmation when the task changes during the guarded update", async () => {
    const { service, tx } = fixture();
    tx.distributionTask.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.confirmEmployeeFacts("task", { revision: 2, confirmed: true }),
    ).rejects.toThrow("任务状态已变化");
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed generic task as requiring confirmation", async () => {
    const { service } = fixture();
    await expect(service.getEmployeeTask("task")).resolves.toMatchObject({
      factsConfirmationRequired: true,
      factsConfirmed: false,
      factsReturned: false,
    });
  });

  describe.each(["COPY", "DOWNLOAD"] as const)("%s permission", (type) => {
    it.each(["unconfirmed", "returned", "changed-version", "stale-request", "missing-revision"])(
      "rejects a generic task with %s facts before recording an event",
      async (scenario) => {
        const { service, task, tx } = fixture();
        task.factsConfirmedAt = now;
        task.factsConfirmedRevision = 2;
        if (scenario === "unconfirmed") task.factsConfirmedAt = null;
        if (scenario === "returned") task.factsReturnedAt = now;
        if (scenario === "changed-version") task.employeeContent.revision = 3;
        const revision =
          scenario === "missing-revision"
            ? undefined
            : scenario === "stale-request"
              ? 1
              : task.employeeContent.revision;
        await expect(service.recordEmployeeTaskEvent("task", { type, revision })).rejects.toThrow();
        expect(tx.distributionTask.updateMany).not.toHaveBeenCalled();
      },
    );

    it("allows the latest confirmed generic version and guards the database update", async () => {
      const { service, task, tx } = fixture();
      await service.confirmEmployeeFacts("task", { revision: 2, confirmed: true });
      tx.distributionTask.updateMany.mockClear();
      await expect(
        service.recordEmployeeTaskEvent("task", { type, revision: 2 }),
      ).resolves.toMatchObject({ factsConfirmed: true });
      expect(tx.distributionTask.updateMany).toHaveBeenCalledWith({
        data: type === "COPY" ? { copiedAt: now } : { downloadedAt: now },
        where: expect.objectContaining({
          employeeContent: { revision: 2 },
          factsConfirmedAt: { not: null },
          factsConfirmedRevision: 2,
          factsReturnedAt: null,
        }),
      });
      expect(type === "COPY" ? task.copiedAt : task.downloadedAt).toEqual(now);
    });

    it("rejects a confirmation or version change during the conditional update", async () => {
      const { service, task, tx } = fixture();
      task.factsConfirmedAt = now;
      task.factsConfirmedRevision = 2;
      tx.distributionTask.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.recordEmployeeTaskEvent("task", { type, revision: 2 })).rejects.toThrow(
        "任务或内容已变化",
      );
    });
  });
});
