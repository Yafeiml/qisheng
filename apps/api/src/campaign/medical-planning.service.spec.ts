import { describe, expect, it, vi } from "vitest";
import type { ContentService } from "../content/content.service";
import type { PrismaService } from "../database/prisma.service";
import {
  assertMedicalPublisherFits,
  assertNoMedicalPromptBypass,
  MedicalPlanningService,
} from "./medical-planning.service";
import type { MedicalSelectionDto } from "./medical-selection.dto";

const scope = { tenantId: "tenant", enterpriseId: "enterprise" };
const selection: MedicalSelectionDto = {
  schemaVersion: "medical-selection-v1",
  objective: "GEO_AND_TRANSACTION",
  priority: "BALANCED",
  topicIds: ["topic"],
  readerSituation: "FIRST_UNDERSTANDING",
  noteForm: "QUESTION_LIST",
  imageMode: "QUESTION_CARD",
  conversionPath: "NONE",
};
const validPublisher = {
  schemaVersion: "medical-publisher-v1",
  category: "MEDICAL_KOS",
  authorId: "author_123",
  verifiedAt: "2026-10-10T00:00:00.000Z",
  validUntil: "2099-01-01T00:00:00.000Z",
  evidence: "企业核对公开资质及当前站内入口",
  verifiedBy: "admin",
  role: "服务协调",
  allowBrandAttribution: true,
  allowPlatformConsultation: true,
};
function setup(topicId = "topic", publisher: unknown = null) {
  const prisma = {
    enterprise: { findFirst: vi.fn().mockResolvedValue({ industry: "眼科医疗" }) },
    enterpriseMembership: {
      findMany: vi.fn().mockResolvedValue([{ id: "member", publisherContext: publisher }]),
    },
  };
  const content = {
    effectiveGeoEntities: vi.fn().mockResolvedValue([
      {
        id: "entity",
        name: "服务主体",
        topics: [
          {
            id: topicId,
            question: "首次到院前要确认什么？",
            intent: "了解",
            seriesId: "topic-series",
            version: 1,
          },
        ],
      },
    ]),
  };
  return {
    service: new MedicalPlanningService(
      prisma as unknown as PrismaService,
      content as unknown as ContentService,
    ),
    prisma,
  };
}
describe("medical selection planning", () => {
  it("restores prompt and style generation for both medical and other industries", async () => {
    for (const industry of ["眼科医疗", "餐饮", null]) {
      const { service, prisma } = setup();
      prisma.enterprise.findFirst.mockResolvedValue({ industry } as never);
      expect(
        await service.resolve(scope, { prompt: "分享门店日常", imageStylePresetId: "photo" }),
      ).toBeNull();
      expect((await service.options(scope)).enabled).toBe(false);
      expect(prisma.enterpriseMembership.findMany).not.toHaveBeenCalled();
    }
  });
  it("rejects stale selection clients instead of creating another medical plan", async () => {
    const { service } = setup();
    await expect(service.resolve(scope, { selection })).rejects.toThrow("医疗选择式生成已停用");
    await expect(service.resolve(scope, { selection, prompt: "活动要求" })).rejects.toThrow(
      "请刷新页面",
    );
  });
  it("keeps enterprise scope validation", async () => {
    const { service, prisma } = setup();
    prisma.enterprise.findFirst.mockResolvedValue(null as never);
    await expect(service.resolve(scope, { prompt: "活动要求" })).rejects.toThrow("当前企业不存在");
  });
  it("blocks custom styles, prompt templates and forced logos", () => {
    for (const field of [
      "prompt",
      "contentDirection",
      "imageStyle",
      "contentDirectionPresetId",
      "imageStylePresetId",
      "promptTemplateId",
      "logoArtifactId",
    ])
      expect(() => assertNoMedicalPromptBypass({ [field]: "bypass" })).toThrow();
  });
  it("allows transparent verified work records and rejects expired authority", () => {
    expect(
      assertMedicalPublisherFits({ ...selection, noteForm: "WORK_RECORD" }, validPublisher),
    ).toEqual(validPublisher);
    expect(() =>
      assertMedicalPublisherFits(
        { ...selection, noteForm: "WORK_RECORD" },
        { ...validPublisher, validUntil: "2020-01-01T00:00:00Z" },
      ),
    ).toThrow("已过期");
    expect(() =>
      assertMedicalPublisherFits({ ...selection, noteForm: "SERVICE_INFO" }, validPublisher),
    ).toThrow("机构发布账号");
  });
  it("does not permit unverified consultation or ordinary-account promotion", () => {
    expect(() =>
      assertMedicalPublisherFits({ ...selection, conversionPath: "PLATFORM_CONSULTATION" }, null),
    ).toThrow();
    expect(() =>
      assertMedicalPublisherFits(
        { ...selection, conversionPath: "OFFICIAL_PROFILE" },
        { ...validPublisher, category: "ORDINARY" },
      ),
    ).toThrow("不能升级");
  });
  it("rechecks publisher and question versions inside the creation transaction", async () => {
    const { service } = setup("topic", validPublisher);
    const plan = {
      ...selection,
      executionVersion: "medical-plan-v1" as const,
      frozenAt: new Date().toISOString(),
      topics: [
        {
          id: "topic",
          seriesId: "series",
          version: 1,
          question: "到访前确认什么？",
          intent: "了解",
          entityId: "entity",
          entityName: "服务主体",
        },
      ],
      publishers: [{ membershipId: "member", publisherContext: validPublisher }],
    };
    const transaction = {
      geoTopic: { findMany: vi.fn().mockResolvedValue([{ id: "topic", version: 1 }]) },
      enterpriseMembership: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "member", publisherContext: { ...validPublisher, role: "已改岗位" } },
          ]),
      },
    };
    await expect(service.assertCurrent(transaction as never, scope, plan as never)).rejects.toThrow(
      "档案在预检后",
    );
    transaction.geoTopic.findMany.mockResolvedValue([{ id: "topic", version: 2 }]);
    await expect(service.assertCurrent(transaction as never, scope, plan as never)).rejects.toThrow(
      "问题库在预检后",
    );
  });
});
