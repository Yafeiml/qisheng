import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignService } from "./campaign.service";

afterEach(() => vi.unstubAllEnvs());

const scope = { tenantId: "tenant", enterpriseId: "enterprise" };
const frozenInput = {
  campaignBrief: "已冻结的要求",
  imageAssets: [{ artifactId: "approved-reference", usage: "REFERENCE" }],
  sourceContext: { materialIds: ["authorized-material"] },
};

function fixture() {
  let committed = false;
  const campaign = {
    id: "campaign",
    status: "GENERATION_FAILED",
    blueprint: { campaignId: "campaign" },
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "campaign" }]),
    campaign: {
      findFirst: vi.fn().mockResolvedValue(campaign),
      update: vi.fn().mockResolvedValue({}),
    },
    generationRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: "run",
        generationInput: frozenInput,
        workItems: [{ id: "item", reservationVersion: 3 }],
      }),
      update: vi.fn().mockResolvedValue({ queueVersion: 9 }),
    },
    generationWorkItem: {
      findFirst: vi.fn().mockResolvedValue({
        id: "item",
        generationRunId: "run",
        membershipId: "member",
        generationRun: {
          id: "run",
          routingPolicy: { routeId: "frozen-route" },
          generationInput: frozenInput,
        },
      }),
      findMany: vi.fn().mockResolvedValue([{ id: "item", queueVersion: 8, reservationVersion: 4 }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({
        id: "item",
        generationRunId: "run",
        queueVersion: 8,
        reservationVersion: 4,
      }),
      count: vi.fn().mockResolvedValue(0),
    },
    employeeContent: {
      findFirst: vi.fn().mockResolvedValue({
        id: "content",
        membershipId: "member",
        campaign: { status: "REVIEW_PENDING" },
        body: "已审核的原正文",
        riskAssessment: { passed: true },
      }),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const dispatch = vi.fn(async () => {
    expect(committed).toBe(true);
  });
  const service = Object.assign(Object.create(CampaignService.prototype), {
    accessContext: {
      requireSaasAdmin: () => ({ userId: "admin", scope: { type: "ENTERPRISE", ...scope } }),
    },
    prisma: {
      $transaction: vi.fn(async (operation) => {
        const result = await operation(tx);
        committed = true;
        return result;
      }),
      auditLog: tx.auditLog,
    },
    generationQueue: { enqueueRun: dispatch, enqueueWorkItem: dispatch },
    getCampaign: vi.fn().mockResolvedValue({ id: "campaign", status: "GENERATING" }),
  }) as CampaignService;
  return { service, tx, dispatch, campaign };
}

describe("campaign generation recovery", () => {
  it("retries failed work using new queue versions after the state has committed", async () => {
    const { service, tx, dispatch } = fixture();
    await expect(service.retryFailedGeneration(scope, "campaign")).resolves.toMatchObject({
      status: "GENERATING",
    });
    expect(tx.generationWorkItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "QUEUED",
          queueVersion: { increment: 1 },
          reservationVersion: { increment: 1 },
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          attemptCount: 0,
        }),
        where: { id: { in: ["item"] }, tenantId: "tenant" },
      }),
    );
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      generationRunId: "run",
      queueVersion: 8,
      reservationVersion: 4,
      tenantId: "tenant",
      workItemId: "item",
      medical: false,
    });
    expect(tx.employeeContent.update).not.toHaveBeenCalled();
  });

  it("rejects a retry of a campaign that is no longer failed before changing any work", async () => {
    const { service, tx, dispatch, campaign } = fixture();
    campaign.status = "GENERATING";
    await expect(service.retryFailedGeneration(scope, "campaign")).rejects.toThrow(
      "Only a failed generation campaign",
    );
    expect(tx.generationWorkItem.updateMany).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["COPY", "IMAGE", "BOTH"] as const)(
    "queues %s regeneration with frozen inputs and leaves the prior content intact",
    async (target) => {
      const { service, tx, dispatch } = fixture();
      await service.regenerateContent(scope, "campaign", "content", {
        target,
        feedback: "请明确整理表达结构",
      });
      expect(tx.generationRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            generationInput: { ...frozenInput, regenerationTargets: { item: target } },
          }),
        }),
      );
      expect(tx.generationWorkItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "QUEUED",
            reviewFeedback: "请明确整理表达结构",
            reservationVersion: { increment: 1 },
            queueVersion: { increment: 1 },
          }),
        }),
      );
      expect(dispatch).toHaveBeenCalledExactlyOnceWith({
        generationRunId: "run",
        queueVersion: 8,
        reservationVersion: 4,
        tenantId: "tenant",
        workItemId: "item",
        medical: false,
      });
      expect(tx.employeeContent.update).not.toHaveBeenCalled();
    },
  );

  it("keeps retry state durable and records dispatch recovery when the queue is unavailable", async () => {
    const { service, tx, dispatch } = fixture();
    dispatch.mockRejectedValue(new Error("queue temporarily unavailable"));
    await expect(service.retryFailedGeneration(scope, "campaign")).resolves.toMatchObject({
      status: "GENERATING",
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "campaign.generation.retry-dispatch-pending",
        resourceId: "run",
      }),
    });
  });
});

function creationFixture() {
  let committed = false;
  const create = () => vi.fn().mockResolvedValue({});
  const database = {
    enterprise: { findFirst: vi.fn().mockResolvedValue({ id: "enterprise", industry: null }) },
    enterpriseMembership: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: "member", name: "员工", phone: "13800000000", department: null },
        ]),
    },
    campaign: { create: create(), update: create() },
    campaignPreflightSnapshot: { create: create() },
    campaignRetrievalEvidence: { createMany: create() },
    campaignAudienceSnapshot: { createMany: create() },
    campaignBlueprint: { create: create() },
    generationRun: { create: create(), update: create() },
    generationWorkItem: { createMany: create(), update: create() },
    employeeContent: { createMany: create() },
    generatedImage: { createMany: create() },
    distributionTask: { createMany: create() },
    auditLog: { create: create() },
  };
  const enqueue = vi.fn(async () => {
    expect(committed).toBe(true);
  });
  const assertCurrent = vi.fn().mockResolvedValue(undefined);
  const style = {
    contentDirection: { id: "direction", name: "知识分享" },
    imageStyle: { id: "image-style", name: "简约插画" },
  };
  const preflight = {
    frozenRoute: {
      synthetic: false,
      text: { primary: { externalModelId: "text-model", providerCode: "provider" } },
      image: { primary: { externalModelId: "image-model", providerCode: "provider" } },
    },
  };
  const service = Object.assign(Object.create(CampaignService.prototype), {
    accessContext: {
      requireSaasAdmin: () => ({ userId: "admin", scope: { type: "ENTERPRISE", ...scope } }),
    },
    prisma: {
      $transaction: vi.fn(async (operation) => {
        const result = await operation(database);
        committed = true;
        return result;
      }),
      auditLog: database.auditLog,
    },
    assertPlanningReferences: vi.fn().mockResolvedValue(undefined),
    tenantCapabilities: {
      current: vi.fn().mockResolvedValue({ imagesPerDistribution: 1 }),
      assertImagesPerContent: vi.fn(),
    },
    generationStyles: { snapshot: vi.fn().mockResolvedValue(style) },
    generationPreflight: {
      requireCampaignReady: vi.fn().mockResolvedValue(preflight),
      assertStillCurrent: assertCurrent,
      snapshotCreateData: vi.fn().mockReturnValue({ checks: [] }),
    },
    platformSettings: { number: vi.fn().mockResolvedValue(24) },
    materialRetrieval: {
      retrieve: vi.fn().mockResolvedValue({
        strategyVersion: "test",
        hits: [
          {
            materialId: "material",
            materialSeriesId: "series",
            materialTitle: "授权素材",
            materialType: "TEXT",
            materialVersion: 1,
            materialScopeKey: "enterprise",
            chunkId: "chunk",
            snippet: "已核实的事实",
            hitReasons: ["lexical"],
            lexicalScore: 1,
            vectorScore: 0,
            score: 1,
            tagScore: 0,
            rank: 1,
          },
        ],
      }),
      selectImageAssets: vi.fn().mockResolvedValue([]),
    },
    content: {
      generationContext: vi
        .fn()
        .mockResolvedValue({ materials: [], geoEntities: [], sensitiveRules: [] }),
    },
    generationQueue: { enqueueRun: enqueue },
    generator: {
      assertAvailable: vi.fn(),
      assertCompatibleModelRoute: vi.fn(),
      createBlueprint: vi.fn().mockReturnValue({
        generationPolicy: {},
        imageDirection: "插图方向",
        masterCopy: "已冻结母版",
        sourceContext: {},
      }),
      createEmployeeVariant: vi.fn().mockReturnValue({
        title: "内容标题",
        body: "来自授权事实的日常内容",
        hashtags: ["分享"],
        imagePrompt: "简洁插画",
      }),
      createUniqueSvg: vi.fn().mockReturnValue({
        checksum: "checksum",
        imageUrl: "data:image/svg+xml,test",
        width: 100,
        height: 100,
      }),
    },
    modelConfiguration: {
      resolveRoute: vi.fn().mockResolvedValue({
        id: "route",
        textModel: { id: "text", externalModelId: "text-model", provider: { code: "provider" } },
        imageModel: {
          id: "image",
          externalModelId: "image-model",
          provider: { code: "provider" },
        },
      }),
    },
    getCampaign: vi.fn().mockResolvedValue({ id: "campaign", status: "GENERATING" }),
  }) as CampaignService;
  return { service, database, enqueue, assertCurrent };
}

describe("campaign creation transactions", () => {
  it("persists audience, frozen evidence and queued work before dispatching a durable run", async () => {
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("GENERATION_EXECUTION_MODE", "queue");
    const { service, database, enqueue } = creationFixture();
    await service.createCampaign(scope, { title: "新活动", prompt: "分享经过核实的企业日常" });
    expect(database.campaign.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ...scope, status: "GENERATING", audienceCount: 1 }),
    });
    expect(database.campaignRetrievalEvidence.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          ...scope,
          materialId: "material",
          frozenSnippet: "已核实的事实",
        }),
      ],
    });
    expect(database.generationWorkItem.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ ...scope, status: "QUEUED", membershipId: "member" })],
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ queueVersion: 1, tenantId: "tenant", medical: false }),
    );
  });

  it("rejects stale preflight evidence before creating a campaign or dispatching work", async () => {
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("GENERATION_EXECUTION_MODE", "queue");
    const { service, database, enqueue, assertCurrent } = creationFixture();
    assertCurrent.mockRejectedValue(new Error("preflight changed"));
    await expect(
      service.createCampaign(scope, { title: "新活动", prompt: "分享经过核实的企业日常" }),
    ).rejects.toThrow("preflight changed");
    expect(database.campaign.create).not.toHaveBeenCalled();
    expect(database.generationWorkItem.createMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("completes the development inline flow with independent employee content and locked delivery tasks", async () => {
    vi.stubEnv("VITEST", "true");
    const { service, database, enqueue } = creationFixture();
    await service.createCampaign(scope, { title: "新活动", prompt: "分享经过核实的企业日常" });
    expect(database.employeeContent.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ ...scope, membershipId: "member", status: "GENERATED" })],
    });
    expect(database.distributionTask.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ ...scope, membershipId: "member", status: "LOCKED" })],
    });
    expect(database.generationWorkItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCEEDED" }) }),
    );
    expect(database.generationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUCCEEDED", completedCount: 1 }),
      }),
    );
    expect(database.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { generatedCount: 1, status: "REVIEW_PENDING" } }),
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
