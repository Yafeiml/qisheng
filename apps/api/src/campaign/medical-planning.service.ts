import { isDeepStrictEqual } from "node:util";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { MedicalPlan, MedicalPublisherContext } from "@xhs-agentic/ai-gateway";
import type { Prisma } from "@xhs-agentic/database";
import { ContentService } from "../content/content.service";
import { PrismaService } from "../database/prisma.service";
import { eligibleMembershipParticipationWhere } from "../employee/personnel-eligibility";
import type { CreateCampaignDto } from "./campaign.dto";
import {
  MEDICAL_CONVERSION_PATHS,
  MEDICAL_IMAGE_MODES,
  MEDICAL_NOTE_FORMS,
  MEDICAL_PRIORITIES,
  MEDICAL_READER_SITUATIONS,
  type MedicalSelectionDto,
} from "./medical-selection.dto";

export type { MedicalPublisherContext } from "@xhs-agentic/ai-gateway";
export type FrozenMedicalPlan = MedicalPlan & { originalImageConfirmed?: boolean };

export { isMedicalIndustry } from "../content/medical-industry";

export function isMedicalPublisherCurrent(
  value: unknown,
  now = new Date(),
): value is MedicalPublisherContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Partial<MedicalPublisherContext>;
  return (
    context.schemaVersion === "medical-publisher-v1" &&
    ["ORDINARY", "UNKNOWN", "MEDICAL_KOS", "INSTITUTION"].includes(context.category ?? "") &&
    typeof context.authorId === "string" &&
    /^[a-zA-Z0-9_-]{6,100}$/u.test(context.authorId) &&
    typeof context.evidence === "string" &&
    context.evidence.trim().length >= 4 &&
    typeof context.verifiedBy === "string" &&
    context.verifiedBy.length > 0 &&
    Number.isFinite(Date.parse(context.verifiedAt ?? "")) &&
    Date.parse(context.verifiedAt ?? "") <= now.getTime() &&
    Number.isFinite(Date.parse(context.validUntil ?? "")) &&
    Date.parse(context.validUntil ?? "") > now.getTime()
  );
}

export function assertMedicalPublisherFits(
  selection: MedicalSelectionDto,
  value: unknown,
  now = new Date(),
) {
  if (selection.noteForm === "PERSONAL_RECORD")
    throw new ConflictException("本人经历与素材尚未建立成员归属证据，暂不能生成本人记录");
  const needsQualification =
    selection.noteForm === "WORK_RECORD" ||
    selection.noteForm === "SERVICE_INFO" ||
    selection.conversionPath !== "NONE";
  if (!isMedicalPublisherCurrent(value, now) && needsQualification)
    throw new ConflictException("发布档案未核验或已过期，请企业运营补齐；员工无需选择账号定位");
  if (!isMedicalPublisherCurrent(value, now))
    return {
      schemaVersion: "medical-publisher-v1",
      category: "UNKNOWN",
      allowBrandAttribution: false,
      allowPlatformConsultation: false,
    } satisfies MedicalPublisherContext;
  if (value.category === "UNKNOWN" && needsQualification)
    throw new ConflictException("发布资格未知，请企业运营完成核验");
  const qualified = value.category === "MEDICAL_KOS" || value.category === "INSTITUTION";
  if (!qualified && (value.allowBrandAttribution || value.allowPlatformConsultation))
    throw new ConflictException("普通或未知资格不能升级为医疗品牌和咨询入口");
  if (selection.noteForm === "WORK_RECORD" && (!qualified || !value.role?.trim()))
    throw new ConflictException("员工工作记录需要有效发布资格和已核实岗位");
  if (selection.noteForm === "SERVICE_INFO" && value.category !== "INSTITUTION")
    throw new ConflictException("机构必要信息仅分配给已核验的机构发布账号");
  if (selection.conversionPath !== "NONE" && (!qualified || !value.allowBrandAttribution))
    throw new ConflictException("当前发布档案不允许本次品牌承接入口");
  if (selection.conversionPath === "PLATFORM_CONSULTATION" && !value.allowPlatformConsultation)
    throw new ConflictException("站内咨询入口尚未核验，不得替换成私信暗号或外部联系方式");
  return value;
}

export function assertNoMedicalPromptBypass(input: Record<string, unknown>) {
  for (const field of [
    "prompt",
    "contentDirection",
    "contentDirectionPresetId",
    "imageStyle",
    "imageStylePresetId",
    "promptTemplateId",
  ])
    if (input[field] !== undefined && input[field] !== null && input[field] !== "")
      throw new ConflictException("医疗活动必须通过受治理选择项生成，不接受自由提示词或风格旁路");
  if (input.logoArtifactId)
    throw new ConflictException("医疗笔记不使用自动 Logo 叠加，请移除 Logo 选择");
}

export function medicalInternalBrief(plan: FrozenMedicalPlan) {
  return [
    "固定目标：小红书 GEO 与企业核实成交；咨询、预约及互动仅为过程指标。",
    `活动侧重点：${plan.priority}；读者处境：${plan.readerSituation}；笔记形式：${plan.noteForm}；图片：${plan.imageMode}。`,
    `主要问题：${plan.topics.map((topic) => topic.question).join("；")}`,
    `允许的下一步：${plan.conversionPath}。发布资格、真实岗位与经历只能来自冻结档案。`,
    "以真实问题组织有来源的事实。不得虚构亲历、患者证言、效果保证、厂商背书或暗号导流。品牌出现不等于已经取得搜索曝光、AI 引用或成交。",
  ].join("\n");
}

export function medicalRetrievalQuery(plan: FrozenMedicalPlan) {
  return plan.topics.map(({ question }) => question).join("；");
}

@Injectable()
export class MedicalPlanningService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ContentService) private readonly content: ContentService,
  ) {}

  async options(scope: { tenantId: string; enterpriseId: string }) {
    const enterprise = await this.prisma.enterprise.findFirst({
      where: { id: scope.enterpriseId, tenantId: scope.tenantId },
      select: { industry: true, city: true, brandName: true, name: true },
    });
    if (!enterprise) throw new NotFoundException("当前企业不存在");
    const entities = await this.content.effectiveGeoEntities(scope.tenantId, scope.enterpriseId);
    return {
      enabled: false,
      objective: "GEO_AND_TRANSACTION",
      priorities: MEDICAL_PRIORITIES,
      readerSituations: MEDICAL_READER_SITUATIONS,
      noteForms: MEDICAL_NOTE_FORMS,
      disabledNoteForms: [
        {
          value: "PERSONAL_RECORD",
          reason: "尚未建立本人经历与素材的成员归属证据，不能生成假亲历",
        },
      ],
      imageModes: MEDICAL_IMAGE_MODES,
      conversionPaths: MEDICAL_CONVERSION_PATHS,
      topics: entities.flatMap((entity) =>
        entity.topics.map((topic) => ({
          id: topic.id,
          question: topic.question,
          intent: topic.intent,
          entityId: entity.id,
          entityName: entity.name,
        })),
      ),
      approvedAdAssets: {
        enabled: false,
        reason: "尚未配置已审广告样件与适用主体渠道的固定成品治理，不能自由生成替代",
      },
      enterprise: { name: enterprise.name, brandName: enterprise.brandName, city: enterprise.city },
    };
  }

  async resolve(
    scope: { tenantId: string; enterpriseId: string },
    input: Partial<CreateCampaignDto>,
    _now = new Date(),
    _checkPublishers = true,
  ): Promise<FrozenMedicalPlan | null> {
    const enterprise = await this.prisma.enterprise.findFirst({
      where: { id: scope.enterpriseId, tenantId: scope.tenantId },
      select: { id: true },
    });
    if (!enterprise) throw new NotFoundException("当前企业不存在");
    if (input.selection)
      throw new ConflictException(
        "医疗选择式生成已停用，请刷新页面，使用活动要求和风格配置创建内容；历史内容仍保留",
      );
    return null;
  }

  async assertCurrent(
    transaction: Prisma.TransactionClient,
    scope: { tenantId: string; enterpriseId: string },
    plan: FrozenMedicalPlan,
    now = new Date(),
  ) {
    const topics = await transaction.geoTopic.findMany({
      where: {
        tenantId: scope.tenantId,
        id: { in: plan.topics.map(({ id }) => id) },
        status: "ACTIVE",
        entity: { status: "ACTIVE" },
      },
      select: { id: true, version: true, updatedAt: true },
    });
    if (
      topics.length !== plan.topics.length ||
      topics.some(
        (topic) => plan.topics.find(({ id }) => id === topic.id)?.version !== topic.version,
      )
    )
      throw new ConflictException("问题库在预检后发生变化，请重新预检");
    const members = await transaction.enterpriseMembership.findMany({
      where: {
        ...scope,
        id: { in: plan.publishers.map(({ membershipId }) => membershipId) },
        ...eligibleMembershipParticipationWhere(now),
        status: { in: ["PENDING_BIND", "ACTIVE"] },
      },
      select: { id: true, publisherContext: true },
    });
    if (members.length !== plan.publishers.length)
      throw new ConflictException("发布成员在预检后发生变化，请重新预检");
    for (const member of members) {
      const current = assertMedicalPublisherFits(plan, member.publisherContext, now);
      if (
        !isDeepStrictEqual(
          current,
          plan.publishers.find(({ membershipId }) => membershipId === member.id)?.publisherContext,
        )
      )
        throw new ConflictException("发布档案在预检后发生变化，请重新预检");
    }
  }
}
