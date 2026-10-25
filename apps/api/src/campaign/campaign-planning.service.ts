import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { GenerationStyleService } from "../platform-settings/generation-style.service";
import type {
  CreateCampaignTemplateDto,
  CreatePromptTemplateDto,
  DisablePlanningTemplateDto,
  SaveCampaignDraftDto,
} from "./campaign-planning.dto";
import { MedicalPlanningService, medicalInternalBrief } from "./medical-planning.service";

@Injectable()
export class CampaignPlanningService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(GenerationStyleService) private readonly styles: GenerationStyleService,
    @Inject(MedicalPlanningService) private readonly medicalPlanning: MedicalPlanningService,
  ) {}

  medicalOptions(tenantId: string, enterpriseId: string) {
    this.requireEnterpriseScope(tenantId, enterpriseId);
    return this.medicalPlanning.options({ tenantId, enterpriseId });
  }

  generationStyles(tenantId: string, enterpriseId: string) {
    this.requireEnterpriseScope(tenantId, enterpriseId);
    return this.styles.options();
  }

  listPromptTemplates(tenantId: string, enterpriseId: string) {
    this.requireEnterpriseScope(tenantId, enterpriseId);
    return this.prisma.promptTemplate.findMany({
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      where: { enterpriseId, status: "ACTIVE", tenantId },
    });
  }

  async createPromptTemplate(
    tenantId: string,
    enterpriseId: string,
    input: CreatePromptTemplateDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const template = await transaction.promptTemplate.create({
          data: {
            content: input.content,
            contentDirection: optionalText(input.contentDirection),
            contentDirectionPresetId: optionalText(input.contentDirectionPresetId),
            createdBy: principal.userId,
            enterpriseId,
            name: input.name,
            tenantId,
          },
        });
        await transaction.auditLog.create({
          data: {
            action: "campaign.prompt-template.create",
            actorType: "USER",
            actorUserId: principal.userId,
            enterpriseId,
            resourceId: template.id,
            resourceType: "PromptTemplate",
            stateAfter: { name: template.name },
            tenantId,
          },
        });
        return template;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("当前企业已存在同名提示词模板");
      }
      throw error;
    }
  }

  listCampaignTemplates(tenantId: string, enterpriseId: string) {
    this.requireEnterpriseScope(tenantId, enterpriseId);
    return this.prisma.campaignTemplate.findMany({
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      where: { enterpriseId, status: "ACTIVE", tenantId },
    });
  }

  async createCampaignTemplate(
    tenantId: string,
    enterpriseId: string,
    input: CreateCampaignTemplateDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    const plan = await this.medicalPlanning.resolve(
      { tenantId, enterpriseId },
      input,
      new Date(),
      false,
    );
    const prompt = plan ? medicalInternalBrief(plan) : input.prompt;
    if (!prompt) throw new ConflictException("请填写活动要求");
    try {
      return await this.prisma.$transaction(async (transaction) => {
        if (input.promptTemplateId) {
          const promptTemplate = await transaction.promptTemplate.findFirst({
            select: { id: true },
            where: {
              enterpriseId,
              id: input.promptTemplateId,
              status: "ACTIVE",
              tenantId,
            },
          });
          if (!promptTemplate) throw new NotFoundException("当前企业中未找到所选提示词模板");
        }
        const template = await transaction.campaignTemplate.create({
          data: {
            contentDirection: optionalText(input.contentDirection),
            contentDirectionPresetId: optionalText(input.contentDirectionPresetId),
            createdBy: principal.userId,
            enterpriseId,
            imageCount: input.imageCount,
            imageStyle: optionalText(input.imageStyle),
            imageStylePresetId: optionalText(input.imageStylePresetId),
            name: input.name,
            prompt,
            selectionSnapshot: plan ? (plan as unknown as Prisma.InputJsonValue) : undefined,
            promptTemplateId: input.promptTemplateId,
            reminderOffsetsHours: normalizeReminderOffsets(input.reminderOffsetsHours),
            tenantId,
            title: input.title,
          },
        });
        await transaction.auditLog.create({
          data: {
            action: "campaign.template.create",
            actorType: "USER",
            actorUserId: principal.userId,
            enterpriseId,
            resourceId: template.id,
            resourceType: "CampaignTemplate",
            stateAfter: { name: template.name },
            tenantId,
          },
        });
        return template;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("当前企业已存在同名活动模板");
      }
      throw error;
    }
  }

  async disablePromptTemplate(
    tenantId: string,
    enterpriseId: string,
    templateId: string,
    input: DisablePlanningTemplateDto,
  ) {
    return this.disableTemplate(tenantId, enterpriseId, templateId, input, "PROMPT");
  }

  async disableCampaignTemplate(
    tenantId: string,
    enterpriseId: string,
    templateId: string,
    input: DisablePlanningTemplateDto,
  ) {
    return this.disableTemplate(tenantId, enterpriseId, templateId, input, "CAMPAIGN");
  }

  async getDraft(tenantId: string, enterpriseId: string) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    const draft = await this.prisma.campaignDraft.findUnique({
      where: { enterpriseId_createdBy: { createdBy: principal.userId, enterpriseId } },
    });
    return { draft };
  }

  async saveDraft(tenantId: string, enterpriseId: string, input: SaveCampaignDraftDto) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    if (input.selection)
      throw new ConflictException("医疗选择式草稿已停用，请刷新页面并填写活动要求；历史草稿仍保留");
    const payload = {
      ...(input.focusEntityIds !== undefined
        ? { focusEntityIds: [...new Set(input.focusEntityIds)] }
        : {}),
      ...(input.referenceArtifactIds !== undefined
        ? { referenceArtifactIds: [...new Set(input.referenceArtifactIds)] }
        : {}),
      ...(input.logoArtifactId !== undefined ? { logoArtifactId: input.logoArtifactId } : {}),
      audienceMode: input.audienceMode ?? "ALL",
      campaignTemplateId: optionalText(input.campaignTemplateId) ?? "",
      contentDirection: optionalText(input.contentDirection) ?? "",
      contentDirectionPresetId: optionalText(input.contentDirectionPresetId) ?? "",
      departmentId: optionalText(input.departmentId) ?? "",
      imageCount: input.imageCount ?? 1,
      imageStyle: optionalText(input.imageStyle) ?? "",
      imageStylePresetId: optionalText(input.imageStylePresetId) ?? "",
      membershipIds: [...new Set(input.membershipIds ?? [])],
      prompt: input.prompt ?? "",
      promptTemplateId: optionalText(input.promptTemplateId) ?? "",
      reminderOffsetsHours: normalizeReminderOffsets(input.reminderOffsetsHours),
      title: input.title ?? "",
      visibleAt: input.visibleAt ?? "",
    } satisfies Record<string, Prisma.InputJsonValue | null>;
    return this.prisma.campaignDraft.upsert({
      create: {
        createdBy: principal.userId,
        enterpriseId,
        payload,
        step: input.step,
        tenantId,
      },
      update: { payload, step: input.step },
      where: { enterpriseId_createdBy: { createdBy: principal.userId, enterpriseId } },
    });
  }

  async clearDraft(tenantId: string, enterpriseId: string) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    const result = await this.prisma.campaignDraft.deleteMany({
      where: { createdBy: principal.userId, enterpriseId, tenantId },
    });
    return { cleared: result.count > 0 };
  }

  private async disableTemplate(
    tenantId: string,
    enterpriseId: string,
    templateId: string,
    input: DisablePlanningTemplateDto,
    kind: "CAMPAIGN" | "PROMPT",
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    return this.prisma.$transaction(async (transaction) => {
      const template =
        kind === "PROMPT"
          ? await transaction.promptTemplate.findFirst({
              where: { enterpriseId, id: templateId, tenantId },
            })
          : await transaction.campaignTemplate.findFirst({
              where: { enterpriseId, id: templateId, tenantId },
            });
      if (!template) throw new NotFoundException("当前企业中未找到该模板");
      const updated =
        kind === "PROMPT"
          ? await transaction.promptTemplate.update({
              data: { status: "DISABLED" },
              where: { id: template.id },
            })
          : await transaction.campaignTemplate.update({
              data: { status: "DISABLED" },
              where: { id: template.id },
            });
      await transaction.auditLog.create({
        data: {
          action:
            kind === "PROMPT" ? "campaign.prompt-template.disable" : "campaign.template.disable",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId,
          reason: input.reason,
          resourceId: template.id,
          resourceType: kind === "PROMPT" ? "PromptTemplate" : "CampaignTemplate",
          tenantId,
        },
      });
      return updated;
    });
  }

  private requireEnterpriseScope(tenantId: string, enterpriseId: string) {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "ENTERPRISE" ||
      principal.scope.tenantId !== tenantId ||
      principal.scope.enterpriseId !== enterpriseId
    ) {
      throw new ForbiddenException("Active request scope does not match the requested enterprise");
    }
    return principal;
  }
}

function normalizeReminderOffsets(values: readonly number[] | undefined): number[] {
  return [...new Set(values ?? [])].sort((left, right) => left - right);
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
