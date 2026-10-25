import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { FrozenImageAsset, GenerationStyleSnapshot } from "@xhs-agentic/ai-gateway";
import { type ContentSafetyText, medicalPromotionCategories } from "@xhs-agentic/content-safety";
import {
  type AuditLog,
  type Prisma,
  Prisma as PrismaNamespace,
  type PublicationCollectionJob,
  type PublishMetricSnapshot,
  type SensitiveRule,
} from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { ContentService } from "../content/content.service";
import { assertFrozenImageAssetsCurrent } from "../content/freeze-generation-input";
import {
  type MaterialRetrievalResult,
  MaterialRetrievalService,
} from "../content/material-retrieval.service";
import { PrismaService } from "../database/prisma.service";
import { eligibleMembershipParticipationWhere } from "../employee/personnel-eligibility";
import {
  createdAtCursorWhere,
  createdAtOrderBy,
  pageTake,
  toCursorPage,
} from "../http/cursor-pagination";
import { ModelConfigurationService } from "../model-configuration/model-configuration.service";
import { GenerationStyleService } from "../platform-settings/generation-style.service";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { publicMetricSnapshot } from "../publication/publication-metrics-public";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import type {
  AcceptCampaignContentReviewDto,
  ApproveCampaignDto,
  CampaignArchiveDto,
  CampaignListQueryDto,
  CampaignWorkItemQueryDto,
  CancelCampaignDto,
  CreateCampaignDto,
  DashboardQueryDto,
  RegenerateCampaignContentDto,
  ReopenCampaignReviewDto,
  RescheduleCampaignDto,
} from "./campaign.dto";
import {
  assertCampaignCancellationAllowed,
  assertFutureCampaignSchedule,
} from "./campaign-lifecycle-policy";
import type { EmployeeFactsDto, EmployeeTaskPermissionDto } from "./employee-facts.dto";
import {
  type GenerationPreflightResult,
  GenerationPreflightService,
} from "./generation-preflight.service";
import { GenerationQueueService } from "./generation-queue.service";
import { ImageDeliveryService } from "./image-delivery.service";
import {
  MedicalPlanningService,
  medicalInternalBrief,
  medicalRetrievalQuery,
} from "./medical-planning.service";
import {
  assertTaskFactsConfirmed,
  assertTaskPublishingCurrent,
  taskFactsConfirmed,
  taskMedicalPlan,
} from "./medical-task-policy";
import {
  type GeneratedEmployeeVariant,
  SyntheticGenerationAdapter,
} from "./synthetic-generation.adapter";

type EnterpriseScope = Readonly<{ tenantId: string; enterpriseId: string }>;
type PreparedCampaignInput = CreateCampaignDto & { prompt: string };

type CampaignWorkItemCsvRow = Prisma.GenerationWorkItemGetPayload<{
  include: {
    audienceSnapshot: {
      select: { departmentName: true; employeeName: true; employeePhone: true };
    };
  };
}>;

type ReadyGenerationPreflight = GenerationPreflightResult & {
  assessment: NonNullable<GenerationPreflightResult["assessment"]>;
  frozenRoute: NonNullable<GenerationPreflightResult["frozenRoute"]>;
};

const CAMPAIGN_DETAIL_INCLUDE = {
  audienceSnapshots: { orderBy: { createdAt: "asc" } },
  blueprint: {
    select: {
      campaignId: true,
      createdAt: true,
      imageDirection: true,
      masterCopy: true,
      sourceContext: true,
      updatedAt: true,
    },
  },
  distributionTasks: {
    include: {
      submissions: { orderBy: { submittedAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "asc" },
  },
  employeeContents: {
    orderBy: { createdAt: "asc" },
    select: {
      audienceSnapshot: true,
      audienceSnapshotId: true,
      body: true,
      campaignId: true,
      contentFingerprint: true,
      createdAt: true,
      enterpriseId: true,
      hashtags: true,
      id: true,
      images: {
        orderBy: { sequence: "asc" },
        select: {
          byteSize: true,
          checksum: true,
          createdAt: true,
          height: true,
          id: true,
          imageUrl: true,
          mimeType: true,
          perceptualHash: true,
          sequence: true,
          storageKey: true,
          width: true,
        },
      },
      membershipId: true,
      revision: true,
      revisions: {
        orderBy: { revision: "desc" },
        select: {
          createdAt: true,
          createdBy: true,
          id: true,
          reviewFeedback: true,
          revision: true,
          snapshot: true,
        },
      },
      riskAssessment: true,
      status: true,
      tenantId: true,
      title: true,
      updatedAt: true,
    },
  },
  generationRuns: {
    orderBy: { createdAt: "desc" },
    select: {
      completedCount: true,
      createdAt: true,
      errorCode: true,
      errorRetryable: true,
      failedCount: true,
      finishedAt: true,
      id: true,
      requestedCount: true,
      startedAt: true,
      status: true,
      updatedAt: true,
      workItems: {
        orderBy: { createdAt: "asc" },
        select: {
          attemptCount: true,
          audienceSnapshot: {
            select: { departmentName: true, employeeName: true, employeePhone: true },
          },
          createdAt: true,
          errorCode: true,
          errorRetryable: true,
          finishedAt: true,
          id: true,
          membershipId: true,
          reviewFeedback: true,
          reviewRegenerationCount: true,
          startedAt: true,
          status: true,
          updatedAt: true,
        },
        take: 100,
      },
    },
  },
  retrievalEvidence: { orderBy: { rank: "asc" } },
} as const satisfies Prisma.CampaignInclude;

const DASHBOARD_CAMPAIGN_INCLUDE = {
  distributionTasks: {
    include: {
      employeeContent: { include: { audienceSnapshot: true } },
      registry: { include: { metrics: { orderBy: { observedAt: "desc" }, take: 1 } } },
    },
  },
  enterprise: { select: { id: true, name: true } },
} as const satisfies Prisma.CampaignInclude;

type DashboardCampaign = Prisma.CampaignGetPayload<{
  include: typeof DASHBOARD_CAMPAIGN_INCLUDE;
}>;

@Injectable()
export class CampaignService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(TenantCapabilityService)
    private readonly tenantCapabilities: TenantCapabilityService,
    @Inject(ContentService) private readonly content: ContentService,
    @Inject(MaterialRetrievalService)
    private readonly materialRetrieval: MaterialRetrievalService,
    @Inject(SyntheticGenerationAdapter)
    private readonly generator: SyntheticGenerationAdapter,
    @Inject(ModelConfigurationService)
    private readonly modelConfiguration: ModelConfigurationService,
    @Inject(GenerationQueueService)
    private readonly generationQueue: GenerationQueueService,
    @Inject(GenerationPreflightService)
    private readonly generationPreflight: GenerationPreflightService,
    @Inject(ImageDeliveryService)
    private readonly imageDelivery: ImageDeliveryService,
    @Inject(PlatformSettingsReader)
    private readonly platformSettings: PlatformSettingsReader,
    @Inject(GenerationStyleService) private readonly generationStyles: GenerationStyleService,
    @Inject(MedicalPlanningService) private readonly medicalPlanning?: MedicalPlanningService,
  ) {}

  async createCampaign(scope: EnterpriseScope, input: CreateCampaignDto) {
    this.requireEnterpriseScope(scope);
    await this.assertPlanningReferences(scope, input);
    const style = await this.generationStyles.snapshot(input);
    const preflight = await this.generationPreflight.requireCampaignReady(scope, input);
    const prepared: PreparedCampaignInput = {
      ...input,
      prompt: preflight.medicalPlan
        ? medicalInternalBrief(preflight.medicalPlan)
        : (input.prompt ?? ""),
    };
    if (!prepared.prompt) throw new ConflictException("请填写活动要求");
    if (useInlineGeneration()) {
      if (preflight.medicalPlan)
        throw new ConflictException(
          "医疗选择计划需要支持该计划的内容 Worker，不能退回旧内联海报生成",
        );
      return this.createCampaignInline(scope, prepared, preflight, style);
    }
    return this.createCampaignQueued(scope, prepared, preflight, style);
  }

  private async createCampaignQueued(
    scope: EnterpriseScope,
    input: PreparedCampaignInput,
    preflight: ReadyGenerationPreflight,
    style: GenerationStyleSnapshot,
  ) {
    const principal = this.requireEnterpriseScope(scope);
    const now = new Date();
    const visibleAt = input.visibleAt ? new Date(input.visibleAt) : now;
    if (input.visibleAt) assertFutureCampaignSchedule(visibleAt, now);
    const expiresAt = addHours(
      visibleAt,
      await this.platformSettings.number("general.task_expiry_hours"),
    );
    const audienceSelection = campaignAudienceSelection(input);
    const selectedMembershipIds = audienceSelection.membershipIds;
    const retrievalQuery = preflight.medicalPlan
      ? medicalRetrievalQuery(preflight.medicalPlan)
      : input.prompt;
    const retrieval = await this.materialRetrieval.retrieve(
      scope,
      retrievalQuery,
      now,
      undefined,
      input.focusEntityIds,
    );
    requireRetrievalEvidence(retrieval);
    const generationContext = await this.content.generationContext(
      scope.tenantId,
      scope.enterpriseId,
      now,
      retrievalMaterialIds(retrieval),
      retrieval.focusEntityIds ?? [],
    );
    const frozenRoute = preflight.frozenRoute;
    if (frozenRoute.synthetic) this.generator.assertAvailable();
    const generationInput = freezeGenerationInput(generationContext, retrieval, style);
    if (preflight.medicalPlan) generationInput.medicalPlan = preflight.medicalPlan;
    generationInput.imageAssets = await this.materialRetrieval.selectImageAssets(
      scope,
      retrievalQuery,
      preflight.medicalPlan ? (input.referenceArtifactIds ?? []) : input.referenceArtifactIds,
      preflight.medicalPlan ? null : input.logoArtifactId,
    );
    generationInput.sourceContext = {
      ...(generationInput.sourceContext as Record<string, unknown>),
      imageReferences: (
        generationInput.imageAssets as Array<{
          artifactId: string;
          materialId: string;
          description: string;
          usage: string;
        }>
      ).map(({ artifactId, materialId, description, usage }) => ({
        artifactId,
        materialId,
        description,
        usage,
      })),
    };
    generationInput.campaignBrief = input.prompt;

    const created = await this.inSerializableTransaction(async (transaction) => {
      await this.generationPreflight.assertStillCurrent(transaction, preflight);
      if (preflight.medicalPlan) {
        if (!this.medicalPlanning) throw new ConflictException("医疗计划校验服务不可用");
        await this.medicalPlanning.assertCurrent(transaction, scope, preflight.medicalPlan, now);
        await assertFrozenImageAssetsCurrent(
          transaction,
          scope,
          generationInput.imageAssets as FrozenImageAsset[],
          now,
        );
      }
      const [enterprise, capability] = await Promise.all([
        transaction.enterprise.findFirst({
          select: { id: true, industry: true },
          where: { id: scope.enterpriseId, status: "ACTIVE", tenantId: scope.tenantId },
        }),
        this.tenantCapabilities.current(scope.tenantId, transaction),
      ]);
      if (!enterprise) throw new NotFoundException("Active enterprise was not found in the tenant");
      const industryGuidance = await freezeIndustryGenerationGuidance(
        transaction,
        enterprise.industry,
      );
      generationInput.industryGuidance = industryGuidance;
      generationInput.sourceContext = {
        ...(generationInput.sourceContext as Record<string, unknown>),
        industryGuidance,
      };
      const imageCount = input.imageCount ?? capability.imagesPerDistribution;
      this.tenantCapabilities.assertImagesPerContent(capability, imageCount);
      const memberships = await transaction.enterpriseMembership.findMany({
        include: { department: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
        where: {
          ...eligibleMembershipParticipationWhere(now),
          enterpriseId: scope.enterpriseId,
          id: selectedMembershipIds ? { in: selectedMembershipIds } : undefined,
          status: { in: ["PENDING_BIND", "ACTIVE"] },
          tenantId: scope.tenantId,
        },
      });
      if (memberships.length === 0) {
        throw new ConflictException("The campaign has no active, enabled employee audience");
      }
      if (selectedMembershipIds && memberships.length !== selectedMembershipIds.length) {
        throw new ConflictException(
          "One or more selected employees are not active enabled members of this enterprise",
        );
      }
      const campaignId = randomUUID();
      const generationRunId = randomUUID();
      await transaction.campaign.create({
        data: {
          audienceCount: memberships.length,
          audienceMode: audienceSelection.mode,
          audienceSelector: audienceSelection.selector as Prisma.InputJsonValue,
          campaignTemplateId: input.campaignTemplateId,
          contentDirection: style.contentDirection.name,
          contentDirectionPresetId: style.contentDirection.id || null,
          imageStylePresetId: style.imageStyle.id || null,
          generationStyleSnapshot: style as unknown as Prisma.InputJsonValue,
          selectionSnapshot: preflight.medicalPlan
            ? (preflight.medicalPlan as unknown as Prisma.InputJsonValue)
            : undefined,
          createdBy: principal.userId,
          enterpriseId: scope.enterpriseId,
          expiresAt,
          createdAt: now,
          id: campaignId,
          imageCount,
          imageStyle: style.imageStyle.name,
          prompt: input.prompt,
          promptTemplateId: input.promptTemplateId,
          reminderOffsetsHours: normalizeReminderOffsets(input.reminderOffsetsHours),
          status: "GENERATING",
          tenantId: scope.tenantId,
          title: input.title,
          visibleAt,
        },
      });
      await transaction.campaignPreflightSnapshot.create({
        data: this.generationPreflight.snapshotCreateData(campaignId, scope, preflight),
      });
      await transaction.campaignRetrievalEvidence.createMany({
        data: retrievalEvidenceRows(campaignId, scope, retrieval),
      });
      await transaction.generationRun.create({
        data: {
          campaignId,
          generationInput: generationInput as Prisma.InputJsonValue,
          id: generationRunId,
          imageModel: frozenRoute.image.primary.externalModelId,
          imageProvider: frozenRoute.image.primary.providerCode,
          provider:
            frozenRoute.text.primary.providerCode === frozenRoute.image.primary.providerCode
              ? frozenRoute.text.primary.providerCode
              : `${frozenRoute.text.primary.providerCode}+${frozenRoute.image.primary.providerCode}`,
          requestedCount: memberships.length,
          routingPolicy: frozenRoute as unknown as Prisma.InputJsonValue,
          status: "QUEUED",
          synthetic: frozenRoute.synthetic,
          tenantId: scope.tenantId,
          textModel: frozenRoute.text.primary.externalModelId,
          textProvider: frozenRoute.text.primary.providerCode,
        },
      });
      const audienceRows: Prisma.CampaignAudienceSnapshotCreateManyInput[] = [];
      const workRows: Prisma.GenerationWorkItemCreateManyInput[] = [];
      for (const membership of memberships) {
        const audienceSnapshotId = randomUUID();
        audienceRows.push({
          campaignId,
          departmentName: membership.department?.name,
          employeeName: membership.name,
          employeePhone: membership.phone,
          enterpriseId: scope.enterpriseId,
          id: audienceSnapshotId,
          membershipId: membership.id,
          tenantId: scope.tenantId,
        });
        workRows.push({
          audienceSnapshotId,
          campaignId,
          enterpriseId: scope.enterpriseId,
          generationRunId,
          id: randomUUID(),
          membershipId: membership.id,
          status: "QUEUED",
          tenantId: scope.tenantId,
        });
      }
      await transaction.campaignAudienceSnapshot.createMany({ data: audienceRows });
      await transaction.generationWorkItem.createMany({ data: workRows });
      await transaction.auditLog.create({
        data: {
          action: "campaign.generation.queue",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId: scope.enterpriseId,
          resourceId: campaignId,
          resourceType: "Campaign",
          stateAfter: {
            audienceCount: memberships.length,
            generationRunId,
            imageCount,
            status: "GENERATING",
            synthetic: frozenRoute.synthetic,
          },
          tenantId: scope.tenantId,
        },
      });
      return { campaignId, generationRunId };
    });

    try {
      await this.generationQueue.enqueueRun({
        generationRunId: created.generationRunId,
        queueVersion: 1,
        tenantId: scope.tenantId,
        medical: Boolean(preflight.medicalPlan),
      });
    } catch (error) {
      await this.prisma.auditLog.create({
        data: {
          action: "campaign.generation.dispatch-pending",
          actorType: "SYSTEM",
          enterpriseId: scope.enterpriseId,
          metadata: { error: safeErrorMessage(error) },
          resourceId: created.generationRunId,
          resourceType: "GenerationRun",
          tenantId: scope.tenantId,
        },
      });
    }
    return this.getCampaign(scope, created.campaignId);
  }

  private async createCampaignInline(
    scope: EnterpriseScope,
    input: PreparedCampaignInput,
    preflight: ReadyGenerationPreflight,
    style: GenerationStyleSnapshot,
  ) {
    const principal = this.requireEnterpriseScope(scope);
    this.generator.assertAvailable();
    const now = new Date();
    const visibleAt = input.visibleAt ? new Date(input.visibleAt) : now;
    if (input.visibleAt) assertFutureCampaignSchedule(visibleAt, now);
    const expiresAt = addHours(
      visibleAt,
      await this.platformSettings.number("general.task_expiry_hours"),
    );
    const audienceSelection = campaignAudienceSelection(input);
    const selectedMembershipIds = audienceSelection.membershipIds;
    const retrieval = await this.materialRetrieval.retrieve(
      scope,
      input.prompt,
      now,
      undefined,
      input.focusEntityIds,
    );
    requireRetrievalEvidence(retrieval);
    const generationContext = await this.content.generationContext(
      scope.tenantId,
      scope.enterpriseId,
      now,
      retrievalMaterialIds(retrieval),
      retrieval.focusEntityIds ?? [],
    );
    const modelRoute = await this.modelConfiguration.resolveRoute(
      scope.tenantId,
      scope.enterpriseId,
    );
    this.generator.assertCompatibleModelRoute(modelRoute);
    const blueprint = this.generator.createBlueprint(input.prompt, generationContext, style);

    const campaignId = await this.inSerializableTransaction(async (transaction) => {
      await this.generationPreflight.assertStillCurrent(transaction, preflight);
      const [enterprise, capability] = await Promise.all([
        transaction.enterprise.findFirst({
          select: { id: true, industry: true },
          where: { id: scope.enterpriseId, status: "ACTIVE", tenantId: scope.tenantId },
        }),
        this.tenantCapabilities.current(scope.tenantId, transaction),
      ]);
      if (!enterprise) {
        throw new NotFoundException("Active enterprise was not found in the tenant");
      }
      const imageCount = input.imageCount ?? capability.imagesPerDistribution;
      this.tenantCapabilities.assertImagesPerContent(capability, imageCount);

      const memberships = await transaction.enterpriseMembership.findMany({
        include: { department: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
        where: {
          ...eligibleMembershipParticipationWhere(now),
          enterpriseId: scope.enterpriseId,
          id: selectedMembershipIds ? { in: selectedMembershipIds } : undefined,
          status: { in: ["PENDING_BIND", "ACTIVE"] },
          tenantId: scope.tenantId,
        },
      });
      if (memberships.length === 0) {
        throw new ConflictException("The campaign has no active, enabled employee audience");
      }
      if (selectedMembershipIds && memberships.length !== selectedMembershipIds.length) {
        throw new ConflictException(
          "One or more selected employees are not active enabled members of this enterprise",
        );
      }
      const campaignId = randomUUID();
      const runId = randomUUID();
      await transaction.campaign.create({
        data: {
          audienceCount: memberships.length,
          audienceMode: audienceSelection.mode,
          audienceSelector: audienceSelection.selector as Prisma.InputJsonValue,
          campaignTemplateId: input.campaignTemplateId,
          contentDirection: style.contentDirection.name,
          contentDirectionPresetId: style.contentDirection.id || null,
          imageStylePresetId: style.imageStyle.id || null,
          generationStyleSnapshot: style as unknown as Prisma.InputJsonValue,
          createdBy: principal.userId,
          enterpriseId: scope.enterpriseId,
          expiresAt,
          createdAt: now,
          id: campaignId,
          imageCount,
          imageStyle: style.imageStyle.name,
          prompt: input.prompt,
          promptTemplateId: input.promptTemplateId,
          reminderOffsetsHours: normalizeReminderOffsets(input.reminderOffsetsHours),
          status: "GENERATING",
          tenantId: scope.tenantId,
          title: input.title,
          visibleAt,
        },
      });
      await transaction.campaignPreflightSnapshot.create({
        data: this.generationPreflight.snapshotCreateData(campaignId, scope, preflight),
      });
      await transaction.campaignRetrievalEvidence.createMany({
        data: retrievalEvidenceRows(campaignId, scope, retrieval),
      });
      await transaction.generationRun.create({
        data: {
          campaignId,
          generationInput: freezeGenerationInput(
            generationContext,
            retrieval,
            style,
            await freezeIndustryGenerationGuidance(transaction, enterprise.industry),
          ) as Prisma.InputJsonValue,
          completedCount: 0,
          id: runId,
          imageModel: modelRoute.imageModel.externalModelId,
          provider:
            modelRoute.textModel.provider.code === modelRoute.imageModel.provider.code
              ? modelRoute.textModel.provider.code
              : `${modelRoute.textModel.provider.code}+${modelRoute.imageModel.provider.code}`,
          requestedCount: memberships.length,
          startedAt: now,
          status: "RUNNING",
          synthetic: true,
          tenantId: scope.tenantId,
          textModel: modelRoute.textModel.externalModelId,
        },
      });
      await transaction.campaignBlueprint.create({
        data: {
          campaignId,
          generationPolicy: {
            ...blueprint.generationPolicy,
            imageModelId: modelRoute.imageModel.id,
            modelRouteId: modelRoute.id,
            textModelId: modelRoute.textModel.id,
          } as Prisma.InputJsonValue,
          imageDirection: blueprint.imageDirection,
          masterCopy: blueprint.masterCopy,
          sourceContext: blueprint.sourceContext as Prisma.InputJsonValue,
          synthetic: true,
          tenantId: scope.tenantId,
        },
      });

      const audienceRows: Prisma.CampaignAudienceSnapshotCreateManyInput[] = [];
      const contentRows: Prisma.EmployeeContentCreateManyInput[] = [];
      const imageRows: Prisma.GeneratedImageCreateManyInput[] = [];
      const taskRows: Prisma.DistributionTaskCreateManyInput[] = [];
      const workRows: Prisma.GenerationWorkItemCreateManyInput[] = [];
      const deliveries: Array<Readonly<{ taskId: string; workItemId: string }>> = [];
      for (const [index, membership] of memberships.entries()) {
        const audienceSnapshotId = randomUUID();
        const employeeContentId = randomUUID();
        const taskId = randomUUID();
        const workItemId = randomUUID();
        const rawVariant = this.generator.createEmployeeVariant(blueprint, input.title, index);
        const { riskAssessment, variant } = sanitizeGeneratedVariant(
          rawVariant,
          generationContext.sensitiveRules,
        );
        const contentFingerprint = fingerprint(
          `${variant.title}\n${variant.body}\n${variant.hashtags.join(" ")}`,
        );
        audienceRows.push({
          campaignId,
          departmentName: membership.department?.name,
          employeeName: membership.name,
          employeePhone: membership.phone,
          enterpriseId: scope.enterpriseId,
          id: audienceSnapshotId,
          membershipId: membership.id,
          tenantId: scope.tenantId,
        });
        contentRows.push({
          audienceSnapshotId,
          body: variant.body,
          campaignId,
          contentFingerprint,
          enterpriseId: scope.enterpriseId,
          hashtags: variant.hashtags,
          id: employeeContentId,
          imagePrompt: variant.imagePrompt,
          membershipId: membership.id,
          riskAssessment: riskAssessment as Prisma.InputJsonValue,
          status: riskAssessment.passed ? "GENERATED" : "REVIEW_BLOCKED",
          synthetic: true,
          tenantId: scope.tenantId,
          title: variant.title,
        });
        for (let sequence = 1; sequence <= imageCount; sequence += 1) {
          const image = this.generator.createUniqueSvg({
            campaignTitle: input.title,
            sequence,
            uniquenessSeed: `${campaignId}:${membership.id}:${sequence}:${randomUUID()}`,
          });
          imageRows.push({
            campaignId,
            checksum: image.checksum,
            employeeContentId,
            height: image.height,
            id: randomUUID(),
            imageUrl: image.imageUrl,
            mimeType: "image/svg+xml",
            model: modelRoute.imageModel.externalModelId,
            prompt: variant.imagePrompt,
            provider: modelRoute.imageModel.provider.code,
            sequence,
            synthetic: true,
            tenantId: scope.tenantId,
            width: image.width,
          });
        }
        taskRows.push({
          campaignId,
          employeeContentId,
          enterpriseId: scope.enterpriseId,
          expiresAt,
          id: taskId,
          membershipId: membership.id,
          status: "LOCKED",
          tenantId: scope.tenantId,
          visibleAt,
        });
        workRows.push({
          audienceSnapshotId,
          campaignId,
          enterpriseId: scope.enterpriseId,
          finishedAt: null,
          generationRunId: runId,
          id: workItemId,
          membershipId: membership.id,
          startedAt: now,
          status: "RUNNING",
          tenantId: scope.tenantId,
        });
        deliveries.push({ taskId, workItemId });
      }
      await transaction.campaignAudienceSnapshot.createMany({ data: audienceRows });
      await transaction.generationWorkItem.createMany({ data: workRows });
      await transaction.employeeContent.createMany({ data: contentRows });
      await transaction.generatedImage.createMany({ data: imageRows });
      await transaction.distributionTask.createMany({ data: taskRows });
      const finishedAt = new Date();
      for (const delivery of deliveries) {
        await transaction.generationWorkItem.update({
          data: { finishedAt, status: "SUCCEEDED" },
          where: { id: delivery.workItemId },
        });
      }
      await transaction.generationRun.update({
        data: {
          completedCount: memberships.length,
          finishedAt,
          status: "SUCCEEDED",
        },
        where: { id: runId },
      });
      await transaction.campaign.update({
        data: { generatedCount: memberships.length, status: "REVIEW_PENDING" },
        where: { id: campaignId },
      });
      await transaction.auditLog.create({
        data: {
          action: "campaign.generate",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId: scope.enterpriseId,
          resourceId: campaignId,
          resourceType: "Campaign",
          stateAfter: {
            audienceCount: memberships.length,
            imageCount,
            status: "REVIEW_PENDING",
            synthetic: true,
          },
          tenantId: scope.tenantId,
        },
      });
      return campaignId;
    });

    return this.getCampaign(scope, campaignId);
  }

  async listCampaigns(scope: EnterpriseScope, query: CampaignListQueryDto) {
    this.requireEnterpriseScope(scope);
    validateCampaignListRange(query);
    await this.reconcileEnterprise(scope, new Date());
    const [campaigns, counts] = await Promise.all([
      this.prisma.campaign.findMany({
        include: {
          _count: { select: { distributionTasks: true, employeeContents: true } },
          generationRuns: {
            orderBy: { createdAt: "desc" },
            select: {
              completedCount: true,
              createdAt: true,
              failedCount: true,
              finishedAt: true,
              id: true,
              requestedCount: true,
              startedAt: true,
              status: true,
              workItems: { select: { attemptCount: true, status: true } },
            },
            take: 1,
          },
        },
        orderBy: createdAtOrderBy(),
        take: pageTake(query),
        where: { AND: [scope, campaignListWhere(query), createdAtCursorWhere(query)] },
      }),
      this.prisma.campaign.groupBy({
        by: ["status"],
        _count: { _all: true },
        where: { AND: [scope, campaignListWhere({ ...query, status: undefined })] },
      }),
    ]);
    return {
      ...toCursorPage(campaigns.map(publicCampaign), query),
      statusCounts: Object.fromEntries(counts.map(({ status, _count }) => [status, _count._all])),
    };
  }

  async getCampaign(scope: EnterpriseScope, campaignId: string) {
    this.requireEnterpriseScope(scope);
    await this.reconcileEnterprise(scope, new Date());
    const campaign = await this.prisma.campaign.findFirst({
      include: CAMPAIGN_DETAIL_INCLUDE,
      where: { ...scope, id: campaignId },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign was not found in the active enterprise scope");
    }
    return {
      ...publicCampaign(campaign),
      blueprint: campaign.blueprint
        ? {
            ...campaign.blueprint,
            sourceContext: customerSourceContext(campaign.blueprint.sourceContext),
          }
        : null,
      employeeContents: await Promise.all(
        campaign.employeeContents.map(async (content) => ({
          ...content,
          images: (await this.imageDelivery.signImages(content.images)).map(
            ({ storageKey: _storageKey, ...image }) => image,
          ),
          revisions: content.revisions.map((revision) => ({
            ...revision,
            snapshot: customerContentRevisionSnapshot(revision.snapshot),
          })),
        })),
      ),
      generationRuns: campaign.generationRuns.map(
        ({ errorCode, errorRetryable, workItems, ...run }) => ({
          ...run,
          errorCategory: customerGenerationErrorCategory(errorCode, errorRetryable),
          workItems: workItems.map(
            ({ audienceSnapshot, errorCode, errorRetryable, ...workItem }) => ({
              ...workItem,
              audience: audienceSnapshot,
              errorCategory: customerGenerationErrorCategory(errorCode, errorRetryable),
            }),
          ),
        }),
      ),
      retrievalEvidence: campaign.retrievalEvidence.map((evidence) => ({
        ...evidence,
        lexicalScore: Number(evidence.lexicalScore),
        score: Number(evidence.score),
        tagScore: Number(evidence.tagScore),
        vectorScore: Number(evidence.vectorScore),
      })),
    };
  }

  async getCampaignCopyInput(scope: EnterpriseScope, campaignId: string) {
    this.requireEnterpriseScope(scope);
    const campaign = await this.prisma.campaign.findFirst({
      include: {
        generationRuns: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { generationInput: true },
        },
        audienceSnapshots: {
          orderBy: { createdAt: "asc" },
          select: { membershipId: true },
        },
      },
      where: { ...scope, id: campaignId },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign was not found in the active enterprise scope");
    }
    if (campaign.selectionSnapshot)
      throw new ConflictException(
        "此活动使用已停用的医疗选择计划，请新建通用活动；原活动和内容仍保留",
      );
    const selector = jsonRecord(campaign.audienceSelector ?? undefined);
    const frozenInput = jsonRecord(campaign.generationRuns[0]?.generationInput ?? undefined);
    const frozenSource = jsonRecord(frozenInput.sourceContext);
    const frozenAssets = jsonRecord(frozenSource.assetSnapshot);
    const frozenEntities = Array.isArray(frozenAssets.geoEntities)
      ? frozenAssets.geoEntities.map(jsonRecord)
      : [];
    const currentFocus = Array.isArray(frozenInput.focusEntityIds)
      ? await this.content.effectiveGeoEntities(scope.tenantId, scope.enterpriseId)
      : undefined;
    return {
      selection: null,
      selectionRequired: false,
      focusEntityIds: currentFocus
        ?.filter((entity) => frozenEntities.some((old) => old.seriesId === entity.seriesId))
        .map(({ id }) => id),
      audienceMode: campaign.audienceMode,
      contentDirection: campaign.contentDirection,
      contentDirectionPresetId: campaign.contentDirectionPresetId,
      departmentId: typeof selector.departmentId === "string" ? selector.departmentId : null,
      imageCount: campaign.imageCount,
      imageStyle: campaign.imageStyle,
      imageStylePresetId: campaign.imageStylePresetId,
      membershipIds: campaign.audienceSnapshots.map(({ membershipId }) => membershipId),
      prompt: campaign.prompt,
      reminderOffsetsHours: campaign.reminderOffsetsHours,
      sourceCampaignId: campaign.id,
      title: campaign.title,
      visibleAt: campaign.visibleAt,
    };
  }

  async archiveCampaign(scope: EnterpriseScope, campaignId: string, input: CampaignArchiveDto) {
    const principal = this.requireEnterpriseScope(scope);
    await this.prisma.$transaction(async (transaction) => {
      const campaign = await transaction.campaign.findFirst({
        where: { ...scope, id: campaignId },
      });
      if (!campaign) {
        throw new NotFoundException("Campaign was not found in the active enterprise scope");
      }
      if (campaign.archivedAt) return;
      if (!new Set(["CANCELLED", "COMPLETED", "EXPIRED"]).has(campaign.status)) {
        throw new ConflictException("Only a terminal campaign can be archived");
      }
      const archivedAt = new Date();
      await transaction.campaign.update({
        data: { archivedAt, archivedBy: principal.userId },
        where: { id: campaign.id },
      });
      await transaction.auditLog.create({
        data: {
          action: "campaign.archive",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId: scope.enterpriseId,
          reason: input.reason,
          resourceId: campaign.id,
          resourceType: "Campaign",
          stateAfter: { archivedAt: archivedAt.toISOString(), status: campaign.status },
          tenantId: scope.tenantId,
        },
      });
    });
    return this.getCampaign(scope, campaignId);
  }

  async restoreCampaign(scope: EnterpriseScope, campaignId: string, input: CampaignArchiveDto) {
    const principal = this.requireEnterpriseScope(scope);
    await this.prisma.$transaction(async (transaction) => {
      const campaign = await transaction.campaign.findFirst({
        where: { ...scope, id: campaignId },
      });
      if (!campaign) {
        throw new NotFoundException("Campaign was not found in the active enterprise scope");
      }
      if (!campaign.archivedAt) return;
      await transaction.campaign.update({
        data: { archivedAt: null, archivedBy: null },
        where: { id: campaign.id },
      });
      await transaction.auditLog.create({
        data: {
          action: "campaign.restore",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId: scope.enterpriseId,
          reason: input.reason,
          resourceId: campaign.id,
          resourceType: "Campaign",
          stateBefore: { archivedAt: campaign.archivedAt.toISOString(), status: campaign.status },
          tenantId: scope.tenantId,
        },
      });
    });
    return this.getCampaign(scope, campaignId);
  }

  async listCampaignWorkItems(
    scope: EnterpriseScope,
    campaignId: string,
    query: CampaignWorkItemQueryDto,
  ) {
    this.requireEnterpriseScope(scope);
    const campaignExists = await this.prisma.campaign.count({
      where: { ...scope, id: campaignId },
    });
    if (campaignExists !== 1) {
      throw new NotFoundException("Campaign was not found in the active enterprise scope");
    }
    const workItems = await this.prisma.generationWorkItem.findMany({
      include: {
        audienceSnapshot: {
          select: { departmentName: true, employeeName: true, employeePhone: true },
        },
      },
      orderBy: createdAtOrderBy(),
      take: pageTake(query),
      where: {
        AND: [{ ...scope, campaignId }, campaignWorkItemWhere(query), createdAtCursorWhere(query)],
      },
    });
    const page = toCursorPage(workItems, query);
    return {
      ...page,
      items: page.items.map(({ audienceSnapshot, errorCode, errorRetryable, ...item }) => ({
        attemptCount: item.attemptCount,
        createdAt: item.createdAt,
        departmentName: audienceSnapshot.departmentName,
        employeeName: audienceSnapshot.employeeName,
        employeePhone: audienceSnapshot.employeePhone,
        errorCategory: customerGenerationErrorCategory(errorCode, errorRetryable),
        finishedAt: item.finishedAt,
        id: item.id,
        membershipId: item.membershipId,
        startedAt: item.startedAt,
        status: item.status,
      })),
    };
  }

  async exportCampaignWorkItemsCsv(
    scope: EnterpriseScope,
    campaignId: string,
    query: CampaignWorkItemQueryDto,
  ) {
    this.requireEnterpriseScope(scope);
    const campaign = await this.prisma.campaign.findFirst({
      select: { id: true },
      where: { ...scope, id: campaignId },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign was not found in the active enterprise scope");
    }
    return Readable.from(this.campaignWorkItemCsvRows(scope, campaignId, query));
  }

  private async *campaignWorkItemCsvRows(
    scope: EnterpriseScope,
    campaignId: string,
    query: CampaignWorkItemQueryDto,
  ): AsyncGenerator<string> {
    yield `\uFEFF${[
      "工作项ID",
      "员工姓名",
      "员工手机号",
      "部门",
      "状态",
      "脱敏错误分类",
      "尝试次数",
      "创建时间",
      "开始时间",
      "完成时间",
    ]
      .map(csvCell)
      .join(",")}\r\n`;
    let cursor: Readonly<{ createdAt: Date; id: string }> | null = null;
    const batchSize = 500;
    for (;;) {
      const rows: CampaignWorkItemCsvRow[] = await this.prisma.generationWorkItem.findMany({
        include: {
          audienceSnapshot: {
            select: { departmentName: true, employeeName: true, employeePhone: true },
          },
        },
        orderBy: createdAtOrderBy(),
        take: batchSize,
        where: {
          AND: [
            { ...scope, campaignId },
            campaignWorkItemWhere(query),
            cursor
              ? {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                }
              : {},
          ],
        },
      });
      for (const row of rows) {
        yield `${[
          row.id,
          row.audienceSnapshot.employeeName,
          row.audienceSnapshot.employeePhone,
          row.audienceSnapshot.departmentName,
          workItemStatusLabel(row.status),
          customerGenerationErrorLabel(
            customerGenerationErrorCategory(row.errorCode, row.errorRetryable),
          ),
          row.attemptCount,
          row.createdAt.toISOString(),
          row.startedAt?.toISOString() ?? null,
          row.finishedAt?.toISOString() ?? null,
        ]
          .map(csvCell)
          .join(",")}\r\n`;
      }
      if (rows.length < batchSize) break;
      const last = rows.at(-1);
      if (!last) break;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
  }

  async getCampaignTimeline(scope: EnterpriseScope, campaignId: string) {
    this.requireEnterpriseScope(scope);
    const campaign = await this.prisma.campaign.findFirst({
      include: {
        blueprint: { select: { createdAt: true } },
        generationRuns: {
          orderBy: { createdAt: "asc" },
          select: {
            createdAt: true,
            finishedAt: true,
            id: true,
            startedAt: true,
            status: true,
          },
        },
        preflightSnapshot: { select: { createdAt: true } },
      },
      where: { ...scope, id: campaignId },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign was not found in the active enterprise scope");
    }
    const [workItemGroups, audits] = await Promise.all([
      this.prisma.generationWorkItem.groupBy({
        _count: { _all: true },
        _max: { finishedAt: true },
        _min: { createdAt: true, startedAt: true },
        by: ["status"],
        where: { ...scope, campaignId },
      }),
      this.prisma.auditLog.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: {
          resourceId: { in: [campaign.id, ...campaign.generationRuns.map(({ id }) => id)] },
          tenantId: scope.tenantId,
        },
      }),
    ]);
    return {
      campaignId,
      events: campaignTimelineEvents(campaign, workItemGroups, audits),
    };
  }

  async retryFailedGeneration(scope: EnterpriseScope, campaignId: string) {
    const principal = this.requireEnterpriseScope(scope);

    const retry = await this.inSerializableTransaction(async (transaction) => {
      await this.lockCampaignForGovernance(transaction, scope, campaignId);
      const campaign = await transaction.campaign.findFirst({
        select: {
          blueprint: { select: { campaignId: true } },
          id: true,
          status: true,
        },
        where: { ...scope, id: campaignId },
      });
      if (!campaign) {
        throw new NotFoundException("Campaign was not found in the active enterprise scope");
      }
      if (campaign.status !== "GENERATION_FAILED") {
        throw new ConflictException("Only a failed generation campaign can retry failed items");
      }
      const run = await transaction.generationRun.findFirst({
        include: { workItems: { where: { status: "FAILED" } } },
        orderBy: { createdAt: "desc" },
        where: { campaignId, status: "FAILED", tenantId: scope.tenantId },
      });
      if (!run || run.workItems.length === 0) {
        throw new ConflictException("No failed employee generation items are available to retry");
      }
      const dispatchVersion = Math.max(...run.workItems.map((item) => item.reservationVersion)) + 1;
      await transaction.generationWorkItem.updateMany({
        data: {
          attemptCount: 0,
          errorCode: null,
          errorMessage: null,
          errorRetryable: null,
          finishedAt: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          nextRetryAt: null,
          queueVersion: { increment: 1 },
          reservationVersion: { increment: 1 },
          startedAt: null,
          status: "QUEUED",
        },
        where: { id: { in: run.workItems.map((item) => item.id) }, tenantId: scope.tenantId },
      });
      const runStatus = campaign.blueprint ? "RUNNING" : "QUEUED";
      const updatedRun = await transaction.generationRun.update({
        data: {
          errorCode: null,
          errorMessage: null,
          errorRetryable: null,
          failedCount: 0,
          finishedAt: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          nextRetryAt: null,
          queueVersion: { increment: 1 },
          status: runStatus,
        },
        select: { queueVersion: true },
        where: { id: run.id },
      });
      await transaction.campaign.update({
        data: { status: "GENERATING" },
        where: { id: campaignId },
      });
      const workItems = await transaction.generationWorkItem.findMany({
        select: { id: true, queueVersion: true, reservationVersion: true },
        where: { id: { in: run.workItems.map((item) => item.id) }, tenantId: scope.tenantId },
      });
      await transaction.auditLog.create({
        data: {
          action: "campaign.generation.retry-failed",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId: scope.enterpriseId,
          resourceId: run.id,
          resourceType: "GenerationRun",
          stateAfter: { dispatchVersion, retryCount: workItems.length, status: runStatus },
          tenantId: scope.tenantId,
        },
      });
      return {
        dispatchVersion,
        hasBlueprint: Boolean(campaign.blueprint),
        medical: Boolean((run.generationInput as Record<string, unknown> | null)?.medicalPlan),
        queueVersion: updatedRun.queueVersion,
        runId: run.id,
        workItems,
      };
    });

    try {
      if (!retry.hasBlueprint) {
        await this.generationQueue.enqueueRun({
          generationRunId: retry.runId,
          queueVersion: retry.queueVersion,
          tenantId: scope.tenantId,
          medical: retry.medical,
        });
      } else {
        await Promise.all(
          retry.workItems.map((item) =>
            this.generationQueue.enqueueWorkItem({
              generationRunId: retry.runId,
              queueVersion: item.queueVersion,
              reservationVersion: item.reservationVersion,
              tenantId: scope.tenantId,
              workItemId: item.id,
              medical: retry.medical,
            }),
          ),
        );
      }
    } catch (error) {
      await this.prisma.auditLog.create({
        data: {
          action: "campaign.generation.retry-dispatch-pending",
          actorType: "SYSTEM",
          enterpriseId: scope.enterpriseId,
          metadata: { error: safeErrorMessage(error) },
          resourceId: retry.runId,
          resourceType: "GenerationRun",
          tenantId: scope.tenantId,
        },
      });
    }
    return this.getCampaign(scope, campaignId);
  }

  async approveCampaign(scope: EnterpriseScope, campaignId: string, input: ApproveCampaignDto) {
    const principal = this.requireEnterpriseScope(scope);
    const taskExpiryHours = await this.platformSettings.number("general.task_expiry_hours");
    const campaign = await this.prisma.$transaction(async (transaction) => {
      await this.lockCampaignForGovernance(transaction, scope, campaignId);
      const existing = await transaction.campaign.findFirst({
        include: {
          audienceSnapshots: { select: { membershipId: true } },
          employeeContents: {
            select: {
              body: true,
              hashtags: true,
              membershipId: true,
              riskAssessment: true,
              status: true,
              title: true,
            },
          },
          distributionTasks: { select: { membershipId: true } },
        },
        where: { ...scope, id: campaignId },
      });
      if (!existing) {
        throw new NotFoundException("Campaign was not found in the active enterprise scope");
      }
      if (existing.status !== "REVIEW_PENDING") {
        throw new ConflictException("活动尚未准备就绪，请先处理生成失败项并完成内容审核。");
      }
      if (
        existing.generatedCount !== existing.audienceCount ||
        existing.audienceCount === 0 ||
        existing.employeeContents.length !== existing.audienceCount ||
        existing.distributionTasks.length !== existing.audienceCount ||
        existing.audienceSnapshots.length !== existing.audienceCount ||
        existing.audienceSnapshots.some(
          ({ membershipId }) =>
            !existing.employeeContents.some((content) => content.membershipId === membershipId) ||
            !existing.distributionTasks.some((task) => task.membershipId === membershipId),
        ) ||
        existing.employeeContents.some(({ status }) => status !== "GENERATED")
      ) {
        throw new ConflictException("仍有员工素材未生成或未通过审核，请处理完成后再排期。");
      }
      existing.employeeContents.forEach(assertContentPublishable);
      const unfinished = await transaction.generationWorkItem.count({
        where: { campaignId, tenantId: scope.tenantId, status: { not: "SUCCEEDED" } },
      });
      if (unfinished > 0) throw new ConflictException("仍有生成任务未完成，请处理失败项后再排期。");
      await this.assertCampaignTasksNotExposed(transaction, scope, campaignId);
      const now = new Date();
      const visibleAt = input.visibleAt
        ? new Date(input.visibleAt)
        : existing.visibleAt > now
          ? existing.visibleAt
          : now;
      if (input.visibleAt) assertFutureCampaignSchedule(visibleAt, now);
      const expiresAt = addHours(visibleAt, taskExpiryHours);
      const status = "APPROVED";
      await transaction.employeeContent.updateMany({
        data: { status: "APPROVED" },
        where: { campaignId, tenantId: scope.tenantId },
      });
      await transaction.distributionTask.updateMany({
        data: { expiresAt, expiredAt: null, status: "LOCKED", visibleAt },
        where: { campaignId, tenantId: scope.tenantId },
      });
      const updated = await transaction.campaign.update({
        data: {
          approvedAt: now,
          approvedBy: principal.userId,
          expiresAt,
          status,
          visibleAt,
        },
        where: { id: campaignId },
      });
      await transaction.auditLog.create({
        data: {
          action: "campaign.approve-and-schedule",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId: scope.enterpriseId,
          resourceId: campaignId,
          resourceType: "Campaign",
          stateAfter: {
            expiresAt: expiresAt.toISOString(),
            status,
            visibleAt: visibleAt.toISOString(),
          },
          tenantId: scope.tenantId,
        },
      });
      return updated;
    });
    return publicCampaign(campaign);
  }

  async acceptContentReview(
    scope: EnterpriseScope,
    campaignId: string,
    contentId: string,
    input: AcceptCampaignContentReviewDto,
  ) {
    const principal = this.requireEnterpriseScope(scope);
    await this.inSerializableTransaction(async (transaction) => {
      await this.lockCampaignForGovernance(transaction, scope, campaignId);
      const content = await transaction.employeeContent.findFirst({
        include: { campaign: { select: { status: true } } },
        where: { ...scope, campaignId, id: contentId },
      });
      if (!content) {
        throw new NotFoundException("Employee content was not found in the active campaign scope");
      }
      if (content.campaign.status !== "REVIEW_PENDING") {
        throw new ConflictException("Review disposition is only allowed while review is pending");
      }
      if (content.status !== "REVIEW_BLOCKED") {
        throw new ConflictException("Only review-blocked employee content can accept a warning");
      }
      assertContentPublishable(content);
      const assessment = reviewRiskAssessment(content.riskAssessment);
      if (assessment.warnings.length === 0 || assessment.unresolvedBlocks.length > 0) {
        throw new ConflictException("Only warning-only content can be accepted by a reviewer");
      }
      const reviewedAt = new Date();
      const nextAssessment = {
        ...assessment.raw,
        passed: true,
        reviewDisposition: {
          reason: input.reason,
          reviewedAt: reviewedAt.toISOString(),
          reviewedBy: principal.userId,
          type: "WARNING_ACCEPTED",
        },
      } satisfies Record<string, unknown>;
      await transaction.employeeContent.update({
        data: {
          riskAssessment: nextAssessment as Prisma.InputJsonValue,
          status: "GENERATED",
        },
        where: { id: content.id },
      });
      await transaction.auditLog.create({
        data: {
          action: "campaign.content-review.accept-warning",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId: scope.enterpriseId,
          reason: input.reason,
          resourceId: content.id,
          resourceType: "EmployeeContent",
          stateAfter: {
            campaignId,
            disposition: "WARNING_ACCEPTED",
            reviewedAt: reviewedAt.toISOString(),
          },
          tenantId: scope.tenantId,
        },
      });
    });
    return this.getCampaign(scope, campaignId);
  }

  async regenerateContent(
    scope: EnterpriseScope,
    campaignId: string,
    contentId: string,
    input: RegenerateCampaignContentDto,
  ) {
    const principal = this.requireEnterpriseScope(scope);

    const queued = await this.inSerializableTransaction(async (transaction) => {
      await this.lockCampaignForGovernance(transaction, scope, campaignId);
      const content = await transaction.employeeContent.findFirst({
        include: { campaign: { select: { status: true } } },
        where: { ...scope, campaignId, id: contentId },
      });
      if (!content) {
        throw new NotFoundException("Employee content was not found in the active campaign scope");
      }
      if (content.campaign.status !== "REVIEW_PENDING") {
        throw new ConflictException("Content can only be regenerated while review is pending");
      }
      const item = await transaction.generationWorkItem.findFirst({
        include: {
          generationRun: { select: { id: true, routingPolicy: true, generationInput: true } },
        },
        orderBy: { createdAt: "desc" },
        where: {
          campaignId,
          membershipId: content.membershipId,
          status: "SUCCEEDED",
          tenantId: scope.tenantId,
        },
      });
      if (!item?.generationRun.routingPolicy) {
        throw new ConflictException(
          "This campaign was not created by the durable generation runtime and cannot be regenerated",
        );
      }
      const plan = jsonRecord(item.generationRun.generationInput).medicalPlan;
      const medical = Boolean(plan);
      const reasons = {
        QUESTION_UNCLEAR: "重新组织主要问题，保持现有冻结事实及发布条件。",
        TOO_MUCH_INFORMATION: "减少信息量，围绕冻结的主要问题表达。",
        IMAGE_TEXT_MISMATCH: "校正图片说明与正文的关系，不能新增经历或医疗承诺。",
        FACT_UPDATE_REQUIRED: "事实需更新",
        AUTHORIZED_MATERIAL_CHANGE: "更换授权素材",
      };
      if (medical && (input.feedback || !input.reasonCode))
        throw new ConflictException("医疗内容请选固定修改原因，不能提交自由提示词");
      if (
        medical &&
        (input.reasonCode === "FACT_UPDATE_REQUIRED" ||
          input.reasonCode === "AUTHORIZED_MATERIAL_CHANGE")
      )
        throw new ConflictException(
          "更新事实或更换素材需要重新选择计划并冻结审核，不能修改当前稿绕过发布条件",
        );
      const feedback = input.reasonCode ? reasons[input.reasonCode] : input.feedback;
      if (!feedback) throw new ConflictException("请选择修改原因");
      if (medical) {
        if (!this.medicalPlanning) throw new ConflictException("医疗计划服务不可用");
        await this.medicalPlanning.assertCurrent(
          transaction,
          scope,
          plan as unknown as Parameters<MedicalPlanningService["assertCurrent"]>[2],
        );
      }
      const updatedItem = await transaction.generationWorkItem.update({
        data: {
          attemptCount: 0,
          errorCode: null,
          errorMessage: null,
          errorRetryable: null,
          finishedAt: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          nextRetryAt: null,
          queueVersion: { increment: 1 },
          reservationVersion: { increment: 1 },
          reviewFeedback: feedback,
          reviewRegenerationCount: { increment: 1 },
          startedAt: null,
          status: "QUEUED",
        },
        select: {
          generationRunId: true,
          id: true,
          queueVersion: true,
          reservationVersion: true,
        },
        where: { id: item.id },
      });
      const [completedCount, failedCount] = await Promise.all([
        transaction.generationWorkItem.count({
          where: { generationRunId: item.generationRunId, status: "SUCCEEDED" },
        }),
        transaction.generationWorkItem.count({
          where: { generationRunId: item.generationRunId, status: "FAILED" },
        }),
      ]);
      await transaction.generationRun.update({
        data: {
          completedCount,
          errorCode: null,
          errorMessage: null,
          errorRetryable: null,
          failedCount,
          finishedAt: null,
          generationInput: {
            ...jsonRecord(item.generationRun.generationInput),
            regenerationTargets: {
              ...jsonRecord(jsonRecord(item.generationRun.generationInput).regenerationTargets),
              [item.id]: input.target,
            },
          } as Prisma.InputJsonValue,
          status: "RUNNING",
        },
        where: { id: item.generationRunId },
      });
      await transaction.campaign.update({
        data: { generatedCount: completedCount, status: "GENERATING" },
        where: { id: campaignId },
      });
      await transaction.auditLog.create({
        data: {
          action: "campaign.content-review.regenerate",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId: scope.enterpriseId,
          reason: feedback,
          resourceId: content.id,
          resourceType: "EmployeeContent",
          stateAfter: {
            campaignId,
            target: input.target,
            queueVersion: updatedItem.queueVersion,
            reservationVersion: updatedItem.reservationVersion,
            workItemId: updatedItem.id,
          },
          tenantId: scope.tenantId,
        },
      });
      return { ...updatedItem, medical };
    });

    try {
      await this.generationQueue.enqueueWorkItem({
        generationRunId: queued.generationRunId,
        queueVersion: queued.queueVersion,
        reservationVersion: queued.reservationVersion,
        tenantId: scope.tenantId,
        workItemId: queued.id,
        medical: queued.medical,
      });
    } catch (error) {
      await this.prisma.auditLog.create({
        data: {
          action: "campaign.content-review.regeneration-dispatch-pending",
          actorType: "SYSTEM",
          enterpriseId: scope.enterpriseId,
          metadata: { error: safeErrorMessage(error) },
          resourceId: queued.id,
          resourceType: "GenerationWorkItem",
          tenantId: scope.tenantId,
        },
      });
    }
    return this.getCampaign(scope, campaignId);
  }

  async rescheduleCampaign(
    scope: EnterpriseScope,
    campaignId: string,
    input: RescheduleCampaignDto,
  ) {
    const principal = this.requireEnterpriseScope(scope);
    const taskExpiryHours = await this.platformSettings.number("general.task_expiry_hours");
    const now = new Date();
    const visibleAt = new Date(input.visibleAt);
    assertFutureCampaignSchedule(visibleAt, now);
    const expiresAt = addHours(visibleAt, taskExpiryHours);
    await this.inSerializableTransaction(async (transaction) => {
      await this.lockCampaignForGovernance(transaction, scope, campaignId);
      const now = new Date();
      assertFutureCampaignSchedule(visibleAt, now);
      const campaign = await transaction.campaign.findFirst({
        where: { ...scope, id: campaignId },
      });
      if (!campaign) {
        throw new NotFoundException("Campaign was not found in the active enterprise scope");
      }
      if (campaign.status !== "APPROVED" || campaign.visibleAt <= now) {
        throw new ConflictException("仅已审核且尚未开放的活动可以改期。");
      }
      const unlockedTasks = await transaction.distributionTask.count({
        where: { campaignId, status: { not: "LOCKED" }, tenantId: scope.tenantId },
      });
      if (unlockedTasks > 0) {
        throw new ConflictException("The campaign has already exposed one or more employee tasks");
      }
      await transaction.distributionTask.updateMany({
        data: { expiresAt, visibleAt },
        where: { campaignId, status: "LOCKED", tenantId: scope.tenantId },
      });
      await transaction.campaign.update({
        data: {
          expiresAt,
          lastRescheduledAt: now,
          lastRescheduledBy: principal.userId,
          visibleAt,
        },
        where: { id: campaign.id },
      });
      await transaction.auditLog.create({
        data: {
          action: "campaign.reschedule",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId: scope.enterpriseId,
          reason: input.reason,
          resourceId: campaign.id,
          resourceType: "Campaign",
          stateAfter: {
            expiresAt: expiresAt.toISOString(),
            visibleAt: visibleAt.toISOString(),
          },
          stateBefore: {
            expiresAt: campaign.expiresAt.toISOString(),
            visibleAt: campaign.visibleAt.toISOString(),
          },
          tenantId: scope.tenantId,
        },
      });
    });
    return this.getCampaign(scope, campaignId);
  }

  async reopenCampaignReview(
    scope: EnterpriseScope,
    campaignId: string,
    input: ReopenCampaignReviewDto,
  ) {
    const principal = this.requireEnterpriseScope(scope);
    await this.inSerializableTransaction(async (transaction) => {
      await this.lockCampaignForGovernance(transaction, scope, campaignId);
      const now = new Date();
      const campaign = await transaction.campaign.findFirst({
        where: { ...scope, id: campaignId },
      });
      if (!campaign) {
        throw new NotFoundException("Campaign was not found in the active enterprise scope");
      }
      if (campaign.status !== "APPROVED" || campaign.visibleAt <= now) {
        throw new ConflictException("活动已正式开放或尚未审核，不能撤销审核。");
      }
      const unlockedTasks = await transaction.distributionTask.count({
        where: { campaignId, status: { not: "LOCKED" }, tenantId: scope.tenantId },
      });
      if (unlockedTasks > 0) {
        throw new ConflictException("The campaign has already exposed one or more employee tasks");
      }
      await transaction.employeeContent.updateMany({
        data: { status: "GENERATED" },
        where: { campaignId, status: "APPROVED", tenantId: scope.tenantId },
      });
      await transaction.campaign.update({
        data: {
          approvedAt: null,
          approvedBy: null,
          status: "REVIEW_PENDING",
        },
        where: { id: campaign.id },
      });
      await transaction.auditLog.create({
        data: {
          action: "campaign.approval.reopen-review",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId: scope.enterpriseId,
          reason: input.reason,
          resourceId: campaign.id,
          resourceType: "Campaign",
          stateAfter: { status: "REVIEW_PENDING" },
          stateBefore: {
            approvedAt: campaign.approvedAt?.toISOString() ?? null,
            approvedBy: campaign.approvedBy,
            status: campaign.status,
          },
          tenantId: scope.tenantId,
        },
      });
    });
    return this.getCampaign(scope, campaignId);
  }

  async getCancellationPreview(scope: EnterpriseScope, campaignId: string) {
    this.requireEnterpriseScope(scope);
    return this.prisma.$transaction(
      async (transaction) => {
        const campaign = await transaction.campaign.findFirst({
          where: { ...scope, id: campaignId },
          select: { status: true, visibleAt: true },
        });
        if (!campaign)
          throw new NotFoundException("Campaign was not found in the active enterprise scope");
        const now = new Date();
        assertCampaignCancellationAllowed(campaign, now);
        await this.assertCampaignTasksNotExposed(transaction, scope, campaignId);
        const [cancelledWorkItems, cancelledGenerationRuns, cancelledDistributionTasks] =
          await Promise.all([
            transaction.generationWorkItem.count({
              where: { ...scope, campaignId, status: { in: ["QUEUED", "RUNNING"] } },
            }),
            transaction.generationRun.count({
              where: { tenantId: scope.tenantId, campaignId, status: { not: "CANCELLED" } },
            }),
            transaction.distributionTask.count({
              where: { ...scope, campaignId, status: { in: ["LOCKED", "EXPIRED"] } },
            }),
          ]);
        return { cancelledWorkItems, cancelledGenerationRuns, cancelledDistributionTasks };
      },
      { isolationLevel: PrismaNamespace.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async cancelCampaign(scope: EnterpriseScope, campaignId: string, input: CancelCampaignDto) {
    const principal = this.requireEnterpriseScope(scope);
    await this.prisma.$transaction(
      async (transaction) => {
        const locked = await transaction.$queryRaw<Array<{ id: string }>>(PrismaNamespace.sql`
          SELECT id
          FROM campaigns
          WHERE id = ${campaignId}
            AND tenant_id = ${scope.tenantId}
            AND enterprise_id = ${scope.enterpriseId}
          FOR UPDATE
        `);
        if (locked.length === 0) {
          throw new NotFoundException("Campaign was not found in the active enterprise scope");
        }
        const campaign = await transaction.campaign.findFirst({
          where: { ...scope, id: campaignId },
        });
        if (!campaign) {
          throw new NotFoundException("Campaign was not found in the active enterprise scope");
        }
        if (campaign.status === "CANCELLED") return;
        const now = new Date();
        assertCampaignCancellationAllowed(campaign, now);
        await this.assertCampaignTasksNotExposed(transaction, scope, campaignId);
        const pendingItems = await transaction.generationWorkItem.findMany({
          select: { id: true },
          where: {
            campaignId,
            status: { in: ["QUEUED", "RUNNING"] },
            tenantId: scope.tenantId,
          },
        });
        if (pendingItems.length > 0) {
          await transaction.generationWorkItem.updateMany({
            data: {
              errorCode: "CAMPAIGN_CANCELLED",
              errorMessage: input.reason,
              errorRetryable: false,
              finishedAt: now,
              heartbeatAt: null,
              leaseExpiresAt: null,
              leaseOwner: null,
              leaseToken: null,
              nextRetryAt: null,
              queueVersion: { increment: 1 },
              status: "CANCELLED",
            },
            where: { id: { in: pendingItems.map(({ id }) => id) }, tenantId: scope.tenantId },
          });
        }
        const cancelledRuns = await transaction.generationRun.updateMany({
          data: {
            errorCode: "CAMPAIGN_CANCELLED",
            errorMessage: input.reason,
            errorRetryable: false,
            finishedAt: now,
            heartbeatAt: null,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            nextRetryAt: null,
            queueVersion: { increment: 1 },
            status: "CANCELLED",
          },
          where: { campaignId, status: { not: "CANCELLED" }, tenantId: scope.tenantId },
        });
        const cancelledTasks = await transaction.distributionTask.updateMany({
          data: { status: "CANCELLED" },
          where: { campaignId, status: { in: ["LOCKED", "EXPIRED"] }, tenantId: scope.tenantId },
        });
        const summary = {
          cancelledDistributionTasks: cancelledTasks.count,
          cancelledGenerationRuns: cancelledRuns.count,
          cancelledWorkItems: pendingItems.length,
        };
        await transaction.campaign.update({
          data: {
            cancellationReason: input.reason,
            cancellationSummary: summary,
            cancelledAt: now,
            cancelledBy: principal.userId,
            status: "CANCELLED",
          },
          where: { id: campaign.id },
        });
        await transaction.auditLog.create({
          data: {
            action: "campaign.cancel",
            actorType: "USER",
            actorUserId: principal.userId,
            enterpriseId: scope.enterpriseId,
            reason: input.reason,
            resourceId: campaign.id,
            resourceType: "Campaign",
            stateAfter: { cancellationSummary: summary, status: "CANCELLED" },
            stateBefore: { status: campaign.status },
            tenantId: scope.tenantId,
          },
        });
      },
      {
        isolationLevel: PrismaNamespace.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 60_000,
      },
    );
    return this.getCampaign(scope, campaignId);
  }

  async listEmployeeTasks() {
    const principal = this.accessContext.requireEmployee();
    const now = new Date();
    await this.reconcileEmployeeTasks(principal.membershipIds, now);
    const tasks = await this.prisma.distributionTask.findMany({
      include: {
        campaign: { select: { id: true, status: true, title: true, selectionSnapshot: true } },
        membership: { select: { publisherContext: true } },
        employeeContent: { include: { images: { orderBy: { sequence: "asc" } } } },
        enterprise: { select: { id: true, name: true } },
        registry: { include: { metrics: { orderBy: { observedAt: "desc" }, take: 1 } } },
        submissions: {
          orderBy: { submittedAt: "desc" },
          select: { failureReason: true },
          take: 1,
        },
      },
      orderBy: [{ visibleAt: "desc" }, { createdAt: "desc" }],
      where: { membershipId: { in: [...principal.membershipIds] } },
    });
    return Promise.all(
      tasks.map((task) =>
        employeeTaskView(task, (images) => this.imageDelivery.signImages(images)),
      ),
    );
  }

  async getEmployeeTask(taskId: string) {
    const principal = this.accessContext.requireEmployee();
    await this.reconcileEmployeeTasks(principal.membershipIds, new Date());
    const task = await this.findEmployeeTask(taskId, principal.membershipIds);
    assertContentPublishable(task.employeeContent);
    return employeeTaskView(task, (images) => this.imageDelivery.signImages(images));
  }

  async viewEmployeeTask(taskId: string) {
    const principal = this.accessContext.requireEmployee();
    const now = new Date();
    await this.reconcileEmployeeTasks(principal.membershipIds, now);
    const task = await this.findEmployeeTask(taskId, principal.membershipIds);
    assertTaskActionable(task, now);
    await this.prisma.distributionTask.update({
      data: {
        firstViewedAt: task.firstViewedAt ?? now,
      },
      where: { id: task.id },
    });
    return this.getEmployeeTask(task.id);
  }

  async confirmEmployeeFacts(taskId: string, input: EmployeeFactsDto) {
    const principal = this.accessContext.requireEmployee();
    const now = new Date();
    await this.reconcileEmployeeTasks(principal.membershipIds, now);
    const task = await this.findEmployeeTask(taskId, principal.membershipIds);
    assertTaskActionable(task, now);
    if (input.confirmed) assertTaskPublishingCurrent(task, now);
    taskMedicalPlan(task);
    if (input.revision !== task.employeeContent.revision)
      throw new ConflictException("请刷新并确认最新内容版本。");
    if (input.confirmed && task.factsReturnedAt && task.factsConfirmedRevision === input.revision)
      throw new ConflictException("该版本已退回企业复核，请等待内容更新后再确认。");
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.distributionTask.updateMany({
        where: {
          id: task.id,
          membershipId: { in: [...principal.membershipIds] },
          status: "AVAILABLE",
          visibleAt: { lte: now },
          expiresAt: { gt: now },
          employeeContent: { revision: input.revision },
          ...(input.confirmed
            ? {
                OR: [
                  { factsReturnedAt: null },
                  { factsConfirmedRevision: { not: input.revision } },
                ],
                membership: {
                  publisherContext: {
                    equals:
                      task.membership.publisherContext === null
                        ? PrismaNamespace.DbNull
                        : task.membership.publisherContext,
                  },
                },
              }
            : {}),
        },
        data: {
          factsConfirmedAt: input.confirmed ? now : null,
          factsConfirmedRevision: input.revision,
          factsReturnedAt: input.confirmed ? null : now,
          factsReturnReason: input.confirmed ? null : input.reason,
        },
      });
      if (updated.count !== 1) throw new ConflictException("任务状态已变化，请刷新后重试。");
      await transaction.auditLog.create({
        data: {
          action: input.confirmed
            ? "employee-content.facts-confirmed"
            : "employee-content.facts-returned",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId: task.enterpriseId,
          tenantId: task.tenantId,
          resourceId: task.employeeContentId,
          resourceType: "EmployeeContent",
          reason: input.confirmed ? "员工确认本人事实与素材真实" : input.reason,
          stateAfter: { revision: input.revision, confirmed: input.confirmed },
        },
      });
    });
    return this.getEmployeeTask(task.id);
  }

  async recordEmployeeTaskEvent(taskId: string, input: EmployeeTaskPermissionDto) {
    const principal = this.accessContext.requireEmployee();
    const now = new Date();
    await this.reconcileEmployeeTasks(principal.membershipIds, now);
    const task = await this.findEmployeeTask(taskId, principal.membershipIds);
    assertTaskActionable(task, now);
    assertTaskPublishingCurrent(task, now);
    assertTaskFactsConfirmed(task, input.revision);
    const permitted = await this.prisma.distributionTask.updateMany({
      data: input.type === "COPY" ? { copiedAt: now } : { downloadedAt: now },
      where: {
        id: task.id,
        membershipId: { in: [...principal.membershipIds] },
        status: "AVAILABLE",
        visibleAt: { lte: now },
        expiresAt: { gt: now },
        employeeContent: { revision: input.revision },
        factsConfirmedAt: { not: null },
        factsConfirmedRevision: input.revision,
        factsReturnedAt: null,
        ...(task.campaign.selectionSnapshot
          ? {
              membership: {
                publisherContext: {
                  equals:
                    task.membership.publisherContext === null
                      ? PrismaNamespace.DbNull
                      : task.membership.publisherContext,
                },
              },
            }
          : {}),
      },
    });
    if (permitted.count !== 1) throw new ConflictException("任务或内容已变化，请刷新后重新确认。");
    return this.getEmployeeTask(task.id);
  }

  async getEnterpriseDashboard(scope: EnterpriseScope, query: DashboardQueryDto) {
    this.requireEnterpriseScope(scope);
    if (query.enterpriseId && query.enterpriseId !== scope.enterpriseId) {
      throw new ForbiddenException("Enterprise dashboard cannot read another enterprise");
    }
    const period = dashboardPeriod(query);
    await this.reconcileEnterprise(scope, new Date());
    const [campaigns, previousCampaigns] = await Promise.all([
      this.prisma.campaign.findMany({
        include: DASHBOARD_CAMPAIGN_INCLUDE,
        orderBy: { createdAt: "desc" },
        where: { ...scope, ...dashboardCampaignWhere(query, period.current) },
      }),
      period.previous
        ? this.prisma.campaign.findMany({
            include: DASHBOARD_CAMPAIGN_INCLUDE,
            orderBy: { createdAt: "desc" },
            where: { ...scope, ...dashboardCampaignWhere({}, period.previous) },
          })
        : Promise.resolve([]),
    ]);
    if (query.campaignId && campaigns.length === 0) {
      throw new NotFoundException("Campaign was not found in the active enterprise scope");
    }
    const details = await dashboardMetricDetails(this.prisma, campaigns);
    return buildDashboard(campaigns, previousCampaigns, period, new Date(), details);
  }

  async getTenantDashboard(tenantId: string, query: DashboardQueryDto) {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "TENANT" || principal.scope.tenantId !== tenantId) {
      throw new ForbiddenException("Active request scope does not match the requested tenant");
    }
    const period = dashboardPeriod(query);
    await this.reconcileTenant(tenantId, new Date());
    const scope = { enterpriseId: query.enterpriseId, tenantId };
    const [campaigns, previousCampaigns] = await Promise.all([
      this.prisma.campaign.findMany({
        include: DASHBOARD_CAMPAIGN_INCLUDE,
        orderBy: { createdAt: "desc" },
        where: { ...scope, ...dashboardCampaignWhere(query, period.current) },
      }),
      period.previous
        ? this.prisma.campaign.findMany({
            include: DASHBOARD_CAMPAIGN_INCLUDE,
            orderBy: { createdAt: "desc" },
            where: { ...scope, ...dashboardCampaignWhere({}, period.previous) },
          })
        : Promise.resolve([]),
    ]);
    const details = await dashboardMetricDetails(this.prisma, campaigns);
    return buildDashboard(campaigns, previousCampaigns, period, new Date(), details);
  }

  async exportEnterpriseDashboardCsv(scope: EnterpriseScope, query: DashboardQueryDto) {
    return Readable.from([dashboardSummaryCsv(await this.getEnterpriseDashboard(scope, query))]);
  }

  async exportTenantDashboardCsv(tenantId: string, query: DashboardQueryDto) {
    return Readable.from([dashboardSummaryCsv(await this.getTenantDashboard(tenantId, query))]);
  }

  async reconcileEmployeeTasks(membershipIds: readonly string[], now: Date): Promise<void> {
    if (membershipIds.length === 0) return;
    await this.prisma.$transaction([
      this.prisma.distributionTask.updateMany({
        data: { status: "AVAILABLE" },
        where: {
          campaign: { status: { in: ["APPROVED", "ACTIVE"] } },
          expiresAt: { gt: now },
          membershipId: { in: [...membershipIds] },
          status: "LOCKED",
          visibleAt: { lte: now },
        },
      }),
      this.prisma.distributionTask.updateMany({
        data: { expiredAt: now, status: "EXPIRED" },
        where: {
          campaign: { status: { in: ["APPROVED", "ACTIVE", "EXPIRED"] } },
          expiresAt: { lte: now },
          membershipId: { in: [...membershipIds] },
          status: { in: ["LOCKED", "AVAILABLE"] },
        },
      }),
      this.prisma.campaign.updateMany({
        data: { status: "ACTIVE" },
        where: {
          distributionTasks: { some: { membershipId: { in: [...membershipIds] } } },
          expiresAt: { gt: now },
          status: "APPROVED",
          visibleAt: { lte: now },
        },
      }),
      this.prisma.campaign.updateMany({
        data: { status: "EXPIRED" },
        where: {
          distributionTasks: { some: { membershipId: { in: [...membershipIds] } } },
          expiresAt: { lte: now },
          status: { in: ["APPROVED", "ACTIVE"] },
        },
      }),
    ]);
  }

  private async reconcileEnterprise(scope: EnterpriseScope, now: Date): Promise<void> {
    await this.reconcileWhere(scope, now);
  }

  private async reconcileTenant(tenantId: string, now: Date): Promise<void> {
    await this.reconcileWhere({ tenantId }, now);
  }

  private async reconcileWhere(
    where: Readonly<{ tenantId: string; enterpriseId?: string }>,
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.distributionTask.updateMany({
        data: { status: "AVAILABLE" },
        where: {
          ...where,
          campaign: { status: { in: ["APPROVED", "ACTIVE"] } },
          expiresAt: { gt: now },
          status: "LOCKED",
          visibleAt: { lte: now },
        },
      }),
      this.prisma.distributionTask.updateMany({
        data: { expiredAt: now, status: "EXPIRED" },
        where: {
          ...where,
          campaign: { status: { in: ["APPROVED", "ACTIVE", "EXPIRED"] } },
          expiresAt: { lte: now },
          status: { in: ["LOCKED", "AVAILABLE"] },
        },
      }),
      this.prisma.campaign.updateMany({
        data: { status: "ACTIVE" },
        where: {
          ...where,
          expiresAt: { gt: now },
          status: "APPROVED",
          visibleAt: { lte: now },
        },
      }),
      this.prisma.campaign.updateMany({
        data: { status: "EXPIRED" },
        where: {
          ...where,
          expiresAt: { lte: now },
          status: { in: ["APPROVED", "ACTIVE"] },
        },
      }),
    ]);
  }

  private async findEmployeeTask(taskId: string, membershipIds: readonly string[]) {
    const task = await this.prisma.distributionTask.findFirst({
      include: {
        campaign: { select: { id: true, status: true, title: true, selectionSnapshot: true } },
        membership: { select: { publisherContext: true } },
        employeeContent: { include: { images: { orderBy: { sequence: "asc" } } } },
        enterprise: { select: { id: true, name: true } },
        registry: { include: { metrics: { orderBy: { observedAt: "desc" }, take: 1 } } },
        submissions: {
          orderBy: { submittedAt: "desc" },
          select: { failureReason: true },
          take: 1,
        },
      },
      where: { id: taskId, membershipId: { in: [...membershipIds] } },
    });
    if (!task) {
      throw new NotFoundException("Employee task was not found for the authenticated user");
    }
    return task;
  }

  private async assertPlanningReferences(scope: EnterpriseScope, input: CreateCampaignDto) {
    if (!input.promptTemplateId && !input.campaignTemplateId) return;
    const [promptTemplate, campaignTemplate] = await Promise.all([
      input.promptTemplateId
        ? this.prisma.promptTemplate.findFirst({
            select: { id: true },
            where: {
              ...scope,
              id: input.promptTemplateId,
              status: "ACTIVE",
            },
          })
        : null,
      input.campaignTemplateId
        ? this.prisma.campaignTemplate.findFirst({
            select: { id: true, selectionSnapshot: true },
            where: {
              ...scope,
              id: input.campaignTemplateId,
              status: "ACTIVE",
            },
          })
        : null,
    ]);
    if (input.promptTemplateId && !promptTemplate) {
      throw new NotFoundException("The selected prompt template is not active in this enterprise");
    }
    if (input.campaignTemplateId && !campaignTemplate) {
      throw new NotFoundException(
        "The selected campaign template is not active in this enterprise",
      );
    }
    if (campaignTemplate?.selectionSnapshot)
      throw new ConflictException("此模板使用已停用的医疗选择计划，请重新填写通用活动要求");
  }

  private async lockCampaignForGovernance(
    transaction: Prisma.TransactionClient,
    scope: EnterpriseScope,
    campaignId: string,
  ) {
    const locked = await transaction.$queryRaw<Array<{ id: string }>>(PrismaNamespace.sql`
      SELECT id FROM campaigns
      WHERE id = ${campaignId} AND tenant_id = ${scope.tenantId} AND enterprise_id = ${scope.enterpriseId}
      FOR UPDATE
    `);
    if (!locked.length)
      throw new NotFoundException("Campaign was not found in the active enterprise scope");
  }

  private async assertCampaignTasksNotExposed(
    transaction: Prisma.TransactionClient,
    scope: EnterpriseScope,
    campaignId: string,
  ) {
    const exposed = await transaction.distributionTask.count({
      where: {
        ...scope,
        campaignId,
        OR: [
          { status: { in: ["AVAILABLE", "VERIFYING", "COMPLETED", "LATE_CORRECTED"] } },
          { firstViewedAt: { not: null } },
          { copiedAt: { not: null } },
          { downloadedAt: { not: null } },
          { submittedAt: { not: null } },
          { verifiedAt: { not: null } },
        ],
      },
    });
    if (exposed > 0)
      throw new ConflictException("已有员工任务开放或被领取，不能取消或重新排期发布。");
  }

  private requireEnterpriseScope(scope: EnterpriseScope) {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "ENTERPRISE" ||
      principal.scope.tenantId !== scope.tenantId ||
      principal.scope.enterpriseId !== scope.enterpriseId
    ) {
      throw new ForbiddenException("Active request scope does not match the campaign enterprise");
    }
    return principal;
  }

  private async inSerializableTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 60_000,
        });
      } catch (error) {
        if (
          attempt < 3 &&
          error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
          (error.code === "P2034" ||
            (error.code === "P2010" &&
              (error.meta?.code === "40001" ||
                /\b40001\b|could not serialize access/iu.test(error.message))))
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new ConflictException("Campaign generation could not acquire a serializable transaction");
  }
}

function sanitizeGeneratedVariant(
  variant: GeneratedEmployeeVariant,
  rules: readonly SensitiveRule[],
): Readonly<{
  variant: GeneratedEmployeeVariant;
  riskAssessment: Record<string, unknown>;
}> {
  const replacedBlocks = new Set<string>();
  const warnings = new Set<string>();
  const notices = new Set<string>();
  const sanitize = (value: string): string => {
    let result = value;
    for (const rule of rules) {
      if (!containsLiteral(result, rule.term)) continue;
      if (rule.severity === "BLOCK") {
        result = replaceLiteral(
          result,
          rule.term,
          rule.replacementSuggestion?.trim() || "合规表述",
        );
        replacedBlocks.add(rule.term);
      } else if (rule.severity === "WARNING") {
        warnings.add(rule.term);
      } else {
        notices.add(rule.term);
      }
    }
    return result;
  };
  const sanitized: GeneratedEmployeeVariant = {
    body: sanitize(variant.body),
    hashtags: variant.hashtags.map(sanitize),
    imagePrompt: sanitize(variant.imagePrompt),
    title: sanitize(variant.title),
  };
  const unresolvedBlocks = rules
    .filter(
      (rule) =>
        rule.severity === "BLOCK" &&
        [sanitized.title, sanitized.body, sanitized.imagePrompt, ...sanitized.hashtags].some(
          (value) => containsLiteral(value, rule.term),
        ),
    )
    .map((rule) => rule.term);
  if (unresolvedBlocks.length > 0) {
    throw new ConflictException(
      `Generated content still contains blocked terms: ${unresolvedBlocks.join(", ")}`,
    );
  }
  return {
    riskAssessment: {
      notices: [...notices],
      passed: true,
      replacedBlocks: [...replacedBlocks],
      unresolvedBlocks,
      warnings: [...warnings],
    },
    variant: sanitized,
  };
}

function containsLiteral(value: string, term: string): boolean {
  return value.toLocaleLowerCase().includes(term.toLocaleLowerCase());
}

function replaceLiteral(value: string, term: string, replacement: string): string {
  return value.replace(new RegExp(escapeRegExp(term), "giu"), replacement);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value.normalize("NFKC")).digest("hex");
}

function normalizeIds(values: readonly string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const ids = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (ids.length !== values.length) {
    throw new ConflictException("Selected membership IDs must be non-empty and unique");
  }
  return ids;
}

function normalizeReminderOffsets(values: readonly number[] | undefined): number[] {
  return [...new Set(values ?? [])].sort((left, right) => left - right);
}

function campaignAudienceSelection(input: CreateCampaignDto): Readonly<{
  membershipIds: string[] | undefined;
  mode: "ALL" | "DEPARTMENT" | "SELECTED";
  selector: Readonly<{ departmentId?: string; membershipIds?: string[] }>;
}> {
  const membershipIds = normalizeIds(input.membershipIds);
  const mode =
    input.audienceMode ?? (input.departmentId ? "DEPARTMENT" : membershipIds ? "SELECTED" : "ALL");
  if (mode === "DEPARTMENT" && !input.departmentId) {
    throw new ConflictException("Department audience selection requires a departmentId");
  }
  if ((mode === "DEPARTMENT" || mode === "SELECTED") && !membershipIds?.length) {
    throw new ConflictException("The selected audience mode requires membershipIds");
  }
  if (mode !== "DEPARTMENT" && input.departmentId) {
    throw new ConflictException("departmentId is only valid for department audience selection");
  }
  return {
    membershipIds,
    mode,
    selector: {
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      ...(membershipIds ? { membershipIds } : {}),
    },
  };
}

function validateCampaignListRange(query: CampaignListQueryDto): void {
  for (const [from, to, label] of [
    [query.createdFrom, query.createdTo, "createdAt"],
    [query.visibleFrom, query.visibleTo, "visibleAt"],
  ] as const) {
    if (from && to && new Date(from) > new Date(to)) {
      throw new ConflictException(`${label} filter start must not be after its end`);
    }
  }
}

function campaignListWhere(query: CampaignListQueryDto): Prisma.CampaignWhereInput {
  const filters: Prisma.CampaignWhereInput[] = [];
  if (query.archive === "ACTIVE") filters.push({ archivedAt: null });
  if (query.archive === "ARCHIVED") filters.push({ archivedAt: { not: null } });
  if (query.search) {
    filters.push({
      OR: [
        { prompt: { contains: query.search, mode: "insensitive" } },
        { title: { contains: query.search, mode: "insensitive" } },
      ],
    });
  }
  if (query.status) filters.push({ status: query.status });
  if (query.createdBy) filters.push({ createdBy: query.createdBy });
  if (query.createdFrom || query.createdTo) {
    filters.push({
      createdAt: {
        gte: query.createdFrom ? new Date(query.createdFrom) : undefined,
        lte: query.createdTo ? new Date(query.createdTo) : undefined,
      },
    });
  }
  if (query.visibleFrom || query.visibleTo) {
    filters.push({
      visibleAt: {
        gte: query.visibleFrom ? new Date(query.visibleFrom) : undefined,
        lte: query.visibleTo ? new Date(query.visibleTo) : undefined,
      },
    });
  }
  if (query.exceptionType === "RETRIED") {
    filters.push({ generationWorkItems: { some: { attemptCount: { gt: 1 } } } });
  } else if (query.exceptionType) {
    filters.push({ generationWorkItems: { some: generationErrorWhere(query.exceptionType) } });
  }
  return filters.length ? { AND: filters } : {};
}

function campaignWorkItemWhere(
  query: CampaignWorkItemQueryDto,
): Prisma.GenerationWorkItemWhereInput {
  const filters: Prisma.GenerationWorkItemWhereInput[] = [];
  if (query.status) filters.push({ status: query.status });
  if (query.department) {
    filters.push({
      audienceSnapshot: { departmentName: { contains: query.department, mode: "insensitive" } },
    });
  }
  if (query.employee) {
    filters.push({
      audienceSnapshot: {
        OR: [
          { employeeName: { contains: query.employee, mode: "insensitive" } },
          { employeePhone: { contains: query.employee } },
        ],
      },
    });
  }
  if (query.errorCategory) filters.push(generationErrorWhere(query.errorCategory));
  return filters.length ? { AND: filters } : {};
}

function generationErrorWhere(
  category: Exclude<CustomerGenerationErrorCategory, null>,
): Prisma.GenerationWorkItemWhereInput {
  const contentCodes = codeContains(["CONTENT", "MODERATION", "POLICY", "SAFETY", "SENSITIVE"]);
  const temporaryCodes = codeContains([
    "CIRCUIT",
    "LEASE",
    "NETWORK",
    "RATE_LIMIT",
    "TIMEOUT",
    "UNAVAILABLE",
    "HTTP_429",
    "HTTP_5",
  ]);
  const configurationCodes = codeContains([
    "BLUEPRINT",
    "CONFIG",
    "CREDENTIAL",
    "MODEL",
    "PROVIDER_DISABLED",
    "ROUTE",
  ]);
  if (category === "CONTENT_COMPLIANCE") return { OR: contentCodes };
  if (category === "TEMPORARY_SERVICE") {
    return { OR: [{ errorRetryable: true }, ...temporaryCodes] };
  }
  if (category === "PLATFORM_CONFIGURATION") return { OR: configurationCodes };
  return {
    errorCode: { not: null },
    NOT: [
      { OR: contentCodes },
      { OR: [{ errorRetryable: true }, ...temporaryCodes] },
      { OR: configurationCodes },
    ],
  };
}

function codeContains(values: readonly string[]): Prisma.GenerationWorkItemWhereInput[] {
  return values.map((value) => ({ errorCode: { contains: value, mode: "insensitive" } }));
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

type CampaignTimelineInput = Readonly<{
  approvedAt: Date | null;
  blueprint: Readonly<{ createdAt: Date }> | null;
  createdAt: Date;
  createdBy: string;
  expiresAt: Date;
  generationRuns: readonly Readonly<{
    createdAt: Date;
    finishedAt: Date | null;
    id: string;
    startedAt: Date | null;
    status: string;
  }>[];
  id: string;
  preflightSnapshot: Readonly<{ createdAt: Date }> | null;
  status: string;
  visibleAt: Date;
}>;

type WorkItemTimelineGroup = Readonly<{
  _count: Readonly<{ _all: number }>;
  _max: Readonly<{ finishedAt: Date | null }>;
  _min: Readonly<{ createdAt: Date | null; startedAt: Date | null }>;
  status: string;
}>;

type CampaignTimelineEvent = Readonly<{
  actorType: "INTEGRATION" | "SYSTEM" | "USER";
  actorUserId: string | null;
  category: string;
  description: string;
  id: string;
  occurredAt: Date;
  source: string;
  status: string;
  title: string;
}>;

function campaignTimelineEvents(
  campaign: CampaignTimelineInput,
  workItemGroups: readonly WorkItemTimelineGroup[],
  audits: readonly AuditLog[],
) {
  const events: CampaignTimelineEvent[] = [
    timelineEvent({
      actorType: "USER",
      actorUserId: campaign.createdBy,
      category: "CAMPAIGN",
      description: "运营人员提交活动输入，系统开始冻结受众、资格与素材证据。",
      id: `campaign-created:${campaign.id}`,
      occurredAt: campaign.createdAt,
      source: "Campaign",
      status: "COMPLETED",
      title: "活动已创建",
    }),
  ];
  if (campaign.preflightSnapshot) {
    events.push(
      timelineEvent({
        category: "PREFLIGHT",
        description: "运行资格和基础设施检查结果已冻结。",
        id: `preflight:${campaign.id}`,
        occurredAt: campaign.preflightSnapshot.createdAt,
        source: "CampaignPreflightSnapshot",
        status: "COMPLETED",
        title: "生成前置检查通过",
      }),
    );
  }
  if (campaign.blueprint) {
    events.push(
      timelineEvent({
        category: "BLUEPRINT",
        description: "后台已根据活动输入和冻结证据生成活动母版。",
        id: `blueprint:${campaign.id}`,
        occurredAt: campaign.blueprint.createdAt,
        source: "CampaignBlueprint",
        status: "COMPLETED",
        title: "活动母版已生成",
      }),
    );
  }
  for (const run of campaign.generationRuns) {
    events.push(
      timelineEvent({
        category: "GENERATION",
        description: "员工级独立图文生成任务已进入后台执行队列。",
        id: `generation-run-created:${run.id}`,
        occurredAt: run.createdAt,
        source: "GenerationRun",
        status: "QUEUED",
        title: "生成批次已建立",
      }),
    );
    if (run.startedAt) {
      events.push(
        timelineEvent({
          category: "GENERATION",
          description: "后台 Worker 已开始处理该生成批次。",
          id: `generation-run-started:${run.id}`,
          occurredAt: run.startedAt,
          source: "GenerationRun",
          status: "RUNNING",
          title: "生成批次开始执行",
        }),
      );
    }
    if (run.finishedAt) {
      events.push(
        timelineEvent({
          category: "GENERATION",
          description:
            run.status === "SUCCEEDED"
              ? "本批次员工图文已全部完成。"
              : "本批次存在最终失败项，可按权限执行局部恢复。",
          id: `generation-run-finished:${run.id}`,
          occurredAt: run.finishedAt,
          source: "GenerationRun",
          status: run.status,
          title: run.status === "SUCCEEDED" ? "生成批次完成" : "生成批次异常结束",
        }),
      );
    }
  }
  for (const group of workItemGroups) {
    const occurredAt = group._max.finishedAt ?? group._min.startedAt ?? group._min.createdAt;
    if (!occurredAt) continue;
    events.push(
      timelineEvent({
        category: "WORK_ITEMS",
        description: `${group._count._all} 个员工生成项：${workItemStatusLabel(group.status)}。`,
        id: `work-items:${campaign.id}:${group.status}`,
        occurredAt,
        source: "GenerationWorkItem",
        status: group.status,
        title: "员工生成项汇总",
      }),
    );
  }
  if (campaign.approvedAt) {
    events.push(
      timelineEvent({
        category: "APPROVAL",
        description: "活动已通过人工审核，并冻结统一素材解锁时间。",
        id: `campaign-approved:${campaign.id}`,
        occurredAt: campaign.approvedAt,
        source: "Campaign",
        status: "COMPLETED",
        title: "活动已批准",
      }),
      timelineEvent({
        category: "DISTRIBUTION",
        description: "员工从该时间起可以查看各自独立文案和图片。",
        id: `campaign-visible:${campaign.id}`,
        occurredAt: campaign.visibleAt,
        source: "Campaign",
        status: campaign.visibleAt <= new Date() ? "COMPLETED" : "SCHEDULED",
        title: "员工素材统一解锁",
      }),
    );
  }
  for (const audit of audits) {
    const mapped = auditTimelineEvent(audit);
    if (mapped) events.push(mapped);
  }
  return events.sort(
    (left, right) =>
      left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id),
  );
}

function timelineEvent(
  input: Omit<CampaignTimelineEvent, "actorType" | "actorUserId"> &
    Partial<Pick<CampaignTimelineEvent, "actorType" | "actorUserId">>,
): CampaignTimelineEvent {
  return {
    actorType: input.actorType ?? "SYSTEM",
    actorUserId: input.actorUserId ?? null,
    category: input.category,
    description: input.description,
    id: input.id,
    occurredAt: input.occurredAt,
    source: input.source,
    status: input.status,
    title: input.title,
  };
}

function auditTimelineEvent(audit: AuditLog): CampaignTimelineEvent | null {
  const labels: Record<string, readonly [string, string, string]> = {
    "campaign.archive": ["ARCHIVE", "活动已归档", "活动从默认运营列表隐藏。"],
    "campaign.approval.reopen-review": ["REVIEW", "活动已撤销批准", "活动重新进入人工审核阶段。"],
    "campaign.cancel": ["CANCELLATION", "活动已取消", "未执行工作项已终止。"],
    "campaign.content-review.accept-warning": [
      "REVIEW",
      "审核员已接受警告",
      "警告内容已带原因完成人工处置。",
    ],
    "campaign.content-review.regenerate": [
      "REVIEW",
      "员工内容已要求重生成",
      "审核意见已加入该员工的差异化生成输入。",
    ],
    "campaign.generation.retry-failed": [
      "RECOVERY",
      "失败员工项已重试",
      "系统只重新调度最终失败的员工生成项。",
    ],
    "campaign.reschedule": ["SCHEDULE", "活动已改期", "统一解锁和失效时间已同步更新。"],
    "campaign.restore": ["ARCHIVE", "活动已恢复", "活动重新进入默认运营列表。"],
    "generation.run.attempts-exhausted": [
      "RECOVERY",
      "生成批次重试耗尽",
      "自动恢复次数已达到上限，需要平台介入。",
    ],
    "generation.run.failed": ["GENERATION", "生成批次失败", "生成批次进入失败状态。"],
    "generation.run.lease-recovered": [
      "RECOVERY",
      "生成批次租约已恢复",
      "系统发现过期租约并重新调度。",
    ],
    "generation.run.manual-recovery": [
      "RECOVERY",
      "平台已执行人工恢复",
      "平台运行人员重新调度了异常生成批次。",
    ],
    "generation.run.queue-compensated": [
      "RECOVERY",
      "生成队列已补偿",
      "系统重新派发了缺失的持久化生成任务。",
    ],
  };
  const label = labels[audit.action];
  if (!label) return null;
  return timelineEvent({
    actorType: audit.actorType,
    actorUserId: audit.actorUserId,
    category: label[0],
    description: audit.reason ?? label[2],
    id: `audit:${audit.id}`,
    occurredAt: audit.createdAt,
    source: "AuditLog",
    status: "COMPLETED",
    title: label[1],
  });
}

function addHours(value: Date, hours: number): Date {
  return new Date(value.getTime() + hours * 3_600_000);
}

function useInlineGeneration(): boolean {
  if (process.env.VITEST === "true") return true;
  return process.env.GENERATION_EXECUTION_MODE === "inline";
}

function requireRetrievalEvidence(retrieval: MaterialRetrievalResult): void {
  if (retrieval.hits.length === 0) {
    throw new ConflictException({
      code: "MATERIAL_RETRIEVAL_EMPTY",
      message: "No authorized READY material evidence matched this campaign prompt",
    });
  }
}

function retrievalMaterialIds(retrieval: MaterialRetrievalResult): string[] {
  return [...new Set(retrieval.hits.map((hit) => hit.materialId))];
}

function retrievalEvidenceRows(
  campaignId: string,
  scope: EnterpriseScope,
  retrieval: MaterialRetrievalResult,
): Prisma.CampaignRetrievalEvidenceCreateManyInput[] {
  return retrieval.hits.map((hit) => ({
    campaignId,
    chunkId: hit.chunkId,
    enterpriseId: scope.enterpriseId,
    frozenSnippet: hit.snippet,
    hitReasons: [...hit.hitReasons],
    id: randomUUID(),
    lexicalScore: new PrismaNamespace.Decimal(hit.lexicalScore),
    materialId: hit.materialId,
    materialScopeKey: hit.materialScopeKey,
    materialSeriesId: hit.materialSeriesId,
    materialTitle: hit.materialTitle,
    materialType: hit.materialType,
    materialVersion: hit.materialVersion,
    rank: hit.rank,
    score: new PrismaNamespace.Decimal(hit.score),
    strategyVersion: retrieval.strategyVersion,
    tagScore: new PrismaNamespace.Decimal(hit.tagScore),
    tenantId: scope.tenantId,
    vectorScore: new PrismaNamespace.Decimal(hit.vectorScore),
  }));
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown queue dispatch error").slice(0, 500);
}

type CustomerGenerationErrorCategory =
  | "CONTENT_COMPLIANCE"
  | "INTERNAL_ERROR"
  | "PLATFORM_CONFIGURATION"
  | "TEMPORARY_SERVICE";

function workItemStatusLabel(status: string): string {
  if (status === "QUEUED") return "等待生成";
  if (status === "RUNNING") return "正在生成";
  if (status === "SUCCEEDED") return "已生成";
  if (status === "FAILED") return "未成功生成";
  if (status === "CANCELLED") return "已取消";
  return "状态待确认";
}

function customerGenerationErrorLabel(category: string | null): string {
  if (category === null) return "无";
  if (category === "CONTENT_COMPLIANCE") return "内容合规阻断";
  if (category === "INTERNAL_ERROR") return "系统执行异常";
  if (category === "PLATFORM_CONFIGURATION") return "平台配置异常";
  if (category === "TEMPORARY_SERVICE") return "临时服务异常";
  return "未知错误";
}

function customerGenerationErrorCategory(
  errorCode: string | null,
  retryable: boolean | null,
): CustomerGenerationErrorCategory | null {
  if (!errorCode) return null;
  const code = errorCode.toLocaleUpperCase();
  if (/(CONTENT|MODERATION|POLICY|SAFETY|SENSITIVE)/u.test(code)) {
    return "CONTENT_COMPLIANCE";
  }
  if (
    retryable ||
    /(CIRCUIT|LEASE|NETWORK|RATE_LIMIT|TIMEOUT|UNAVAILABLE|HTTP_429|HTTP_5)/u.test(code)
  ) {
    return "TEMPORARY_SERVICE";
  }
  if (/(BLUEPRINT|CONFIG|CREDENTIAL|MODEL|PROVIDER_DISABLED|ROUTE)/u.test(code)) {
    return "PLATFORM_CONFIGURATION";
  }
  return "INTERNAL_ERROR";
}

function customerSourceContext(value: Prisma.JsonValue) {
  const source = jsonRecord(value);
  const assetSnapshot = jsonRecord(source.assetSnapshot);
  const geoEntities = jsonArray(source.geoEntities);
  const materialTitles = jsonArray(source.materialTitles).filter(
    (title): title is string => typeof title === "string",
  );
  return {
    geoEntityCount: geoEntities.length,
    geoTopicCount: geoEntities.reduce<number>(
      (total, entity) => total + jsonArray(jsonRecord(entity).topics).length,
      0,
    ),
    materialCount: Math.max(materialTitles.length, jsonArray(assetSnapshot.materials).length),
    materialTitles,
    schemaVersion: typeof source.schemaVersion === "string" ? source.schemaVersion : null,
    sensitiveRuleCount: jsonArray(assetSnapshot.sensitiveRules).length,
  };
}

function reviewRiskAssessment(value: Prisma.JsonValue) {
  const raw = jsonRecord(value);
  return {
    raw: raw as Record<string, unknown>,
    unresolvedBlocks: jsonArray(raw.unresolvedBlocks).filter(
      (entry): entry is string => typeof entry === "string",
    ),
    warnings: jsonArray(raw.warnings).filter((entry): entry is string => typeof entry === "string"),
  };
}

function customerContentRevisionSnapshot(value: Prisma.JsonValue) {
  const snapshot = jsonRecord(value);
  const risk = jsonRecord(snapshot.riskAssessment);
  return {
    body: typeof snapshot.body === "string" ? snapshot.body : "",
    contentFingerprint:
      typeof snapshot.contentFingerprint === "string" ? snapshot.contentFingerprint : "",
    hashtags: jsonArray(snapshot.hashtags).filter(
      (entry): entry is string => typeof entry === "string",
    ),
    images: jsonArray(snapshot.images).map((value) => {
      const image = jsonRecord(value);
      return {
        byteSize: typeof image.byteSize === "string" ? image.byteSize : null,
        checksum: typeof image.checksum === "string" ? image.checksum : "",
        height: typeof image.height === "number" ? image.height : 0,
        mimeType: typeof image.mimeType === "string" ? image.mimeType : "application/octet-stream",
        perceptualHash: typeof image.perceptualHash === "string" ? image.perceptualHash : null,
        sequence: typeof image.sequence === "number" ? image.sequence : 0,
        width: typeof image.width === "number" ? image.width : 0,
      };
    }),
    riskAssessment: {
      notices: jsonArray(risk.notices).filter(
        (entry): entry is string => typeof entry === "string",
      ),
      passed: risk.passed === true,
      replacedBlocks: jsonArray(risk.replacedBlocks).filter(
        (entry): entry is string => typeof entry === "string",
      ),
      reviewDisposition:
        risk.reviewDisposition && typeof risk.reviewDisposition === "object"
          ? risk.reviewDisposition
          : null,
      unresolvedBlocks: jsonArray(risk.unresolvedBlocks).filter(
        (entry): entry is string => typeof entry === "string",
      ),
      warnings: jsonArray(risk.warnings).filter(
        (entry): entry is string => typeof entry === "string",
      ),
    },
    status: typeof snapshot.status === "string" ? snapshot.status : "GENERATED",
    synthetic: snapshot.synthetic === true,
    title: typeof snapshot.title === "string" ? snapshot.title : "",
  };
}

function jsonRecord(value: Prisma.JsonValue | undefined): Record<string, Prisma.JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, Prisma.JsonValue>;
}

function jsonArray(value: Prisma.JsonValue | undefined): Prisma.JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function assertTaskActionable(
  task: Readonly<{
    status: string;
    visibleAt: Date;
    expiresAt: Date;
    employeeContent: ContentSafetyText & { riskAssessment: Prisma.JsonValue };
  }>,
  now: Date,
): void {
  if (now < task.visibleAt) {
    throw new ForbiddenException("Task content is locked until its scheduled publish time");
  }
  if (now >= task.expiresAt || task.status === "EXPIRED") {
    throw new ConflictException("Task has expired and is recorded as incomplete");
  }
  if (task.status !== "AVAILABLE") {
    throw new ConflictException("该任务当前不能执行此操作，请返回任务列表查看最新状态。");
  }
  assertContentPublishable(task.employeeContent);
}

function contentHasUnresolvedBlock(
  content: ContentSafetyText & { riskAssessment: Prisma.JsonValue },
): boolean {
  const risk = jsonRecord(content.riskAssessment);
  const external = jsonRecord(risk.contentSafety);
  return (
    jsonArray(risk.unresolvedBlocks).length > 0 ||
    external.decision === "BLOCK" ||
    jsonArray(external.categories).some((category) => jsonRecord(category).decision === "BLOCK") ||
    medicalPromotionCategories(content).some((category) => category.decision === "BLOCK")
  );
}

function assertContentPublishable(
  content: ContentSafetyText & { riskAssessment: Prisma.JsonValue },
) {
  if (contentHasUnresolvedBlock(content)) {
    throw new ConflictException(
      "该素材存在禁止发布的内容风险，已停止分发；请联系企业管理员重新生成并审核。",
    );
  }
}

async function employeeTaskView<
  T extends {
    id: string;
    status: string;
    visibleAt: Date;
    expiresAt: Date;
    firstViewedAt: Date | null;
    copiedAt: Date | null;
    downloadedAt: Date | null;
    submittedAt: Date | null;
    verifiedAt: Date | null;
    enterprise: { id: string; name: string };
    membershipId: string;
    membership?: { publisherContext: unknown };
    campaign: { id: string; title: string; status: string; selectionSnapshot?: unknown };
    factsConfirmedAt?: Date | null;
    factsConfirmedRevision?: number | null;
    factsReturnedAt?: Date | null;
    employeeContent: {
      revision: number;
      title: string;
      body: string;
      hashtags: string[];
      riskAssessment: Prisma.JsonValue;
      synthetic: boolean;
      images: Array<{
        id: string;
        imageUrl: string;
        storageKey: string | null;
        byteSize: bigint | null;
        mimeType: string;
        width: number;
        height: number;
        synthetic: boolean;
      }>;
    };
    registry: null | {
      normalizedUrl: string;
      verifiedAt: Date;
      metrics: Array<{
        observedAt: Date;
        rawData: Prisma.JsonValue | null;
        views: number | null;
        likes: number | null;
        comments: number | null;
        favorites: number | null;
        shares: number | null;
      }>;
    };
    submissions: Array<{ failureReason: string | null }>;
  },
>(task: T, signImages: (images: T["employeeContent"]["images"]) => Promise<unknown[]>) {
  let publishingCurrent = true;
  try {
    assertTaskPublishingCurrent(task);
  } catch {
    publishingCurrent = false;
  }
  const contentVisible =
    publishingCurrent &&
    !["LOCKED", "EXPIRED", "CANCELLED"].includes(task.status) &&
    !contentHasUnresolvedBlock(task.employeeContent);
  return {
    campaign: { id: task.campaign.id, title: task.campaign.title, status: task.campaign.status },
    contentRevision: task.employeeContent.revision,
    factsConfirmationRequired: true,
    factsConfirmed: taskFactsConfirmed(task),
    factsReturned: Boolean(
      task.factsReturnedAt && task.factsConfirmedRevision === task.employeeContent.revision,
    ),
    publishingArrangement: task.campaign.selectionSnapshot
      ? "发布安排由企业维护；如信息有变化，请退回企业复核。"
      : null,
    content: contentVisible
      ? {
          body: task.employeeContent.body,
          hashtags: task.employeeContent.hashtags,
          images: await signImages(task.employeeContent.images),
          synthetic: task.employeeContent.synthetic,
          title: task.employeeContent.title,
        }
      : null,
    contentVisible,
    copiedAt: task.copiedAt,
    downloadedAt: task.downloadedAt,
    enterprise: task.enterprise,
    expiresAt: task.expiresAt,
    firstViewedAt: task.firstViewedAt,
    id: task.id,
    publication: task.registry
      ? {
          latestMetrics: task.registry.metrics[0]
            ? publicMetricSnapshot(task.registry.metrics[0])
            : null,
          normalizedUrl: task.registry.normalizedUrl,
          verifiedAt: task.registry.verifiedAt,
        }
      : null,
    status: task.status,
    submissionFailureReason: task.submissions[0]?.failureReason ?? null,
    submittedAt: task.submittedAt,
    verifiedAt: task.verifiedAt,
    visibleAt: task.visibleAt,
  };
}

type DashboardRange = Readonly<{ from: Date | null; to: Date | null }>;
type DashboardPeriod = Readonly<{
  current: DashboardRange;
  previous: DashboardRange | null;
}>;

type DashboardMetricDetails = Readonly<{
  snapshots: PublishMetricSnapshot[];
  jobs: Pick<
    PublicationCollectionJob,
    "submissionId" | "windowHours" | "status" | "dueAt" | "observedAt"
  >[];
}>;

async function dashboardMetricDetails(
  prisma: PrismaService,
  campaigns: readonly DashboardCampaign[],
): Promise<DashboardMetricDetails> {
  const registries = campaigns.flatMap((campaign) =>
    campaign.distributionTasks.flatMap((task) => (task.registry ? [task.registry] : [])),
  );
  const tenantId = campaigns[0]?.tenantId;
  if (!tenantId || registries.length === 0) return { jobs: [], snapshots: [] };
  const [snapshots, jobs] = await Promise.all([
    prisma.publishMetricSnapshot.findMany({
      distinct: ["registryId", "windowHours"],
      orderBy: [{ observedAt: "desc" }, { ingestedAt: "desc" }, { id: "desc" }],
      where: {
        registryId: { in: registries.map(({ id }) => id) },
        tenantId,
        windowHours: { in: [0, 24, 72] },
      },
    }),
    prisma.publicationCollectionJob.findMany({
      select: {
        dueAt: true,
        observedAt: true,
        status: true,
        submissionId: true,
        windowHours: true,
      },
      where: {
        kind: "METRICS",
        submissionId: { in: registries.map(({ submissionId }) => submissionId) },
      },
    }),
  ]);
  return { jobs, snapshots };
}

function buildDashboard(
  campaigns: readonly DashboardCampaign[],
  previousCampaigns: readonly DashboardCampaign[],
  period: DashboardPeriod,
  now: Date,
  details: DashboardMetricDetails,
) {
  const rows = dashboardRows(campaigns);
  const previousRows = dashboardRows(previousCampaigns);
  const summary = dashboardSummary(campaigns, rows);
  const previousSummary = period.previous
    ? dashboardSummary(previousCampaigns, previousRows)
    : null;
  const incomplete = rows.filter(({ status }) => status === "EXPIRED");
  const rankings = [...rows]
    .filter(
      (row): row is typeof row & { latestMetrics: NonNullable<typeof row.latestMetrics> } =>
        ["COMPLETED", "LATE_CORRECTED"].includes(row.status) &&
        row.latestMetrics?.views !== null &&
        row.latestMetrics?.views !== undefined,
    )
    .sort((left, right) => (right.latestMetrics.views ?? 0) - (left.latestMetrics.views ?? 0))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const rowsByRegistry = new Map<string, (typeof rows)[number]>();
  const rowsBySubmission = new Map<string, (typeof rows)[number]>();
  const rowsByTaskId = new Map(rows.map((row) => [row.taskId, row]));
  for (const campaign of campaigns) {
    for (const task of campaign.distributionTasks) {
      const row = rowsByTaskId.get(task.id);
      if (!row || !task.registry || !["COMPLETED", "LATE_CORRECTED"].includes(row.status)) continue;
      rowsByRegistry.set(task.registry.id, row);
      rowsBySubmission.set(task.registry.submissionId, row);
    }
  }
  const sampleKeys = new Set(
    details.snapshots.map((snapshot) => `${snapshot.registryId}:${snapshot.windowHours}`),
  );
  const metricObservations = [
    ...details.snapshots.flatMap((snapshot) => {
      const row = rowsByRegistry.get(snapshot.registryId);
      return row ? [{ ...row, latestMetrics: publicMetricSnapshot(snapshot) }] : [];
    }),
    ...[...rowsByRegistry.values()].flatMap((row) =>
      row.latestMetrics &&
      !sampleKeys.has(`${row.latestMetrics.registryId}:${row.latestMetrics.windowHours}`)
        ? [row]
        : [],
    ),
  ].sort(
    (left, right) =>
      (right.latestMetrics?.observedAt?.getTime() ?? 0) -
      (left.latestMetrics?.observedAt?.getTime() ?? 0),
  );
  const registryBySubmission = new Map(
    campaigns.flatMap((campaign) =>
      campaign.distributionTasks.flatMap((task) =>
        task.registry ? [[task.registry.submissionId, task.registry] as const] : [],
      ),
    ),
  );
  const metricWindows = details.jobs
    .flatMap((job) => {
      const row = rowsBySubmission.get(job.submissionId);
      const registry = registryBySubmission.get(job.submissionId);
      if (!row || !registry) return [];
      return [
        {
          campaignTitle: row.campaignTitle,
          dueAt: job.dueAt,
          employeeName: row.employeeName,
          hasSnapshot: sampleKeys.has(`${registry.id}:${job.windowHours}`),
          observedAt: job.observedAt,
          status: job.status,
          taskId: row.taskId,
          windowHours: job.windowHours,
        },
      ];
    })
    .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());
  return {
    campaigns: campaigns.map((campaign) => ({
      audienceCount: campaign.audienceCount,
      completedCount: campaign.distributionTasks.filter(({ status }) => status === "COMPLETED")
        .length,
      contentDirection: campaign.contentDirection,
      enterprise: campaign.enterprise,
      expiresAt: campaign.expiresAt,
      id: campaign.id,
      imageStyle: campaign.imageStyle,
      status: campaign.status,
      title: campaign.title,
      visibleAt: campaign.visibleAt,
    })),
    contentComparisons: dashboardContentComparisons(campaigns),
    enterpriseComparisons: dashboardEnterpriseComparisons(campaigns),
    incompleteEmployees: incomplete,
    metricObservations,
    metricWindows,
    period: {
      from: period.current.from,
      previousFrom: period.previous?.from ?? null,
      previousTo: period.previous?.to ?? null,
      to: period.current.to,
    },
    previousSummary,
    rankings,
    reminders: dashboardReminders(campaigns, now),
    summary,
    summaryChanges: previousSummary
      ? {
          completionRate: summary.completionRate - previousSummary.completionRate,
          lateCorrectedCount: summary.lateCorrectedCount - previousSummary.lateCorrectedCount,
          taskCount: summary.taskCount - previousSummary.taskCount,
          verifiedCount: summary.verifiedCount - previousSummary.verifiedCount,
          views:
            summary.metricTotals.views !== null && previousSummary.metricTotals.views !== null
              ? summary.metricTotals.views - previousSummary.metricTotals.views
              : null,
        }
      : null,
  };
}

function dashboardRows(campaigns: readonly DashboardCampaign[]) {
  return campaigns.flatMap((campaign) =>
    campaign.distributionTasks.map((task) => {
      const latest = task.registry?.metrics[0]
        ? publicMetricSnapshot(task.registry.metrics[0])
        : null;
      return {
        campaignId: campaign.id,
        campaignTitle: campaign.title,
        employeeName: task.employeeContent.audienceSnapshot.employeeName,
        employeePhone: maskPhone(task.employeeContent.audienceSnapshot.employeePhone),
        enterpriseId: campaign.enterprise.id,
        enterpriseName: campaign.enterprise.name,
        expiresAt: task.expiresAt,
        latestMetrics: latest,
        membershipId: task.membershipId,
        status: task.status,
        taskId: task.id,
        verifiedAt: task.verifiedAt,
      };
    }),
  );
}

function dashboardSummary(
  campaigns: readonly DashboardCampaign[],
  rows: ReturnType<typeof dashboardRows>,
) {
  const verified = rows.filter(({ status }) => status === "COMPLETED");
  const lateCorrected = rows.filter(({ status }) => status === "LATE_CORRECTED");
  const incomplete = rows.filter(({ status }) => status === "EXPIRED");
  const metricNames = ["views", "likes", "comments", "favorites", "shares"] as const;
  type MetricName = (typeof metricNames)[number];
  const metricTotals: Record<MetricName, number | null> = {
    comments: null,
    favorites: null,
    likes: null,
    shares: null,
    views: null,
  };
  const metricCoverage: Record<MetricName, number> = {
    comments: 0,
    favorites: 0,
    likes: 0,
    shares: 0,
    views: 0,
  };
  for (const row of rows) {
    const metric = row.latestMetrics;
    if (!metric) continue;
    for (const name of metricNames) {
      const value = metric[name];
      if (value === null) continue;
      metricTotals[name] = (metricTotals[name] ?? 0) + value;
      metricCoverage[name] += 1;
    }
  }
  return {
    campaignCount: campaigns.length,
    completionRate: rows.length === 0 ? 0 : verified.length / rows.length,
    expiredIncompleteCount: incomplete.length,
    lateCorrectedCount: lateCorrected.length,
    metricCoverage,
    metricTotals,
    taskCount: rows.length,
    verifiedCount: verified.length,
  };
}

function dashboardEnterpriseComparisons(campaigns: readonly DashboardCampaign[]) {
  const groups = groupByValues(campaigns, (campaign) => campaign.enterprise.id);
  return [...groups.entries()]
    .map(([enterpriseId, enterpriseCampaigns]) => {
      const rows = dashboardRows(enterpriseCampaigns);
      return {
        enterpriseId,
        enterpriseName: enterpriseCampaigns[0]?.enterprise.name ?? "",
        ...dashboardSummary(enterpriseCampaigns, rows),
      };
    })
    .sort((left, right) =>
      right.completionRate === left.completionRate
        ? (right.metricTotals.views ?? -1) - (left.metricTotals.views ?? -1)
        : right.completionRate - left.completionRate,
    );
}

function dashboardContentComparisons(campaigns: readonly DashboardCampaign[]) {
  const dimensions = [
    {
      dimension: "CONTENT_DIRECTION" as const,
      value: (campaign: DashboardCampaign) => campaign.contentDirection || "未分类",
    },
    {
      dimension: "IMAGE_STYLE" as const,
      value: (campaign: DashboardCampaign) => campaign.imageStyle || "未分类",
    },
    {
      dimension: "VISIBLE_HOUR" as const,
      value: (campaign: DashboardCampaign) =>
        `${campaign.visibleAt.getHours().toString().padStart(2, "0")}:00`,
    },
  ];
  return dimensions.flatMap(({ dimension, value }) =>
    [...groupByValues(campaigns, value).entries()].map(([groupValue, groupCampaigns]) => {
      const rows = dashboardRows(groupCampaigns);
      const summary = dashboardSummary(groupCampaigns, rows);
      return {
        campaignCount: summary.campaignCount,
        completionRate: summary.completionRate,
        dimension,
        taskCount: summary.taskCount,
        value: groupValue,
        viewCoverage: summary.metricCoverage.views,
        views: summary.metricTotals.views,
      };
    }),
  );
}

function dashboardReminders(campaigns: readonly DashboardCampaign[], now: Date) {
  return campaigns.flatMap((campaign) => {
    if (campaign.status === "CANCELLED" || campaign.status === "EXPIRED") return [];
    const pendingCount = campaign.distributionTasks.filter(
      ({ status }) => !["COMPLETED", "LATE_CORRECTED"].includes(status),
    ).length;
    return campaign.reminderOffsetsHours.map((offsetHours) => {
      const dueAt = addHours(campaign.visibleAt, offsetHours);
      return {
        campaignId: campaign.id,
        campaignTitle: campaign.title,
        dueAt,
        offsetHours,
        pendingCount,
        status: pendingCount === 0 ? "COMPLETED" : dueAt <= now ? "DUE" : "UPCOMING",
      };
    });
  });
}

function dashboardPeriod(query: DashboardQueryDto): DashboardPeriod {
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  if (from && to && from > to) {
    throw new ConflictException("Dashboard period start must not be after its end");
  }
  if ((from && !to) || (!from && to)) {
    throw new ConflictException("Dashboard comparison requires both from and to");
  }
  if (!from || !to) return { current: { from, to }, previous: null };
  const duration = to.getTime() - from.getTime() + 1;
  if (duration > 366 * 24 * 60 * 60 * 1000) {
    throw new ConflictException("Dashboard period cannot exceed 366 days");
  }
  const previousTo = new Date(from.getTime() - 1);
  const previousFrom = new Date(previousTo.getTime() - duration + 1);
  return {
    current: { from, to },
    previous: { from: previousFrom, to: previousTo },
  };
}

function dashboardCampaignWhere(
  query: Pick<DashboardQueryDto, "campaignId">,
  range: DashboardRange,
): Prisma.CampaignWhereInput {
  return {
    id: query.campaignId,
    visibleAt:
      range.from || range.to
        ? {
            gte: range.from ?? undefined,
            lte: range.to ?? undefined,
          }
        : undefined,
  };
}

function groupByValues<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

type DashboardExportData = ReturnType<typeof buildDashboard>;

function dashboardSummaryCsv(dashboard: DashboardExportData): string {
  const rows: unknown[][] = [
    ["管理摘要"],
    ["统计开始", dashboard.period.from?.toISOString() ?? "全部历史"],
    ["统计结束", dashboard.period.to?.toISOString() ?? "全部历史"],
    [],
    ["当前周期指标", "数值", "较上周期变化"],
    [
      "活动数",
      dashboard.summary.campaignCount,
      dashboard.previousSummary
        ? dashboard.summary.campaignCount - dashboard.previousSummary.campaignCount
        : "无上周期",
    ],
    ["员工任务数", dashboard.summary.taskCount, dashboard.summaryChanges?.taskCount ?? "无上周期"],
    [
      "有效提交数",
      dashboard.summary.verifiedCount,
      dashboard.summaryChanges?.verifiedCount ?? "无上周期",
    ],
    [
      "逾期纠错数",
      dashboard.summary.lateCorrectedCount,
      dashboard.summaryChanges?.lateCorrectedCount ?? "无上周期",
    ],
    [
      "完成率",
      `${(dashboard.summary.completionRate * 100).toFixed(1)}%`,
      dashboard.summaryChanges
        ? `${(dashboard.summaryChanges.completionRate * 100).toFixed(1)} 个百分点`
        : "无上周期",
    ],
    [
      "阅读量",
      dashboard.summary.metricTotals.views ?? "未获取",
      dashboard.summaryChanges?.views ?? "无上周期",
    ],
    [],
    ["企业对比", "活动数", "任务数", "完成率", "阅读量"],
    ...dashboard.enterpriseComparisons.map((item) => [
      item.enterpriseName,
      item.campaignCount,
      item.taskCount,
      `${(item.completionRate * 100).toFixed(1)}%`,
      item.metricTotals.views ?? "未获取",
    ]),
    [],
    ["内容表现维度", "分类", "活动数", "任务数", "完成率", "阅读量"],
    ...dashboard.contentComparisons.map((item) => [
      item.dimension,
      item.value,
      item.campaignCount,
      item.taskCount,
      `${(item.completionRate * 100).toFixed(1)}%`,
      item.views ?? "未获取",
    ]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

function maskPhone(phone: string): string {
  return phone.replace(/^(\d{3})\d+(\d{4})$/, "$1****$2");
}

function publicCampaign<T extends { generationStyleSnapshot?: unknown }>(campaign: T) {
  const { generationStyleSnapshot: _snapshot, ...visible } = campaign;
  return visible;
}

import {
  freezeGenerationInput,
  freezeIndustryGenerationGuidance,
} from "../content/freeze-generation-input";
