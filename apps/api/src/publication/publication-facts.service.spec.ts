import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicationService } from "./publication.service";

const url = "https://www.xiaohongshu.com/explore/genericfacts0001";
const now = new Date("2026-10-24T10:00:00Z");

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("PUBLICATION_READBACK_ENABLED", "false");
  const task = {
    id: "task",
    campaignId: "campaign",
    tenantId: "tenant",
    enterpriseId: "enterprise",
    membershipId: "member",
    membership: { publisherContext: null },
    campaign: { selectionSnapshot: null },
    status: "AVAILABLE",
    visibleAt: new Date(now.getTime() - 1000),
    expiresAt: new Date(now.getTime() + 3600_000),
    factsConfirmedAt: now as Date | null,
    factsConfirmedRevision: 2 as number | null,
    factsReturnedAt: null as Date | null,
    employeeContent: {
      revision: 2,
      title: "门店日常",
      body: "今天整理了门店的展示区。",
      hashtags: ["工作日常"],
      images: [],
      contentFingerprint: "generic-content",
    },
  };
  const latest = structuredClone(task);
  const submission = {
    id: "submission",
    taskId: task.id,
    status: "VERIFYING",
    canonicalKey: "xiaohongshu:genericfacts0001",
    normalizedUrl: url,
    failureReason: null,
    matchScore: null,
    synthetic: false,
    verifiedAt: null,
    submittedAt: now,
    lateCorrection: false,
    task: latest,
  };
  const tx = {
    distributionTask: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
      findUniqueOrThrow: vi.fn().mockResolvedValue(latest),
      count: vi.fn().mockResolvedValue(1),
    },
    publishSubmission: {
      create: vi.fn().mockResolvedValue(submission),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockImplementation(async ({ data }) => Object.assign(submission, data)),
      findFirst: vi.fn().mockResolvedValue(submission),
      findUniqueOrThrow: vi.fn().mockResolvedValue(submission),
    },
    publicationCollectionJob: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    publishedContentRegistry: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "registry" }),
    },
    campaign: {
      findFirstOrThrow: vi.fn().mockResolvedValue({ audienceCount: 1, status: "ACTIVE" }),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const current = vi.fn().mockResolvedValue({
    adapter: null,
    mode: "HTTP",
    policy: {
      imageSimilarityThreshold: 0.9,
      manualReviewMargin: 0.1,
      policyVersion: "test-v1",
      requireImageMatch: false,
      textSimilarityThreshold: 0.9,
    },
  });
  const resolvePublicContent = vi
    .fn()
    .mockResolvedValue({ available: false, reason: "待人工核实" });
  const service = Object.assign(Object.create(PublicationService.prototype), {
    accessContext: {
      requireEmployee: () => ({ userId: "employee", membershipIds: ["member"] }),
      requireSaasAdmin: () => ({
        userId: "admin",
        scope: { type: "ENTERPRISE", tenantId: "tenant", enterpriseId: "enterprise" },
      }),
    },
    campaigns: { reconcileEmployeeTasks: vi.fn().mockResolvedValue(undefined) },
    publicationVerification: { current },
    resolvePublicContent,
    prisma: {
      distributionTask: {
        findFirst: vi.fn().mockResolvedValue(task),
        findUniqueOrThrow: vi.fn().mockResolvedValue(latest),
      },
      publishedContentRegistry: tx.publishedContentRegistry,
      auditLog: tx.auditLog,
      $transaction: vi.fn(async (run) => run(tx)),
    },
  }) as PublicationService;
  const evidence = {
    ...task.employeeContent,
    canonicalKey: submission.canonicalKey,
    canonicalUrl: url,
    provider: "TEST",
    adapterModel: "test",
    adapterReference: "reference",
    adapterRequestId: "request",
  };
  return { service, task, latest, tx, current, resolvePublicContent, evidence };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("generic publication facts gate", () => {
  it.each(["MANUAL", "DEVELOPMENT"])(
    "preserves real-link submissions for manual review in %s mode without claiming verification",
    async (mode) => {
      const { service, tx, current, resolvePublicContent } = fixture();
      const configuration = await current();
      current.mockResolvedValue({ ...configuration, mode });
      await service.submitEmployeePublication("task", { url });
      expect(tx.publishSubmission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "MANUAL_REVIEW",
            verifier: "enterprise-manual-review-pending-v1",
          }),
        }),
      );
      expect(tx.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: "publication.manual-review.requested" }),
        }),
      );
      expect(resolvePublicContent).not.toHaveBeenCalled();
      expect(tx.publishedContentRegistry.create).not.toHaveBeenCalled();
    },
  );
  it.each(["unconfirmed", "returned", "stale"])(
    "rejects a %s task before creating a submission or invoking verification",
    async (scenario) => {
      const { service, task, tx, current, resolvePublicContent } = fixture();
      if (scenario === "unconfirmed") task.factsConfirmedAt = null;
      if (scenario === "returned") task.factsReturnedAt = now;
      if (scenario === "stale") task.employeeContent.revision = 3;
      await expect(service.submitEmployeePublication("task", { url })).rejects.toThrow("先确认");
      expect(current).not.toHaveBeenCalled();
      expect(tx.publishSubmission.create).not.toHaveBeenCalled();
      expect(resolvePublicContent).not.toHaveBeenCalled();
    },
  );

  it("accepts a generic task confirmed for the current revision and guards its reservation", async () => {
    const { service, tx } = fixture();
    await expect(service.submitEmployeePublication("task", { url })).resolves.toMatchObject({
      status: "UNAVAILABLE",
    });
    expect(tx.distributionTask.updateMany).toHaveBeenCalledWith({
      data: { status: "VERIFYING", submittedAt: now },
      where: {
        id: "task",
        status: "AVAILABLE",
        expiresAt: { gt: now },
        employeeContent: { revision: 2 },
        factsConfirmedAt: { not: null },
        factsConfirmedRevision: 2,
        factsReturnedAt: null,
      },
    });
  });

  it("does not create a submission if confirmation or content changes before reservation", async () => {
    const { service, tx, resolvePublicContent } = fixture();
    tx.distributionTask.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.submitEmployeePublication("task", { url })).rejects.toThrow(
      "真实性确认已变化",
    );
    expect(tx.publishSubmission.create).not.toHaveBeenCalled();
    expect(resolvePublicContent).not.toHaveBeenCalled();
  });

  it.each(["returned", "revision"])(
    "does not accept matching evidence when the generic task's %s changes during verification",
    async (scenario) => {
      const { service, latest, tx, resolvePublicContent, evidence } = fixture();
      resolvePublicContent.mockResolvedValue({ available: true, evidence });
      if (scenario === "returned") latest.factsReturnedAt = now;
      else {
        latest.employeeContent.revision = 3;
        latest.factsConfirmedRevision = 3;
      }
      await expect(service.submitEmployeePublication("task", { url })).resolves.toMatchObject({
        status: "MANUAL_REVIEW",
      });
      expect(tx.publishedContentRegistry.create).not.toHaveBeenCalled();
    },
  );

  it("rechecks the generic task inside the successful verification transaction", async () => {
    const { service, latest, tx, resolvePublicContent, evidence } = fixture();
    resolvePublicContent.mockResolvedValue({ available: true, evidence });
    tx.distributionTask.findUniqueOrThrow.mockResolvedValue({
      ...latest,
      factsReturnedAt: now,
    });
    await expect(service.submitEmployeePublication("task", { url })).resolves.toMatchObject({
      status: "MANUAL_REVIEW",
    });
    expect(tx.publishedContentRegistry.create).not.toHaveBeenCalled();
  });

  it("completes matching generic evidence when the current confirmation remains valid", async () => {
    const { service, tx, resolvePublicContent, evidence } = fixture();
    resolvePublicContent.mockResolvedValue({ available: true, evidence });
    await expect(service.submitEmployeePublication("task", { url })).resolves.toMatchObject({
      status: "VALID",
    });
    expect(tx.publishedContentRegistry.create).toHaveBeenCalledOnce();
  });

  it.each(["unconfirmed", "returned", "stale"])(
    "refuses manual approval of a %s generic task",
    async (scenario) => {
      const { service, latest, tx } = fixture();
      if (scenario === "unconfirmed") latest.factsConfirmedAt = null;
      if (scenario === "returned") latest.factsReturnedAt = now;
      if (scenario === "stale") latest.employeeContent.revision = 3;
      await expect(
        service.reviewManualSubmission(
          { tenantId: "tenant", enterpriseId: "enterprise" },
          "submission",
          { decision: "VERIFIED", reason: "核对公开内容" },
        ),
      ).rejects.toThrow("先确认");
      expect(tx.publishedContentRegistry.create).not.toHaveBeenCalled();
      expect(tx.publishSubmission.update).not.toHaveBeenCalled();
    },
  );
});
