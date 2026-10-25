import { describe, expect, it, vi } from "vitest";
import { CampaignService } from "./campaign.service";

function fixture() {
  const transaction = {
    campaign: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ status: "GENERATION_FAILED", visibleAt: new Date("2099-01-01") }),
    },
    generationWorkItem: { count: vi.fn().mockResolvedValue(3) },
    generationRun: { count: vi.fn().mockResolvedValue(1) },
    distributionTask: { count: vi.fn(async ({ where }): Promise<number> => (where.OR ? 0 : 2)) },
  };
  const service = Object.assign(Object.create(CampaignService.prototype), {
    prisma: { $transaction: vi.fn((run) => run(transaction)) },
    accessContext: {
      requireSaasAdmin: () => ({
        scope: { type: "ENTERPRISE", tenantId: "tenant", enterpriseId: "enterprise" },
      }),
    },
  }) as CampaignService;
  return { service, transaction };
}

describe("campaign cancellation task impact preview", () => {
  it("counts affected work without changing any business state", async () => {
    const { service, transaction } = fixture();
    const result = await service.getCancellationPreview(
      { tenantId: "tenant", enterpriseId: "enterprise" },
      "campaign",
    );
    expect(result).toEqual({
      cancelledWorkItems: 3,
      cancelledGenerationRuns: 1,
      cancelledDistributionTasks: 2,
    });
    expect(transaction.generationWorkItem.count).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant",
        enterpriseId: "enterprise",
        campaignId: "campaign",
        status: { in: ["QUEUED", "RUNNING"] },
      },
    });
  });
  it("rejects requests outside the active enterprise scope", async () => {
    const { service, transaction } = fixture();
    await expect(
      service.getCancellationPreview({ tenantId: "other", enterpriseId: "enterprise" }, "campaign"),
    ).rejects.toThrow("Active request scope");
    expect(transaction.campaign.findFirst).not.toHaveBeenCalled();
  });
  it("does not produce a zero preview for an inaccessible campaign", async () => {
    const { service, transaction } = fixture();
    transaction.campaign.findFirst.mockResolvedValue(null);
    await expect(
      service.getCancellationPreview({ tenantId: "tenant", enterpriseId: "enterprise" }, "missing"),
    ).rejects.toThrow("Campaign was not found");
  });
  it("rejects a preview when an employee already received its content", async () => {
    const { service, transaction } = fixture();
    transaction.distributionTask.count.mockResolvedValue(1);
    await expect(
      service.getCancellationPreview(
        { tenantId: "tenant", enterpriseId: "enterprise" },
        "campaign",
      ),
    ).rejects.toThrow("任务开放");
    expect(transaction.generationWorkItem.count).not.toHaveBeenCalled();
  });
});
