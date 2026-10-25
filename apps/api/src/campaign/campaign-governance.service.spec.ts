import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignService } from "./campaign.service";

const scope = { tenantId: "tenant", enterpriseId: "enterprise" };
const now = new Date("2026-09-22T10:00:00Z");
const past = new Date("2026-09-20T10:00:00Z");
const future = new Date("2026-09-22T11:00:00Z");
const safeContent = {
  body: "阅读检查报告时，可以先整理需要向医生咨询的问题。",
  hashtags: ["健康科普"],
  riskAssessment: { passed: true, warnings: [], unresolvedBlocks: [] },
  title: "如何准备咨询问题",
};
const blockedMedicalContent = {
  ...safeContent,
  body: "示例测试眼科屈光手术中心配备了德国蔡司全飞秒设备。示例测试眼科业务院长林示例是蔡司官方认证全飞秒手术专家。",
  title: "全飞秒怎么挑？先把关主刀医生",
};

function fixture(status = "REVIEW_PENDING") {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const campaign = {
    id: "campaign",
    createdAt: past,
    status,
    visibleAt: past,
    expiresAt: new Date("2026-09-21T10:00:00Z"),
    audienceCount: 1,
    generatedCount: 1,
    audienceSnapshots: [{ membershipId: "employee" }],
    employeeContents: [{ ...safeContent, membershipId: "employee", status: "GENERATED" }],
    distributionTasks: [{ membershipId: "employee" }],
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "campaign" }]),
    campaign: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(campaign),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...campaign, ...data })),
    },
    generationWorkItem: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    generationRun: {
      count: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    employeeContent: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    distributionTask: {
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const service = Object.assign(Object.create(CampaignService.prototype), {
    prisma: {
      $transaction: vi.fn((run) => (typeof run === "function" ? run(tx) : Promise.all(run))),
      ...tx,
    },
    accessContext: {
      requireSaasAdmin: () => ({ userId: "admin", scope: { type: "ENTERPRISE", ...scope } }),
    },
    platformSettings: { number: vi.fn().mockResolvedValue(24) },
    generationStyles: { snapshot: vi.fn().mockResolvedValue({}) },
    getCampaign: vi.fn().mockResolvedValue(campaign),
  }) as CampaignService;
  return { service, tx, campaign };
}

afterEach(() => vi.useRealTimers());

describe("campaign approval and cancellation", () => {
  it("freezes the selected generic styles when creating a new campaign", async () => {
    const { service } = fixture();
    const snapshot = vi.fn().mockResolvedValue({});
    const stop = new Error("Stop before generation");
    Object.assign(service, {
      assertPlanningReferences: vi.fn().mockResolvedValue(undefined),
      generationStyles: { snapshot },
      generationPreflight: { requireCampaignReady: vi.fn().mockRejectedValue(stop) },
    });
    await expect(
      service.createCampaign(scope, {
        title: "朋友聊天式技术分享",
        prompt: "用轻松的问答讲解技术，配一张简洁的插画",
        contentDirectionPresetId: "retired-direction",
        imageStylePresetId: "retired-image",
      }),
    ).rejects.toBe(stop);
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        contentDirectionPresetId: "retired-direction",
        imageStylePresetId: "retired-image",
      }),
    );
  });

  it("accepts creation less than eight hours ahead before entering generation preflight", async () => {
    const { service, tx } = fixture();
    const preflight = new Error("Reached generation preflight");
    Object.assign(service, {
      assertPlanningReferences: vi.fn().mockResolvedValue(undefined),
      generationPreflight: { requireCampaignReady: vi.fn().mockRejectedValue(preflight) },
      generator: { assertAvailable: vi.fn() },
    });
    await expect(
      service.createCampaign(scope, {
        title: "新活动",
        prompt: "专业内容",
        visibleAt: future.toISOString(),
      }),
    ).rejects.toBe(preflight);
    expect(tx.campaign.update).not.toHaveBeenCalled();
    expect(tx.generationWorkItem.findMany).not.toHaveBeenCalled();
  });

  it("blocks rescheduling and reopening review after the official opening boundary", async () => {
    const { service, tx, campaign } = fixture("APPROVED");
    campaign.visibleAt = now;
    await expect(
      service.rescheduleCampaign(scope, "campaign", {
        visibleAt: future.toISOString(),
        reason: "调整排期",
      }),
    ).rejects.toThrow("尚未开放");
    await expect(
      service.reopenCampaignReview(scope, "campaign", { reason: "重新审核" }),
    ).rejects.toThrow("已正式开放");
    expect(tx.campaign.update).not.toHaveBeenCalled();
  });

  it("allows an approved campaign to cancel before its official opening", async () => {
    const { service, tx, campaign } = fixture("APPROVED");
    campaign.visibleAt = future;
    await service.cancelCampaign(scope, "campaign", { reason: "停止活动" });
    expect(tx.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }),
    );
  });

  it("cancels running work and invalidates its lease and queued delivery version", async () => {
    const { service, tx } = fixture("GENERATING");
    tx.generationWorkItem.findMany.mockResolvedValue([{ id: "running-item" }]);
    await service.cancelCampaign(scope, "campaign", { reason: "本期停止生成" });
    expect(tx.generationWorkItem.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "CANCELLED",
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        nextRetryAt: null,
        errorRetryable: false,
        queueVersion: { increment: 1 },
      }),
      where: { id: { in: ["running-item"] }, tenantId: "tenant" },
    });
    expect(tx.campaign.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "CANCELLED",
        cancellationReason: "本期停止生成",
        cancellationSummary: {
          cancelledDistributionTasks: 1,
          cancelledGenerationRuns: 1,
          cancelledWorkItems: 1,
        },
      }),
      where: { id: "campaign" },
    });
  });

  it("does not approve a failed campaign even if some employee content succeeded", async () => {
    const { service, tx } = fixture("GENERATION_FAILED");
    await expect(
      service.approveCampaign(scope, "campaign", { visibleAt: future.toISOString() }),
    ).rejects.toThrow("生成失败项");
    expect(tx.employeeContent.updateMany).not.toHaveBeenCalled();
  });
  it("allows approving and rescheduling less than eight hours ahead", async () => {
    const { service, tx, campaign } = fixture();
    campaign.createdAt = now;
    await expect(
      service.approveCampaign(scope, "campaign", { visibleAt: future.toISOString() }),
    ).resolves.toMatchObject({ status: "APPROVED", visibleAt: future });
    campaign.status = "APPROVED";
    campaign.visibleAt = new Date(now.getTime() + 9 * 3_600_000);
    await expect(
      service.rescheduleCampaign(scope, "campaign", {
        visibleAt: future.toISOString(),
        reason: "调整排期",
      }),
    ).resolves.toBeDefined();
    expect(tx.campaign.update).toHaveBeenCalled();
  });
  it("opens a late approval immediately when no future time is requested", async () => {
    const { service, tx } = fixture();
    const result = await service.approveCampaign(scope, "campaign", {});
    expect(result.visibleAt).toEqual(now);
    expect(result.expiresAt).toEqual(new Date(now.getTime() + 24 * 3_600_000));
    expect(tx.distributionTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ visibleAt: now }) }),
    );
  });
  it.each(["GENERATING", "GENERATION_FAILED", "REVIEW_PENDING"])(
    "previews and cancels %s despite an expired tentative schedule",
    async (status) => {
      const { service, tx } = fixture(status);
      await expect(service.getCancellationPreview(scope, "campaign")).resolves.toMatchObject({
        cancelledWorkItems: 0,
        cancelledGenerationRuns: 1,
        cancelledDistributionTasks: 0,
      });
      await service.cancelCampaign(scope, "campaign", { reason: "停止本期活动" });
      expect(tx.campaign.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }),
      );
      expect(tx.distributionTask.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { in: ["LOCKED", "EXPIRED"] } }),
        }),
      );
    },
  );
  it.each(["APPROVED", "ACTIVE", "EXPIRED"])(
    "blocks preview and cancellation for opened %s",
    async (status) => {
      const { service, tx } = fixture(status);
      await expect(service.getCancellationPreview(scope, "campaign")).rejects.toThrow("不能取消");
      await expect(
        service.cancelCampaign(scope, "campaign", { reason: "停止本期活动" }),
      ).rejects.toThrow("不能取消");
      expect(tx.campaign.update).not.toHaveBeenCalled();
    },
  );
  it("blocks cancellation when tasks were already exposed even if the campaign status is stale", async () => {
    const { service, tx } = fixture();
    tx.distributionTask.count.mockResolvedValue(1);
    await expect(
      service.cancelCampaign(scope, "campaign", { reason: "停止本期活动" }),
    ).rejects.toThrow("任务开放");
    expect(tx.campaign.update).not.toHaveBeenCalled();
  });
  it("requires a new future schedule instead of immediately opening a late approval", async () => {
    const { service, tx } = fixture();
    await expect(
      service.approveCampaign(scope, "campaign", { visibleAt: past.toISOString() }),
    ).rejects.toThrow("未来");
    expect(tx.distributionTask.updateMany).not.toHaveBeenCalled();
    const result = await service.approveCampaign(scope, "campaign", {
      visibleAt: future.toISOString(),
    });
    expect(result.status).toBe("APPROVED");
    expect(result.expiresAt).toEqual(new Date("2026-09-23T11:00:00Z"));
    expect(tx.distributionTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "LOCKED", expiredAt: null, visibleAt: future }),
      }),
    );
  });
  it("blocks approval while employee generation or risk review is unresolved", async () => {
    const { service, tx, campaign } = fixture();
    tx.generationWorkItem.count.mockResolvedValue(1);
    await expect(
      service.approveCampaign(scope, "campaign", { visibleAt: future.toISOString() }),
    ).rejects.toThrow("未完成");
    tx.generationWorkItem.count.mockResolvedValue(0);
    campaign.employeeContents = [
      { ...safeContent, membershipId: "employee", status: "REVIEW_BLOCKED" },
    ];
    await expect(
      service.approveCampaign(scope, "campaign", { visibleAt: future.toISOString() }),
    ).rejects.toThrow("未通过审核");
    expect(tx.campaign.update).not.toHaveBeenCalled();
  });
  it("does not approve incomplete per-employee delivery even when generatedCount looks complete", async () => {
    const { service, tx, campaign } = fixture();
    campaign.distributionTasks = [];
    await expect(
      service.approveCampaign(scope, "campaign", { visibleAt: future.toISOString() }),
    ).rejects.toThrow("未生成");
    expect(tx.campaign.update).not.toHaveBeenCalled();
  });
  it("blocks a previously passed medical promotion before approval", async () => {
    const { service, tx, campaign } = fixture();
    campaign.employeeContents = [
      { ...blockedMedicalContent, membershipId: "employee", status: "GENERATED" },
    ];
    await expect(
      service.approveCampaign(scope, "campaign", { visibleAt: future.toISOString() }),
    ).rejects.toThrow("禁止发布");
    expect(tx.employeeContent.updateMany).not.toHaveBeenCalled();
    expect(tx.campaign.update).not.toHaveBeenCalled();
  });
  it.each([
    blockedMedicalContent,
    {
      ...safeContent,
      riskAssessment: { contentSafety: { decision: "BLOCK" }, warnings: ["审核提示"] },
    },
    {
      ...safeContent,
      riskAssessment: {
        contentSafety: { decision: "REVIEW", categories: [{ decision: "BLOCK" }] },
        warnings: ["审核提示"],
      },
    },
  ])("does not accept warning content with a current hard block", async (content) => {
    const { service, tx } = fixture();
    tx.employeeContent.findFirst.mockResolvedValue({
      ...content,
      id: "content",
      campaign: { status: "REVIEW_PENDING" },
      status: "REVIEW_BLOCKED",
    });
    await expect(
      service.acceptContentReview(scope, "campaign", "content", { reason: "人工审核" }),
    ).rejects.toThrow("禁止发布");
    expect(tx.employeeContent.update).not.toHaveBeenCalled();
  });
  it("still accepts warning-only content requiring reviewer judgement", async () => {
    const { service, tx } = fixture();
    tx.employeeContent.findFirst.mockResolvedValue({
      ...safeContent,
      id: "content",
      body: "欢迎预约示例测试眼科了解屈光手术。",
      campaign: { status: "REVIEW_PENDING" },
      riskAssessment: {
        passed: false,
        warnings: ["机构服务推广需要人工核实资格"],
        unresolvedBlocks: [],
      },
      status: "REVIEW_BLOCKED",
    });
    await service.acceptContentReview(scope, "campaign", "content", { reason: "已人工核实" });
    expect(tx.employeeContent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "GENERATED" }) }),
    );
  });
  it("does not expire unapproved tasks during employee reconciliation", async () => {
    const { service, tx } = fixture();
    await service.reconcileEmployeeTasks(["employee"], now);
    const expiryCall = tx.distributionTask.updateMany.mock.calls.find(
      ([args]) => args.data.status === "EXPIRED",
    );
    expect(expiryCall?.[0].where.campaign.status.in).toEqual(["APPROVED", "ACTIVE", "EXPIRED"]);
  });
});

describe("employee content distribution risk floor", () => {
  function taskFixture(content = blockedMedicalContent) {
    const { service } = fixture("ACTIVE");
    const task = {
      id: "task",
      status: "AVAILABLE",
      visibleAt: past,
      expiresAt: future,
      firstViewedAt: null,
      copiedAt: null,
      downloadedAt: null,
      submittedAt: null,
      verifiedAt: null,
      enterprise: { id: "enterprise", name: "企业" },
      campaign: { id: "campaign", title: "活动", status: "ACTIVE" },
      employeeContent: { ...content, synthetic: false, images: [] },
      registry: null,
      submissions: [],
    };
    const update = vi.fn().mockResolvedValue(task);
    const signImages = vi.fn().mockResolvedValue([]);
    Object.assign(service, {
      accessContext: { requireEmployee: () => ({ membershipIds: ["employee"] }) },
      reconcileEmployeeTasks: vi.fn().mockResolvedValue(undefined),
      findEmployeeTask: vi.fn().mockResolvedValue(task),
      prisma: { distributionTask: { findMany: vi.fn().mockResolvedValue([task]), update } },
      imageDelivery: { signImages },
    });
    return { service, update, signImages };
  }

  it("hides historic approved blocked content from the list without signing images", async () => {
    const { service, signImages } = taskFixture();
    await expect(service.listEmployeeTasks()).resolves.toEqual([
      expect.objectContaining({ content: null, contentVisible: false }),
    ]);
    expect(signImages).not.toHaveBeenCalled();
  });

  it("explains the block on detail access before signing images", async () => {
    const { service, signImages } = taskFixture();
    await expect(service.getEmployeeTask("task")).rejects.toThrow("已停止分发");
    expect(signImages).not.toHaveBeenCalled();
  });

  it.each(["VIEW", "COPY", "DOWNLOAD"] as const)(
    "rejects a blocked %s event before writing its distribution record",
    async (type) => {
      const { service, update } = taskFixture();
      await expect(
        type === "VIEW"
          ? service.viewEmployeeTask("task")
          : service.recordEmployeeTaskEvent("task", { type }),
      ).rejects.toThrow("禁止发布");
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("keeps safe approved content available", async () => {
    const { service, signImages } = taskFixture(safeContent);
    await expect(service.getEmployeeTask("task")).resolves.toMatchObject({
      content: expect.objectContaining({ title: safeContent.title }),
      contentVisible: true,
    });
    expect(signImages).toHaveBeenCalledExactlyOnceWith([]);
  });
});
