import { describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import type { GenerationStyleService } from "../platform-settings/generation-style.service";
import { CampaignService } from "./campaign.service";
import { CampaignPlanningService } from "./campaign-planning.service";
import { GenerationPreflightService } from "./generation-preflight.service";
import { MedicalPlanningService } from "./medical-planning.service";

const scope = { tenantId: "tenant", enterpriseId: "enterprise" };
function planning() {
  const prisma = {
    enterprise: { findFirst: vi.fn().mockResolvedValue({ industry: "眼科" }) },
    promptTemplate: {
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: "prompt", ...data })),
    },
    campaignDraft: { upsert: vi.fn().mockImplementation(async (value) => value.update) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
  const access = {
    requireSaasAdmin: () => ({ userId: "operator", scope: { type: "ENTERPRISE", ...scope } }),
  };
  const medical = new MedicalPlanningService(prisma as unknown as PrismaService, {} as never);
  const service = new CampaignPlanningService(
    prisma as unknown as PrismaService,
    access as unknown as RequestAccessContext,
    {} as GenerationStyleService,
    medical,
  );
  return { service, prisma };
}

describe("generic campaign restoration", () => {
  it("accepts reusable prompt templates and partial drafts for a medical enterprise", async () => {
    const { service, prisma } = planning();
    expect(
      await service.createPromptTemplate(scope.tenantId, scope.enterpriseId, {
        name: "日常分享",
        content: "介绍授权资料中的门店日常",
      }),
    ).toMatchObject({ content: "介绍授权资料中的门店日常" });
    expect(
      await service.saveDraft(scope.tenantId, scope.enterpriseId, {
        step: 1,
        prompt: "分享门店日常",
        imageStylePresetId: "image-minimal",
      }),
    ).toMatchObject({ payload: { prompt: "分享门店日常", imageStylePresetId: "image-minimal" } });
    expect(prisma.enterprise.findFirst).not.toHaveBeenCalled();
  });
  it("does not overwrite an old draft when a stale medical-selection client submits", async () => {
    const { service, prisma } = planning();
    await expect(
      service.saveDraft(scope.tenantId, scope.enterpriseId, { step: 1, selection: {} as never }),
    ).rejects.toThrow("医疗选择式草稿已停用");
    expect(prisma.campaignDraft.upsert).not.toHaveBeenCalled();
  });
  it("freezes selected content and image styles before campaign preflight", async () => {
    const marker = new Error("stop before generation");
    const snapshot = vi.fn().mockResolvedValue({});
    const service = Object.assign(Object.create(CampaignService.prototype), {
      requireEnterpriseScope: vi.fn(),
      assertPlanningReferences: vi.fn().mockResolvedValue(undefined),
      generationStyles: { snapshot },
      generationPreflight: { requireCampaignReady: vi.fn().mockRejectedValue(marker) },
    }) as CampaignService;
    const input = {
      title: "活动标题",
      prompt: "分享门店日常",
      contentDirectionPresetId: "direction-project",
      imageStylePresetId: "image-minimal",
    };
    await expect(service.createCampaign(scope, input)).rejects.toBe(marker);
    expect(snapshot).toHaveBeenCalledWith(input);
  });
  it("keeps explicitly archived materials out of readiness without excluding unclassified history", async () => {
    const count = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    const service = Object.assign(Object.create(GenerationPreflightService.prototype), {
      prisma: { material: { count } },
    });
    expect(await service.effectiveMaterialCount(scope, false, new Date())).toBe(2);
    expect(count.mock.calls[1]?.[0].where.AND[1]).toEqual({
      structuredFacts: { path: ["medicalMaterial", "purpose"], equals: "ARCHIVE" },
    });
  });
  it("rejects copying a frozen medical activity into the generic generation path", async () => {
    const service = Object.assign(Object.create(CampaignService.prototype), {
      requireEnterpriseScope: vi.fn(),
      prisma: {
        campaign: {
          findFirst: vi.fn().mockResolvedValue({
            selectionSnapshot: { schemaVersion: "medical-selection-v1" },
            generationRuns: [],
            audienceSnapshots: [],
          }),
        },
      },
    }) as CampaignService;
    await expect(service.getCampaignCopyInput(scope, "old-medical")).rejects.toThrow(
      "请新建通用活动",
    );
  });
});
