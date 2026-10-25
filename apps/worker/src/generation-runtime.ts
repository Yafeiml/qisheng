import { createHash, randomUUID } from "node:crypto";
import {
  assertMedicalPublisher,
  differenceHash,
  type FrozenImageAsset,
  type GenerationStyleSnapshot,
  generationDeliveryMode,
  hashSimilarity,
  type IndustryGenerationGuidanceSnapshot,
  type InvocationAttempt,
  type MedicalPlan,
  type MedicalPublisherContext,
  ModelRoutingError,
  medicalOrdinalForMember,
  medicalPlanForOrdinal,
  medicalPublisherFor,
  medicalPublishingSafetyContext,
  type RoutedGenerationResult,
  readGenerationStyleSnapshot,
  readIndustryGenerationGuidance,
  readMedicalPlan,
} from "@xhs-agentic/ai-gateway";
import {
  ContentSafetyInvocationError,
  type ContentSafetyScanner,
  type ContentSafetyScanResult,
} from "@xhs-agentic/content-safety";
import { Prisma, type PrismaClient } from "@xhs-agentic/database";
import {
  generatedImageObjectKey,
  type ObjectStorage,
  type StoredObject,
} from "@xhs-agentic/object-storage";
import { writeStructuredLog } from "@xhs-agentic/observability";
import sharp from "sharp";
import {
  type GenerationErrorClassification,
  type GenerationExecutionLease,
  GenerationLeaseLostError,
  isPrismaSerializationConflict,
  PermanentGenerationError,
} from "./generation-execution";
import {
  medicalQuestionCardPageCount,
  renderMedicalOriginal,
  renderMedicalQuestionCard,
} from "./medical-images";
import { composePoster, loadPosterAssets } from "./poster-assets";
import {
  ProviderCircuitBreaker,
  type ProviderCircuitBreakerOptions,
} from "./provider-circuit-breaker";
import { ProviderInvocationLimiter } from "./provider-invocation-limiter";
import { recordRouteRuntimeOutcome } from "./route-runtime-health";
import { createRoutedAdapter, type FrozenModel, type FrozenRoute } from "./routed-generation";
import { WorkerStorageQuota } from "./storage-quota";

const IMAGE_WIDTH = 1080;
const IMAGE_HEIGHT = 1440;
const PHASH_REJECTION_SIMILARITY = 0.995;

export interface GenerationRuntimeOptions {
  circuitBreaker?: ProviderCircuitBreakerOptions;
  contentSafetyScanner?: ContentSafetyScanner;
  leaseDurationMs?: number;
  requireContentSafety?: boolean;
}

export class GenerationRuntime {
  private readonly circuitBreaker: ProviderCircuitBreaker;
  private readonly invocationLimiter: ProviderInvocationLimiter;
  private readonly leaseDurationMs: number;
  private readonly contentSafetyScanner?: ContentSafetyScanner;
  private readonly requireContentSafety: boolean;
  private readonly storageQuota: WorkerStorageQuota;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: ObjectStorage,
    options: GenerationRuntimeOptions = {},
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? 120_000;
    this.contentSafetyScanner = options.contentSafetyScanner;
    this.requireContentSafety = options.requireContentSafety ?? false;
    this.circuitBreaker = new ProviderCircuitBreaker(
      prisma,
      options.circuitBreaker ?? {
        cooldownMs: 60_000,
        failureThreshold: 5,
        probeLeaseMs: 120_000,
      },
    );
    this.invocationLimiter = new ProviderInvocationLimiter(prisma);
    this.storageQuota = new WorkerStorageQuota(prisma, storage);
  }

  async claimRun(
    generationRunId: string,
    tenantId: string,
    queueVersion: number,
    leaseOwner: string,
  ): Promise<GenerationExecutionLease | null> {
    const current = await this.prisma.generationRun.findFirst({
      select: {
        attemptCount: true,
        executionVersion: true,
        maxAttempts: true,
        nextRetryAt: true,
        queueVersion: true,
        status: true,
        tenantId: true,
      },
      where: { id: generationRunId },
    });
    if (!current) return null;
    if (current.tenantId !== tenantId) {
      throw new PermanentGenerationError("Generation run was not found in its tenant");
    }
    const now = new Date();
    if (
      current.status !== "QUEUED" ||
      current.queueVersion !== queueVersion ||
      current.attemptCount >= current.maxAttempts ||
      (current.nextRetryAt !== null && current.nextRetryAt > now)
    ) {
      return null;
    }
    const leaseToken = randomUUID();
    const claimed = await this.prisma.generationRun.updateMany({
      data: {
        attemptCount: { increment: 1 },
        errorCode: null,
        errorMessage: null,
        errorRetryable: null,
        executionVersion: { increment: 1 },
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs),
        leaseOwner,
        leaseToken,
        nextRetryAt: null,
        startedAt: now,
        status: "RUNNING",
      },
      where: {
        attemptCount: current.attemptCount,
        executionVersion: current.executionVersion,
        id: generationRunId,
        queueVersion,
        status: "QUEUED",
        tenantId,
      },
    });
    if (claimed.count !== 1) return null;
    const lease: GenerationExecutionLease = {
      attemptCount: current.attemptCount + 1,
      executionVersion: current.executionVersion + 1,
      id: generationRunId,
      kind: "RUN",
      leaseOwner,
      leaseToken,
      maxAttempts: current.maxAttempts,
      queueVersion,
      tenantId,
    };
    if (lease.attemptCount > 1) {
      await this.auditExecution("generation.run.retry-started", lease, {
        attemptCount: lease.attemptCount,
      });
    }
    return lease;
  }

  async claimWorkItem(
    workItemId: string,
    tenantId: string,
    queueVersion: number,
    leaseOwner: string,
  ): Promise<GenerationExecutionLease | null> {
    const current = await this.prisma.generationWorkItem.findFirst({
      select: {
        attemptCount: true,
        executionVersion: true,
        maxAttempts: true,
        nextRetryAt: true,
        queueVersion: true,
        status: true,
        tenantId: true,
      },
      where: { id: workItemId },
    });
    if (!current) return null;
    if (current.tenantId !== tenantId) {
      throw new PermanentGenerationError("Generation work item was not found in its tenant");
    }
    const now = new Date();
    if (
      current.status !== "QUEUED" ||
      current.queueVersion !== queueVersion ||
      current.attemptCount >= current.maxAttempts ||
      (current.nextRetryAt !== null && current.nextRetryAt > now)
    ) {
      return null;
    }
    const leaseToken = randomUUID();
    const claimed = await this.prisma.generationWorkItem.updateMany({
      data: {
        attemptCount: { increment: 1 },
        errorCode: null,
        errorMessage: null,
        errorRetryable: null,
        executionVersion: { increment: 1 },
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs),
        leaseOwner,
        leaseToken,
        nextRetryAt: null,
        startedAt: now,
        status: "RUNNING",
      },
      where: {
        attemptCount: current.attemptCount,
        executionVersion: current.executionVersion,
        id: workItemId,
        queueVersion,
        status: "QUEUED",
        tenantId,
      },
    });
    if (claimed.count !== 1) return null;
    const lease: GenerationExecutionLease = {
      attemptCount: current.attemptCount + 1,
      executionVersion: current.executionVersion + 1,
      id: workItemId,
      kind: "WORK_ITEM",
      leaseOwner,
      leaseToken,
      maxAttempts: current.maxAttempts,
      queueVersion,
      tenantId,
    };
    if (lease.attemptCount > 1) {
      await this.auditExecution("generation.work-item.retry-started", lease, {
        attemptCount: lease.attemptCount,
      });
    }
    return lease;
  }

  async renewLease(lease: GenerationExecutionLease): Promise<boolean> {
    const now = new Date();
    const data = {
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs),
    };
    const where = {
      executionVersion: lease.executionVersion,
      id: lease.id,
      leaseToken: lease.leaseToken,
      leaseExpiresAt: { gt: now },
      status: "RUNNING" as const,
      tenantId: lease.tenantId,
    };
    const renewed =
      lease.kind === "RUN"
        ? await this.prisma.generationRun.updateMany({ data, where })
        : await this.prisma.generationWorkItem.updateMany({ data, where });
    return renewed.count === 1;
  }

  async prepareRun(
    lease: GenerationExecutionLease,
    requireMedicalPlan = false,
  ): Promise<Array<{ id: string; queueVersion: number; reservationVersion: number }>> {
    if (lease.kind !== "RUN") throw new GenerationLeaseLostError(lease);
    const run = await this.prisma.generationRun.findFirst({
      include: { campaign: true, workItems: { orderBy: { createdAt: "asc" } } },
      where: {
        executionVersion: lease.executionVersion,
        id: lease.id,
        leaseToken: lease.leaseToken,
        status: "RUNNING",
        tenantId: lease.tenantId,
      },
    });
    if (!run) throw new GenerationLeaseLostError(lease);
    assertDeliveryBoundary(run.synthetic);
    const input = parseGenerationInput(run.generationInput);
    if (requireMedicalPlan && !input.medicalPlan)
      throw new PermanentGenerationError(
        "Medical capability queue requires a frozen medical plan",
        "MEDICAL_PLAN_REQUIRED",
      );
    if (input.medicalPlan) {
      try {
        for (const publisher of input.medicalPlan.publishers)
          assertMedicalPublisher(input.medicalPlan, publisher.publisherContext);
      } catch (error) {
        throw new PermanentGenerationError(
          error instanceof Error ? error.message : "Medical publishing conditions unavailable",
          "MEDICAL_PUBLISHER_INVALID",
        );
      }
      if (input.medicalPlan.imageMode === "ORIGINAL_EDIT") {
        const originals = await loadPosterAssets(
          this.prisma,
          this.storage,
          lease.tenantId,
          input.imageAssets,
          true,
        );
        await renderMedicalOriginal(
          originals.filter((asset) => asset.usage === "REFERENCE"),
          1,
          108,
          144,
        );
      }
    }

    const existingBlueprint = await this.prisma.campaignBlueprint.findUnique({
      where: { campaignId: run.campaignId },
    });
    if (!existingBlueprint) {
      const route = parseFrozenRoute(run.routingPolicy);
      if (run.synthetic) {
        const blueprint = syntheticBlueprint(run.campaign.prompt, input);
        await this.serializableTransaction(async (transaction) => {
          await this.assertRunLease(transaction, lease);
          await transaction.campaignBlueprint.create({
            data: {
              campaignId: run.campaignId,
              generationPolicy: {
                adapter: input.medicalPlan ? "medical-plan-v1" : "queued-synthetic-v2",
                imageUniqueness:
                  input.medicalPlan && input.medicalPlan.imageMode !== "ILLUSTRATION"
                    ? "authorized-source-reuse"
                    : "per-work-item-and-sequence",
                ...(input.medicalPlan ? { imageProductionMode: input.medicalPlan.imageMode } : {}),
                route,
                synthetic: true,
                textStyle: "xiaohongshu",
              } as Prisma.InputJsonValue,
              imageDirection: blueprint.imageDirection,
              masterCopy: blueprint.masterCopy,
              sourceContext: input.sourceContext as Prisma.InputJsonValue,
              synthetic: true,
              tenantId: lease.tenantId,
            },
          });
          await transaction.modelInvocation.upsert({
            create: {
              campaignId: run.campaignId,
              enterpriseId: run.campaign.enterpriseId,
              estimatedCost: 0,
              finishedAt: new Date(),
              idempotencyKey: `run:${run.id}:blueprint:execution:${lease.executionVersion}:synthetic`,
              kind: "CAMPAIGN_BLUEPRINT",
              latencyMs: 0,
              model: route.text.primary.externalModelId,
              provider: route.text.primary.providerCode,
              providerRequestId: `synthetic-blueprint-${run.id}`,
              status: "SUCCEEDED",
              tenantId: lease.tenantId,
              generationRunId: run.id,
            },
            update: {},
            where: {
              tenantId_idempotencyKey: {
                idempotencyKey: `run:${run.id}:blueprint:execution:${lease.executionVersion}:synthetic`,
                tenantId: lease.tenantId,
              },
            },
          });
        });
      } else {
        const runtime = await this.createRoutedAdapter(
          run.id,
          route,
          !input.medicalPlan || input.medicalPlan.imageMode === "ILLUSTRATION",
        );
        try {
          const generated = await runtime.adapter.generateBlueprint(
            {
              campaignId: run.campaignId,
              enterpriseId: run.campaign.enterpriseId,
              generationRunId: run.id,
              tenantId: lease.tenantId,
            },
            {
              medicalPlan: input.medicalPlan,
              geoSummary: input.geoSummary,
              materialSummary: input.materialSummary,
              industryGuidance: input.industryGuidance,
              prompt: run.campaign.prompt,
              generationStyle: input.generationStyle,
              sensitiveRuleSummary: input.sensitiveRuleSummary,
              sourceContext: input.sourceContext,
              title: run.campaign.title,
            },
          );
          await this.recordAttempts({
            attempts: generated.routing.attempts,
            campaignId: run.campaignId,
            enterpriseId: run.campaign.enterpriseId,
            generationRunId: run.id,
            idempotencyPrefix: `run:${run.id}:blueprint:execution:${lease.executionVersion}`,
            kind: "CAMPAIGN_BLUEPRINT",
            providerCodes: runtime.providerCodes,
            tenantId: lease.tenantId,
          });
          await this.serializableTransaction(async (transaction) => {
            await this.assertRunLease(transaction, lease);
            await transaction.campaignBlueprint.create({
              data: {
                campaignId: run.campaignId,
                generationPolicy: {
                  adapter: input.medicalPlan ? "medical-plan-v1" : "routed-generation-v1",
                  ...(input.medicalPlan
                    ? { imageProductionMode: input.medicalPlan.imageMode }
                    : {}),
                  route,
                  synthetic: false,
                } as Prisma.InputJsonValue,
                imageDirection: generated.result.imageDirection,
                masterCopy: generated.result.masterCopy,
                sourceContext: {
                  ...generated.result.sourceContext,
                  ...input.sourceContext,
                } as Prisma.InputJsonValue,
                synthetic: false,
                tenantId: lease.tenantId,
              },
            });
            await recordRouteRuntimeOutcome(transaction, {
              campaignId: run.campaignId,
              generationRunId: run.id,
              executionVersion: lease.executionVersion,
              tenantId: lease.tenantId,
              capabilities: ["TEXT"],
            });
          });
        } catch (error) {
          if (error instanceof ModelRoutingError) {
            await this.recordAttempts({
              attempts: error.attempts,
              campaignId: run.campaignId,
              enterpriseId: run.campaign.enterpriseId,
              generationRunId: run.id,
              idempotencyPrefix: `run:${run.id}:blueprint:execution:${lease.executionVersion}`,
              kind: "CAMPAIGN_BLUEPRINT",
              providerCodes: runtime.providerCodes,
              tenantId: lease.tenantId,
            });
          }
          throw error;
        }
      }
    }

    await this.releaseRunLease(lease);
    return this.prisma.generationWorkItem.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, queueVersion: true, reservationVersion: true },
      where: { generationRunId: run.id, status: "QUEUED", tenantId: lease.tenantId },
    });
  }

  async generateWorkItem(
    lease: GenerationExecutionLease,
    requireMedicalPlan = false,
  ): Promise<void> {
    if (lease.kind !== "WORK_ITEM") throw new GenerationLeaseLostError(lease);
    const tenantId = lease.tenantId;
    const item = await this.prisma.generationWorkItem.findFirst({
      include: {
        audienceSnapshot: true,
        campaign: { include: { blueprint: true } },
        generationRun: true,
      },
      where: {
        executionVersion: lease.executionVersion,
        id: lease.id,
        leaseToken: lease.leaseToken,
        status: "RUNNING",
        tenantId,
      },
    });
    if (!item) throw new GenerationLeaseLostError(lease);
    assertDeliveryBoundary(item.generationRun.synthetic);
    if (!item.campaign.blueprint) {
      throw new PermanentGenerationError("Campaign blueprint is not ready", "BLUEPRINT_NOT_READY");
    }
    const route = parseFrozenRoute(item.generationRun.routingPolicy);
    const input = parseGenerationInput(item.generationRun.generationInput);
    if (requireMedicalPlan && !input.medicalPlan)
      throw new PermanentGenerationError(
        "Medical capability queue requires a frozen medical plan",
        "MEDICAL_PLAN_REQUIRED",
      );
    let medicalPublisher: MedicalPublisherContext | undefined;
    try {
      medicalPublisher = input.medicalPlan
        ? medicalPublisherFor(input.medicalPlan, item.membershipId)
        : undefined;
    } catch (error) {
      throw new PermanentGenerationError(
        error instanceof Error ? error.message : "Medical publisher unavailable",
        "MEDICAL_PUBLISHER_INVALID",
      );
    }
    const confirmedOriginals =
      input.medicalPlan?.imageMode === "ORIGINAL_EDIT"
        ? await loadPosterAssets(this.prisma, this.storage, tenantId, input.imageAssets, true)
        : undefined;
    if (confirmedOriginals)
      await renderMedicalOriginal(
        confirmedOriginals.filter((asset) => asset.usage === "REFERENCE"),
        1,
        108,
        144,
      );
    const context = {
      campaignId: item.campaignId,
      enterpriseId: item.enterpriseId,
      generationRunId: item.generationRunId,
      tenantId,
    };
    const ordinal = input.medicalPlan
      ? medicalOrdinalForMember(input.medicalPlan, item.membershipId)
      : await this.workItemOrdinal(item.generationRunId, item.id);
    const imagePlan = input.medicalPlan
      ? medicalPlanForOrdinal(input.medicalPlan, ordinal)
      : undefined;
    const uniquenessSeed = `${item.campaignId}:${item.membershipId}:${item.reservationVersion}`;
    const existingContent = await this.prisma.employeeContent.findUnique({
      include: { images: { orderBy: { sequence: "asc" } } },
      where: { audienceSnapshotId: item.audienceSnapshotId },
    });
    const rawInput = record(item.generationRun.generationInput, "generation input");
    const targets =
      rawInput.regenerationTargets === undefined
        ? {}
        : record(rawInput.regenerationTargets, "regeneration targets");
    const target = targets[item.id] ?? "BOTH";
    if (target !== "COPY" && target !== "IMAGE" && target !== "BOTH") {
      throw new PermanentGenerationError("Invalid content regeneration target");
    }
    if (target !== "BOTH" && !existingContent) {
      throw new PermanentGenerationError("Partial regeneration requires existing employee content");
    }

    let variant: EmployeeVariant;
    let runtime: Awaited<ReturnType<GenerationRuntime["createRoutedAdapter"]>> | undefined;
    if (
      !item.generationRun.synthetic &&
      (target !== "IMAGE" || !input.medicalPlan || input.medicalPlan.imageMode === "ILLUSTRATION")
    )
      runtime = await this.createRoutedAdapter(
        item.generationRunId,
        route,
        !input.medicalPlan || input.medicalPlan.imageMode === "ILLUSTRATION",
      );
    if (target === "IMAGE" && existingContent) {
      variant = {
        body: existingContent.body,
        hashtags: existingContent.hashtags,
        imagePrompt: existingContent.imagePrompt,
        title: existingContent.title,
      };
    } else if (item.generationRun.synthetic) {
      variant = input.medicalPlan
        ? syntheticMedicalVariant(input, ordinal)
        : syntheticEmployeeVariant(
            item.campaign.blueprint.masterCopy,
            item.campaign.blueprint.imageDirection,
            item.campaign.title,
            ordinal,
            item.reviewFeedback,
          );
      await this.recordSyntheticInvocation({
        campaignId: item.campaignId,
        enterpriseId: item.enterpriseId,
        generationRunId: item.generationRunId,
        idempotencyKey: `work:${item.id}:v${item.reservationVersion}:job:${item.attemptCount}:copy:synthetic`,
        kind: "EMPLOYEE_COPY",
        model: route.text.primary.externalModelId,
        provider: route.text.primary.providerCode,
        tenantId,
        workItemId: item.id,
      });
    } else {
      if (!runtime) throw new Error("Routed generation runtime is unavailable");
      try {
        const generated = await runtime.adapter.generateEmployeeVariant(
          context,
          {
            medicalPlan: input.medicalPlan,
            generationStyle: input.generationStyle,
            imageDirection: item.campaign.blueprint.imageDirection,
            masterCopy: item.campaign.blueprint.masterCopy,
            sourceContext: input.sourceContext,
            materialSummary: input.materialSummary,
            industryGuidance: input.industryGuidance,
          },
          {
            medicalPublisher,
            employeeOrdinal: ordinal,
            reviewFeedback: item.reviewFeedback,
            title: item.campaign.title,
            uniquenessSeed,
          },
        );
        variant = {
          body: generated.result.body,
          hashtags: [...generated.result.hashtags],
          imagePrompt: generated.result.imagePrompt,
          title: generated.result.title,
        };
        await this.recordAttempts({
          attempts: generated.routing.attempts,
          campaignId: item.campaignId,
          enterpriseId: item.enterpriseId,
          generationRunId: item.generationRunId,
          idempotencyPrefix: `work:${item.id}:v${item.reservationVersion}:job:${item.attemptCount}:copy`,
          kind: "EMPLOYEE_COPY",
          providerCodes: runtime.providerCodes,
          tenantId,
          workItemId: item.id,
        });
      } catch (error) {
        if (error instanceof ModelRoutingError) {
          await this.recordAttempts({
            attempts: error.attempts,
            campaignId: item.campaignId,
            enterpriseId: item.enterpriseId,
            generationRunId: item.generationRunId,
            idempotencyPrefix: `work:${item.id}:v${item.reservationVersion}:job:${item.attemptCount}:copy`,
            kind: "EMPLOYEE_COPY",
            providerCodes: runtime.providerCodes,
            tenantId,
            workItemId: item.id,
          });
        }
        throw error;
      }
    }

    const sanitized = sanitizeVariant(variant, input.sensitiveRules);
    if (target === "IMAGE") {
      if (sanitized.variant.title !== variant.title || sanitized.variant.body !== variant.body) {
        sanitized.riskAssessment.unresolvedBlocks.push(
          "保留的文案仍含需修改表述，请重生成文案后审核",
        );
        sanitized.riskAssessment.passed = false;
      }
      sanitized.variant = variant;
    } else if (target === "COPY" && existingContent) {
      sanitized.variant.imagePrompt = existingContent.imagePrompt;
    }
    const posterAssets =
      target === "COPY"
        ? []
        : (confirmedOriginals ??
          (await loadPosterAssets(
            this.prisma,
            this.storage,
            tenantId,
            input.imageAssets,
            Boolean(input.medicalPlan),
          )));
    const references = posterAssets.filter((asset) => asset.usage === "REFERENCE");
    const logos = (input.medicalPlan ? [] : posterAssets)
      .filter((asset) => asset.usage === "LOGO")
      .map((asset) => asset.bytes);
    const employeeContentId = existingContent?.id ?? randomUUID();
    const candidates: CandidateImage[] = [];
    const images: PreparedImage[] = [];
    const medicalLocalPages =
      input.medicalPlan?.imageMode === "QUESTION_CARD"
        ? medicalQuestionCardPageCount(sanitized.variant)
        : input.medicalPlan?.imageMode === "ORIGINAL_EDIT"
          ? references.length + medicalQuestionCardPageCount(sanitized.variant)
          : item.campaign.imageCount;
    const plannedImageCount = Math.min(item.campaign.imageCount, medicalLocalPages);
    try {
      for (let sequence = 1; target !== "COPY" && sequence <= plannedImageCount; sequence += 1) {
        const imageSeed = `${uniquenessSeed}:${sequence}:work-attempt:${item.attemptCount}`;
        let rawBytes: Uint8Array;
        let provider: string;
        let model: string;
        if (input.medicalPlan && input.medicalPlan.imageMode !== "ILLUSTRATION") {
          const useOriginal =
            input.medicalPlan.imageMode === "ORIGINAL_EDIT" && sequence <= references.length;
          rawBytes = useOriginal
            ? await renderMedicalOriginal(references, sequence, IMAGE_WIDTH, IMAGE_HEIGHT)
            : await renderMedicalQuestionCard(
                imagePlan ?? input.medicalPlan,
                sanitized.variant,
                input.medicalPlan.imageMode === "ORIGINAL_EDIT"
                  ? sequence - references.length
                  : sequence,
                IMAGE_WIDTH,
                IMAGE_HEIGHT,
              );
          provider = "LOCAL";
          model = useOriginal ? "ORIGINAL_EDIT" : "QUESTION_CARD";
        } else if (item.generationRun.synthetic) {
          rawBytes = await syntheticImage(item.campaign.title, imageSeed, sequence);
          provider = route.image.primary.providerCode;
          model = route.image.primary.externalModelId;
          await this.recordSyntheticInvocation({
            campaignId: item.campaignId,
            enterpriseId: item.enterpriseId,
            generationRunId: item.generationRunId,
            idempotencyKey: `work:${item.id}:v${item.reservationVersion}:job:${item.attemptCount}:image:${sequence}:synthetic`,
            imageCount: 1,
            kind: "EMPLOYEE_IMAGE",
            model,
            provider,
            tenantId,
            workItemId: item.id,
          });
        } else {
          if (!runtime) throw new Error("Routed generation runtime is unavailable");
          let generated: RoutedGenerationResult<
            import("@xhs-agentic/ai-gateway").ImageGenerationOutput
          >;
          try {
            generated = await runtime.adapter.generateImage(context, {
              medicalPlan: imagePlan,
              medicalPublisher,
              imageSequence: sequence,
              referenceImages: references,
              reserveLogoSpace: logos.length > 0,
              campaignBrief: input.campaignBrief,
              materialSummary: input.materialSummary,
              industryGuidance: input.industryGuidance,
              finalCopy: sanitized.variant,
              generationStyle: input.generationStyle,
              height: IMAGE_HEIGHT,
              prompt: item.reviewFeedback
                ? `${sanitized.variant.imagePrompt}\n本次图片修改要求：${item.reviewFeedback}`
                : sanitized.variant.imagePrompt,
              seed: imageSeed,
              width: IMAGE_WIDTH,
            });
            await this.recordAttempts({
              attempts: generated.attempts,
              campaignId: item.campaignId,
              enterpriseId: item.enterpriseId,
              generationRunId: item.generationRunId,
              idempotencyPrefix: `work:${item.id}:v${item.reservationVersion}:job:${item.attemptCount}:image:${sequence}`,
              imageCount: 1,
              kind: "EMPLOYEE_IMAGE",
              providerCodes: runtime.providerCodes,
              tenantId,
              workItemId: item.id,
            });
          } catch (error) {
            if (error instanceof ModelRoutingError) {
              await this.recordAttempts({
                attempts: error.attempts,
                campaignId: item.campaignId,
                enterpriseId: item.enterpriseId,
                generationRunId: item.generationRunId,
                idempotencyPrefix: `work:${item.id}:v${item.reservationVersion}:job:${item.attemptCount}:image:${sequence}`,
                imageCount: 1,
                kind: "EMPLOYEE_IMAGE",
                providerCodes: runtime.providerCodes,
                tenantId,
                workItemId: item.id,
              });
            }
            throw error;
          }
          rawBytes = generated.output.bytes;
          provider = runtime.providerCodes.get(generated.providerId) ?? generated.providerId;
          model = generated.modelId;
        }
        const bytes = await composePoster(rawBytes, logos, IMAGE_WIDTH, IMAGE_HEIGHT);
        const checksum = createHash("sha256").update(bytes).digest("hex");
        const perceptualHash = await differenceHash(bytes);
        if (!input.medicalPlan || input.medicalPlan.imageMode === "ILLUSTRATION")
          await this.assertImageUnique(item.campaignId, checksum, perceptualHash);
        const key = generatedImageObjectKey({
          campaignId: item.campaignId,
          checksum,
          employeeContentId,
          mimeType: "image/png",
          sequence,
          tenantId,
        });
        candidates.push({ bytes, checksum, key, model, perceptualHash, provider, sequence });
      }

      const retainedImages =
        target === "COPY" && existingContent && this.contentSafetyScanner
          ? await Promise.all(
              existingContent.images.map(async (image) => {
                if (!image.storageKey)
                  throw new PermanentGenerationError("Retained image has no storage key");
                return {
                  bytes: await this.storage.get(image.storageKey, 20 * 1024 * 1024),
                  checksum: image.checksum,
                  mimeType: image.mimeType,
                  sequence: image.sequence,
                };
              }),
            )
          : [];
      const contentSafety = await this.scanContentSafety(
        item.id,
        item.reservationVersion,
        item.attemptCount,
        sanitized.variant,
        target === "COPY" ? retainedImages : candidates,
        input.materialSummary,
        input.medicalPlan && medicalPublisher
          ? medicalPublishingSafetyContext(input.medicalPlan, medicalPublisher)
          : undefined,
      );
      const riskAssessment = mergeContentSafetyAssessment(sanitized.riskAssessment, contentSafety);
      for (const candidate of candidates) {
        const reservation = await this.storageQuota.reserve({
          byteSize: candidate.bytes.byteLength,
          expiresAt: new Date(Date.now() + 15 * 60_000),
          reservationKey: `generation-image:${item.id}:v${item.reservationVersion}:attempt:${item.attemptCount}:sequence:${candidate.sequence}`,
          resourceId: `${employeeContentId}:${candidate.sequence}:attempt:${item.attemptCount}`,
          resourceType: "GENERATED_IMAGE",
          storageKey: candidate.key,
          tenantId,
        });
        let stored: StoredObject;
        try {
          stored = await this.storage.put({
            bytes: candidate.bytes,
            checksum: candidate.checksum,
            key: candidate.key,
            mimeType: "image/png",
          });
        } catch (error) {
          await this.storage.delete(candidate.key).catch(() => undefined);
          await this.storageQuota
            .release(
              reservation.id,
              tenantId,
              "Release generated image capacity after storage failure",
            )
            .catch(() => undefined);
          throw error;
        }
        images.push({
          checksum: candidate.checksum,
          key: candidate.key,
          model: candidate.model,
          perceptualHash: candidate.perceptualHash,
          provider: candidate.provider,
          reservationId: reservation.id,
          sequence: candidate.sequence,
          stored,
        });
      }

      await this.serializableTransaction(async (transaction) => {
        const current = await this.assertWorkItemLease(transaction, lease);
        if (current.reservationVersion !== item.reservationVersion) {
          throw new GenerationLeaseLostError(lease);
        }
        const contentFingerprint = createHash("sha256")
          .update(
            `${sanitized.variant.title}\n${sanitized.variant.body}\n${sanitized.variant.hashtags.join(" ")}`.normalize(
              "NFKC",
            ),
          )
          .digest("hex");
        const currentContent = await transaction.employeeContent.findUnique({
          include: { images: { orderBy: { sequence: "asc" } } },
          where: { audienceSnapshotId: item.audienceSnapshotId },
        });
        if (currentContent) {
          await transaction.employeeContentRevision.create({
            data: {
              campaignId: item.campaignId,
              createdBy: "SYSTEM",
              employeeContentId: currentContent.id,
              enterpriseId: item.enterpriseId,
              reviewFeedback: item.reviewFeedback,
              revision: currentContent.revision,
              snapshot: {
                body: currentContent.body,
                contentFingerprint: currentContent.contentFingerprint,
                hashtags: currentContent.hashtags,
                imagePrompt: currentContent.imagePrompt,
                images: currentContent.images.map((image) => ({
                  byteSize: image.byteSize?.toString() ?? null,
                  checksum: image.checksum,
                  height: image.height,
                  mimeType: image.mimeType,
                  perceptualHash: image.perceptualHash,
                  sequence: image.sequence,
                  storageEtag: image.storageEtag,
                  storageKey: image.storageKey,
                  width: image.width,
                })),
                riskAssessment: currentContent.riskAssessment,
                status: currentContent.status,
                synthetic: currentContent.synthetic,
                title: currentContent.title,
              } as Prisma.InputJsonValue,
              tenantId,
            },
          });
          if (target !== "COPY") {
            await transaction.generatedImage.deleteMany({
              where: { employeeContentId: currentContent.id, tenantId },
            });
          }
          await transaction.employeeContent.update({
            data: {
              body: sanitized.variant.body,
              contentFingerprint,
              hashtags: sanitized.variant.hashtags,
              imagePrompt: sanitized.variant.imagePrompt,
              revision: { increment: 1 },
              riskAssessment: riskAssessment as Prisma.InputJsonValue,
              status: riskAssessment.passed ? "GENERATED" : "REVIEW_BLOCKED",
              synthetic: item.generationRun.synthetic,
              title: sanitized.variant.title,
            },
            where: { id: currentContent.id },
          });
        } else {
          await transaction.employeeContent.create({
            data: {
              audienceSnapshotId: item.audienceSnapshotId,
              body: sanitized.variant.body,
              campaignId: item.campaignId,
              contentFingerprint,
              enterpriseId: item.enterpriseId,
              hashtags: sanitized.variant.hashtags,
              id: employeeContentId,
              imagePrompt: sanitized.variant.imagePrompt,
              membershipId: item.membershipId,
              riskAssessment: riskAssessment as Prisma.InputJsonValue,
              status: riskAssessment.passed ? "GENERATED" : "REVIEW_BLOCKED",
              synthetic: item.generationRun.synthetic,
              tenantId,
              title: sanitized.variant.title,
            },
          });
        }
        await transaction.generatedImage.createMany({
          data: images.map((image) => ({
            byteSize: BigInt(image.stored.byteSize),
            campaignId: item.campaignId,
            checksum: image.checksum,
            employeeContentId,
            height: IMAGE_HEIGHT,
            id: randomUUID(),
            imageUrl: `private-object://${image.key}`,
            mimeType: "image/png",
            model: image.model,
            perceptualHash: image.perceptualHash,
            prompt: sanitized.variant.imagePrompt,
            provider: image.provider,
            sequence: image.sequence,
            storageEtag: image.stored.etag,
            storageKey: image.key,
            synthetic: item.generationRun.synthetic,
            tenantId,
            width: IMAGE_WIDTH,
          })),
        });
        for (const image of images) {
          await this.storageQuota.commitInTransaction(
            transaction,
            image.reservationId,
            tenantId,
            "Commit generated image after employee content transaction succeeded",
          );
        }
        let distributionTask = await transaction.distributionTask.findUnique({
          where: { employeeContentId },
        });
        if (!distributionTask) {
          distributionTask = await transaction.distributionTask.create({
            data: {
              campaignId: item.campaignId,
              employeeContentId,
              enterpriseId: item.enterpriseId,
              expiresAt: item.campaign.expiresAt,
              membershipId: item.membershipId,
              status: "LOCKED",
              tenantId,
              visibleAt: item.campaign.visibleAt,
            },
          });
        }
        const completed = await transaction.generationWorkItem.updateMany({
          data: {
            errorCode: null,
            errorMessage: null,
            errorRetryable: null,
            finishedAt: new Date(),
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            nextRetryAt: null,
            status: "SUCCEEDED",
          },
          where: this.workItemLeaseWhere(lease),
        });
        if (completed.count !== 1) throw new GenerationLeaseLostError(lease);
        if (
          !item.generationRun.synthetic &&
          (target !== "IMAGE" ||
            !input.medicalPlan ||
            input.medicalPlan.imageMode === "ILLUSTRATION")
        )
          await recordRouteRuntimeOutcome(transaction, {
            campaignId: item.campaignId,
            generationRunId: item.generationRunId,
            workItemId: item.id,
            executionVersion: lease.executionVersion,
            tenantId,
            capabilities:
              input.medicalPlan && input.medicalPlan.imageMode !== "ILLUSTRATION"
                ? ["TEXT"]
                : target === "COPY"
                  ? ["TEXT"]
                  : target === "IMAGE"
                    ? ["IMAGE"]
                    : ["TEXT", "IMAGE"],
          });
        await finalizeGenerationRun(transaction, item.generationRunId, item.campaignId);
      });
    } catch (error) {
      await Promise.allSettled(images.map((image) => this.storage.delete(image.key)));
      await Promise.allSettled(
        images.map((image) =>
          this.storageQuota.release(
            image.reservationId,
            tenantId,
            "Release generated image capacity after content transaction failed",
          ),
        ),
      );
      throw error;
    }
  }

  async failExhaustedWorkItem(workItemId: string, tenantId: string): Promise<boolean> {
    return this.serializableTransaction(async (transaction) => {
      const now = new Date();
      const item = await transaction.generationWorkItem.findFirst({
        where: { id: workItemId, tenantId },
      });
      if (
        !item ||
        item.attemptCount < item.maxAttempts ||
        (item.status !== "QUEUED" &&
          (item.status !== "RUNNING" ||
            (item.leaseExpiresAt !== null && item.leaseExpiresAt > now)))
      ) {
        return false;
      }
      const failed = await transaction.generationWorkItem.updateMany({
        data: {
          errorCode: "MAX_ATTEMPTS_EXHAUSTED",
          errorMessage: "Generation work item exhausted its durable execution attempts",
          errorRetryable: false,
          finishedAt: now,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          nextRetryAt: null,
          status: "FAILED",
        },
        where: {
          executionVersion: item.executionVersion,
          id: item.id,
          ...(item.status === "RUNNING"
            ? { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] }
            : {}),
          status: item.status,
          tenantId,
        },
      });
      if (failed.count !== 1) return false;
      await finalizeGenerationRun(transaction, item.generationRunId, item.campaignId);
      await transaction.auditLog.create({
        data: {
          action: "generation.work-item.attempts-exhausted",
          actorType: "SYSTEM",
          enterpriseId: item.enterpriseId,
          metadata: { attemptCount: item.attemptCount, maxAttempts: item.maxAttempts },
          resourceId: item.id,
          resourceType: "GenerationWorkItem",
          tenantId,
        },
      });
      return true;
    });
  }

  async failExhaustedRun(generationRunId: string, tenantId: string): Promise<boolean> {
    return this.serializableTransaction(async (transaction) => {
      const now = new Date();
      const run = await transaction.generationRun.findFirst({
        include: { campaign: { include: { blueprint: true } } },
        where: { id: generationRunId, tenantId },
      });
      if (
        !run ||
        run.campaign.blueprint ||
        run.attemptCount < run.maxAttempts ||
        (run.status !== "QUEUED" &&
          (run.status !== "RUNNING" || (run.leaseExpiresAt !== null && run.leaseExpiresAt > now)))
      ) {
        return false;
      }
      const unfinished = await transaction.generationWorkItem.findMany({
        select: { id: true },
        where: {
          generationRunId: run.id,
          status: { in: ["QUEUED", "RUNNING"] },
          tenantId,
        },
      });
      const failed = await transaction.generationRun.updateMany({
        data: {
          errorCode: "MAX_ATTEMPTS_EXHAUSTED",
          errorMessage: "Generation run exhausted its durable execution attempts",
          errorRetryable: false,
          failedCount: unfinished.length,
          finishedAt: now,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          nextRetryAt: null,
          status: "FAILED",
        },
        where: {
          executionVersion: run.executionVersion,
          id: run.id,
          ...(run.status === "RUNNING"
            ? { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] }
            : {}),
          status: run.status,
          tenantId,
        },
      });
      if (failed.count !== 1) return false;
      if (unfinished.length > 0) {
        await transaction.generationWorkItem.updateMany({
          data: {
            errorCode: "MAX_ATTEMPTS_EXHAUSTED",
            errorMessage: "Parent generation run exhausted its durable execution attempts",
            errorRetryable: false,
            finishedAt: now,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            nextRetryAt: null,
            status: "FAILED",
          },
          where: { id: { in: unfinished.map(({ id }) => id) }, tenantId },
        });
      }
      await transaction.campaign.update({
        data: { status: "GENERATION_FAILED" },
        where: { id: run.campaignId },
      });
      await transaction.auditLog.create({
        data: {
          action: "generation.run.attempts-exhausted",
          actorType: "SYSTEM",
          enterpriseId: run.campaign.enterpriseId,
          metadata: { attemptCount: run.attemptCount, maxAttempts: run.maxAttempts },
          resourceId: run.id,
          resourceType: "GenerationRun",
          tenantId,
        },
      });
      return true;
    });
  }

  async resetWorkItemForQueueRetry(
    lease: GenerationExecutionLease,
    failure: GenerationErrorClassification,
    nextRetryAt: Date,
  ): Promise<void> {
    const reset = await this.prisma.generationWorkItem.updateMany({
      data: {
        errorCode: failure.code,
        errorMessage: failure.message,
        errorRetryable: true,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseToken: null,
        nextRetryAt,
        status: "QUEUED",
      },
      where: this.workItemLeaseWhere(lease),
    });
    if (reset.count !== 1) throw new GenerationLeaseLostError(lease);
    await this.auditExecution("generation.work-item.retry-scheduled", lease, {
      errorCode: failure.code,
      nextRetryAt: nextRetryAt.toISOString(),
    });
  }

  async failWorkItem(
    lease: GenerationExecutionLease,
    failure: GenerationErrorClassification,
  ): Promise<void> {
    const tenantId = lease.tenantId;
    await this.serializableTransaction(async (transaction) => {
      const item = await transaction.generationWorkItem.findFirst({
        where: {
          executionVersion: lease.executionVersion,
          id: lease.id,
          leaseToken: lease.leaseToken,
          status: "RUNNING",
          tenantId,
        },
      });
      if (!item) throw new GenerationLeaseLostError(lease);
      const failed = await transaction.generationWorkItem.updateMany({
        data: {
          errorCode: failure.code,
          errorMessage: failure.message,
          errorRetryable: failure.retryable,
          finishedAt: new Date(),
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          nextRetryAt: null,
          status: "FAILED",
        },
        where: this.workItemLeaseWhere(lease),
      });
      if (failed.count !== 1) throw new GenerationLeaseLostError(lease);
      await recordRouteRuntimeOutcome(transaction, {
        campaignId: item.campaignId,
        generationRunId: item.generationRunId,
        workItemId: item.id,
        executionVersion: lease.executionVersion,
        tenantId,
        attemptCount: lease.attemptCount,
        failure,
      });
      await finalizeGenerationRun(transaction, item.generationRunId, item.campaignId);
      await transaction.auditLog.create({
        data: {
          action: "generation.work-item.failed",
          actorType: "SYSTEM",
          enterpriseId: item.enterpriseId,
          metadata: {
            attemptCount: lease.attemptCount,
            errorCode: failure.code,
            retryable: failure.retryable,
          },
          resourceId: item.id,
          resourceType: "GenerationWorkItem",
          tenantId,
        },
      });
    });
  }

  async resetRunForQueueRetry(
    lease: GenerationExecutionLease,
    failure: GenerationErrorClassification,
    nextRetryAt: Date,
  ): Promise<void> {
    const reset = await this.prisma.generationRun.updateMany({
      data: {
        errorCode: failure.code,
        errorMessage: failure.message,
        errorRetryable: true,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseToken: null,
        nextRetryAt,
        status: "QUEUED",
      },
      where: this.runLeaseWhere(lease),
    });
    if (reset.count !== 1) throw new GenerationLeaseLostError(lease);
    await this.auditExecution("generation.run.retry-scheduled", lease, {
      errorCode: failure.code,
      nextRetryAt: nextRetryAt.toISOString(),
    });
  }

  async failRun(
    lease: GenerationExecutionLease,
    failure: GenerationErrorClassification,
  ): Promise<void> {
    const tenantId = lease.tenantId;
    await this.serializableTransaction(async (transaction) => {
      const run = await transaction.generationRun.findFirst({
        include: { campaign: { select: { enterpriseId: true, id: true } } },
        where: {
          executionVersion: lease.executionVersion,
          id: lease.id,
          leaseToken: lease.leaseToken,
          status: "RUNNING",
          tenantId,
        },
      });
      if (!run) throw new GenerationLeaseLostError(lease);
      const unfinished = await transaction.generationWorkItem.findMany({
        select: { id: true },
        where: {
          generationRunId: lease.id,
          status: { in: ["QUEUED", "RUNNING"] },
          tenantId,
        },
      });
      if (unfinished.length > 0) {
        await transaction.generationWorkItem.updateMany({
          data: {
            errorCode: failure.code,
            errorMessage: failure.message,
            errorRetryable: failure.retryable,
            finishedAt: new Date(),
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            nextRetryAt: null,
            status: "FAILED",
          },
          where: { id: { in: unfinished.map((item) => item.id) }, tenantId },
        });
      }
      const failed = await transaction.generationRun.updateMany({
        data: {
          completedCount: 0,
          errorCode: failure.code,
          errorMessage: failure.message,
          errorRetryable: failure.retryable,
          failedCount: unfinished.length,
          finishedAt: new Date(),
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          nextRetryAt: null,
          status: "FAILED",
        },
        where: this.runLeaseWhere(lease),
      });
      if (failed.count !== 1) throw new GenerationLeaseLostError(lease);
      await transaction.campaign.update({
        data: { status: "GENERATION_FAILED" },
        where: { id: run.campaignId },
      });
      await recordRouteRuntimeOutcome(transaction, {
        campaignId: run.campaignId,
        generationRunId: run.id,
        executionVersion: lease.executionVersion,
        tenantId,
        attemptCount: lease.attemptCount,
        failure,
      });
      await transaction.auditLog.create({
        data: {
          action: "generation.run.failed",
          actorType: "SYSTEM",
          enterpriseId: run.campaign.enterpriseId,
          metadata: {
            attemptCount: lease.attemptCount,
            errorCode: failure.code,
            retryable: failure.retryable,
          },
          resourceId: run.id,
          resourceType: "GenerationRun",
          tenantId,
        },
      });
    });
  }

  private async releaseRunLease(lease: GenerationExecutionLease): Promise<void> {
    const released = await this.prisma.generationRun.updateMany({
      data: {
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseToken: null,
        nextRetryAt: null,
      },
      where: this.runLeaseWhere(lease),
    });
    if (released.count !== 1) throw new GenerationLeaseLostError(lease);
  }

  private async assertRunLease(
    transaction: Prisma.TransactionClient,
    lease: GenerationExecutionLease,
  ): Promise<void> {
    const run = await transaction.generationRun.findFirst({
      select: { id: true },
      where: this.runLeaseWhere(lease),
    });
    if (!run) throw new GenerationLeaseLostError(lease);
  }

  private async assertWorkItemLease(
    transaction: Prisma.TransactionClient,
    lease: GenerationExecutionLease,
  ): Promise<{ reservationVersion: number }> {
    const item = await transaction.generationWorkItem.findFirst({
      select: { reservationVersion: true },
      where: this.workItemLeaseWhere(lease),
    });
    if (!item) throw new GenerationLeaseLostError(lease);
    return item;
  }

  private runLeaseWhere(lease: GenerationExecutionLease) {
    return {
      executionVersion: lease.executionVersion,
      id: lease.id,
      leaseExpiresAt: { gt: new Date() },
      leaseToken: lease.leaseToken,
      status: "RUNNING" as const,
      tenantId: lease.tenantId,
    };
  }

  private workItemLeaseWhere(lease: GenerationExecutionLease) {
    return {
      executionVersion: lease.executionVersion,
      id: lease.id,
      leaseExpiresAt: { gt: new Date() },
      leaseToken: lease.leaseToken,
      status: "RUNNING" as const,
      tenantId: lease.tenantId,
    };
  }

  private auditExecution(
    action: string,
    lease: GenerationExecutionLease,
    metadata: Record<string, unknown>,
  ) {
    return this.prisma.auditLog.create({
      data: {
        action,
        actorType: "SYSTEM",
        metadata: {
          ...metadata,
          executionVersion: lease.executionVersion,
          leaseOwner: lease.leaseOwner,
          queueVersion: lease.queueVersion,
        },
        resourceId: lease.id,
        resourceType: lease.kind === "RUN" ? "GenerationRun" : "GenerationWorkItem",
        tenantId: lease.tenantId,
      },
    });
  }

  private async serializableTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 60_000,
        });
      } catch (error) {
        if (attempt < 5 && isPrismaSerializationConflict(error)) {
          await new Promise<void>((resolve) => setTimeout(resolve, attempt * 25));
          continue;
        }
        throw error;
      }
    }
    throw new Error("Generation transaction retry limit was reached");
  }

  private createRoutedAdapter(generationRunId: string, route: FrozenRoute, imageRequired = true) {
    return createRoutedAdapter(
      this.prisma,
      generationRunId,
      route,
      undefined,
      this.circuitBreaker,
      this.invocationLimiter,
      imageRequired,
    );
  }

  private async recordAttempts(input: RecordAttemptsInput): Promise<void> {
    if (input.attempts.length === 0) return;
    await this.prisma.$transaction(
      input.attempts.map((attempt, index) => {
        const key = `${input.idempotencyPrefix}:${index + 1}:${attempt.providerId}:${attempt.modelId}:${attempt.attempt}`;
        return this.prisma.modelInvocation.upsert({
          create: {
            attempt: attempt.attempt,
            campaignId: input.campaignId,
            enterpriseId: input.enterpriseId,
            errorCode: attempt.errorCode,
            estimatedCost: attempt.estimatedCost ?? 0,
            finishedAt: new Date(),
            generationRunId: input.generationRunId,
            generationWorkItemId: input.workItemId,
            idempotencyKey: key,
            imageCount: attempt.status === "SUCCEEDED" ? (input.imageCount ?? 0) : 0,
            inputUnits: attempt.inputUnits,
            kind: input.kind,
            latencyMs: attempt.latencyMs,
            model: attempt.modelId,
            outputUnits: attempt.outputUnits,
            provider: input.providerCodes.get(attempt.providerId) ?? attempt.providerId,
            providerRequestId: attempt.providerRequestId,
            retryable: attempt.retryable,
            status: attempt.status,
            tenantId: input.tenantId,
          },
          update: {
            errorCode: attempt.errorCode,
            estimatedCost: attempt.estimatedCost ?? 0,
            finishedAt: new Date(),
            latencyMs: attempt.latencyMs,
            providerRequestId: attempt.providerRequestId,
            retryable: attempt.retryable,
            status: attempt.status,
          },
          where: { tenantId_idempotencyKey: { idempotencyKey: key, tenantId: input.tenantId } },
        });
      }),
    );
  }

  private recordSyntheticInvocation(input: {
    campaignId: string;
    enterpriseId: string;
    generationRunId: string;
    idempotencyKey: string;
    imageCount?: number;
    kind: "EMPLOYEE_COPY" | "EMPLOYEE_IMAGE";
    model: string;
    provider: string;
    tenantId: string;
    workItemId: string;
  }) {
    return this.prisma.modelInvocation.upsert({
      create: {
        campaignId: input.campaignId,
        enterpriseId: input.enterpriseId,
        estimatedCost: 0,
        finishedAt: new Date(),
        generationRunId: input.generationRunId,
        generationWorkItemId: input.workItemId,
        idempotencyKey: input.idempotencyKey,
        imageCount: input.imageCount ?? 0,
        kind: input.kind,
        latencyMs: 0,
        model: input.model,
        provider: input.provider,
        providerRequestId: `synthetic-${input.idempotencyKey}`.slice(0, 200),
        status: "SUCCEEDED",
        tenantId: input.tenantId,
      },
      update: {},
      where: {
        tenantId_idempotencyKey: {
          idempotencyKey: input.idempotencyKey,
          tenantId: input.tenantId,
        },
      },
    });
  }

  private async scanContentSafety(
    workItemId: string,
    reservationVersion: number,
    attemptCount: number,
    variant: EmployeeVariant,
    images: readonly { bytes: Uint8Array; checksum: string; mimeType?: string; sequence: number }[],
    sourceFacts: string,
    publishingContext?: ReturnType<typeof medicalPublishingSafetyContext>,
  ): Promise<ContentSafetyScanResult | undefined> {
    if (!this.contentSafetyScanner) {
      if (this.requireContentSafety) {
        throw new PermanentGenerationError(
          "Production generation requires a configured content-safety scanner",
          "CONTENT_SAFETY_NOT_CONFIGURED",
        );
      }
      return undefined;
    }
    const started = Date.now();
    const requestId = `work:${workItemId}:v${reservationVersion}:attempt:${attemptCount}:content-safety`;
    try {
      return await this.contentSafetyScanner.scan({
        publishingContext,
        sourceFacts: sourceFacts.slice(0, 12000),
        images: images.map((image) => ({
          bytes: image.bytes,
          checksum: image.checksum,
          mimeType:
            image.mimeType === "image/jpeg"
              ? ("image/jpeg" as const)
              : image.mimeType === "image/webp"
                ? ("image/webp" as const)
                : ("image/png" as const),
          sequence: image.sequence,
        })),
        requestId,
        text: {
          body: variant.body,
          hashtags: variant.hashtags,
          title: variant.title,
        },
      });
    } catch (error) {
      const failure = error instanceof ContentSafetyInvocationError ? error : undefined;
      const latencyMs = Date.now() - started;
      writeStructuredLog({
        event: "content-safety.review-unavailable",
        fields: {
          ...failure?.context,
          attemptCount,
          errorCode: failure?.code ?? "CONTENT_SAFETY_UNEXPECTED",
          errorMessage: failure?.message ?? "Content-safety scanner failed unexpectedly",
          latencyMs,
          requestId,
          reservationVersion,
          retryable: failure?.retryable,
          workItemId,
        },
        level: "warn",
        service: "worker",
      });
      // A failed review must hold the generated content, not repeat image generation
      // or start another paid review automatically.
      return {
        decision: "REVIEW",
        categories: [
          {
            code: "REVIEW_UNAVAILABLE",
            decision: "REVIEW",
            message: "本次整体审核未完成，请人工确认；未自动重复生成或审核。",
          },
        ],
        checkedAt: new Date().toISOString(),
        latencyMs,
        provider: "configured-content-safety",
        providerRequestId: `work:${workItemId}:review-unavailable`,
      };
    }
  }

  private async workItemOrdinal(generationRunId: string, workItemId: string): Promise<number> {
    const items = await this.prisma.generationWorkItem.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
      where: { generationRunId },
    });
    const index = items.findIndex((item) => item.id === workItemId);
    if (index < 0) throw new Error("Generation work item ordinal could not be resolved");
    return index + 1;
  }

  private async assertImageUnique(
    campaignId: string,
    checksum: string,
    perceptualHash: string,
  ): Promise<void> {
    const existing = await this.prisma.generatedImage.findMany({
      select: { checksum: true, perceptualHash: true },
      where: { employeeContent: { campaignId } },
    });
    if (existing.some((image) => image.checksum === checksum)) {
      throw new Error("Generated image is an exact duplicate within the campaign");
    }
    const nearDuplicate = existing.find(
      (image) =>
        image.perceptualHash &&
        hashSimilarity(image.perceptualHash, perceptualHash) >= PHASH_REJECTION_SIMILARITY,
    );
    if (nearDuplicate) {
      throw new Error("Generated image is visually too similar to another campaign image");
    }
  }
}

function assertDeliveryBoundary(synthetic: boolean): void {
  if (synthetic && generationDeliveryMode() === "PRODUCTION") {
    throw new PermanentGenerationError(
      "Synthetic generation is forbidden by the production delivery boundary",
      "SYNTHETIC_ROUTE_FORBIDDEN",
    );
  }
}

type EmployeeVariant = {
  body: string;
  hashtags: string[];
  imagePrompt: string;
  title: string;
};

type PreparedImage = {
  checksum: string;
  key: string;
  model: string;
  perceptualHash: string;
  provider: string;
  reservationId: string;
  sequence: number;
  stored: StoredObject;
};

type CandidateImage = {
  bytes: Uint8Array;
  checksum: string;
  key: string;
  model: string;
  perceptualHash: string;
  provider: string;
  sequence: number;
};

type GenerationInput = {
  medicalPlan?: MedicalPlan;
  industryGuidance?: IndustryGenerationGuidanceSnapshot;
  imageAssets: FrozenImageAsset[];
  campaignBrief: string;
  generationStyle?: GenerationStyleSnapshot;
  geoSummary: string;
  materialSummary: string;
  sensitiveRuleSummary: string;
  sensitiveRules: SensitiveRuleInput[];
  sourceContext: Record<string, unknown>;
};

type SensitiveRuleInput = {
  replacementSuggestion: string | null;
  riskType: string;
  severity: "BLOCK" | "NOTICE" | "WARNING";
  term: string;
};

type RecordAttemptsInput = {
  attempts: readonly InvocationAttempt[];
  campaignId: string;
  enterpriseId: string;
  generationRunId: string;
  idempotencyPrefix: string;
  imageCount?: number;
  kind: "CAMPAIGN_BLUEPRINT" | "EMPLOYEE_COPY" | "EMPLOYEE_IMAGE";
  providerCodes: ReadonlyMap<string, string>;
  tenantId: string;
  workItemId?: string;
};

function parseFrozenRoute(value: Prisma.JsonValue | null): FrozenRoute {
  const route = record(value, "routing policy");
  const text = record(route.text, "text routing policy");
  const image = record(route.image, "image routing policy");
  const scopeType = requiredString(route.scopeType, "scope type");
  if (!(["ENTERPRISE", "PLAN", "PLATFORM", "TENANT"] as const).includes(scopeType as never)) {
    throw new Error("Frozen route has an invalid scope type");
  }
  return {
    image: {
      fallbacks: array(image.fallbacks).map(parseFrozenModel),
      primary: parseFrozenModel(image.primary),
    },
    maxAttemptsPerModel: requiredPositiveInteger(route.maxAttemptsPerModel, "max attempts"),
    routeId: requiredString(route.routeId, "route ID"),
    scopeId: requiredString(route.scopeId, "scope ID"),
    scopeType: scopeType as FrozenRoute["scopeType"],
    synthetic: route.synthetic === true,
    text: {
      fallbacks: array(text.fallbacks).map(parseFrozenModel),
      primary: parseFrozenModel(text.primary),
    },
  };
}

function parseFrozenModel(value: unknown): FrozenModel {
  const model = record(value, "frozen model");
  return {
    externalModelId: requiredString(model.externalModelId, "external model ID"),
    modelId: requiredString(model.modelId, "model ID"),
    providerCode: requiredString(model.providerCode, "provider code"),
    providerId: requiredString(model.providerId, "provider ID"),
  };
}

function parseGenerationInput(value: Prisma.JsonValue | null): GenerationInput {
  const input = record(value, "generation input");
  let medicalPlan: MedicalPlan | undefined;
  try {
    medicalPlan = readMedicalPlan(input.medicalPlan);
  } catch (error) {
    throw new PermanentGenerationError(
      error instanceof Error ? error.message : "Invalid medical plan",
      "MEDICAL_PLAN_INVALID",
    );
  }
  return {
    medicalPlan,
    industryGuidance: readIndustryGenerationGuidance(input.industryGuidance),
    imageAssets: array(input.imageAssets).map((value) => {
      const asset = record(value, "image asset");
      return {
        artifactId: requiredString(asset.artifactId, "artifact ID"),
        materialId: requiredString(asset.materialId, "material ID"),
        objectKey: requiredString(asset.objectKey, "object key"),
        checksum: requiredString(asset.checksum, "checksum"),
        mimeType: requiredString(asset.mimeType, "image mime"),
        description: optionalString(asset.description),
        usage: asset.usage === "LOGO" ? ("LOGO" as const) : ("REFERENCE" as const),
        privacyConfirmed: asset.privacyConfirmed === true,
        authorizationConfirmed: asset.authorizationConfirmed === true,
      };
    }),
    campaignBrief: optionalString(input.campaignBrief),
    generationStyle: readGenerationStyleSnapshot(input.generationStyle),
    geoSummary: optionalString(input.geoSummary),
    materialSummary: optionalString(input.materialSummary),
    sensitiveRuleSummary: optionalString(input.sensitiveRuleSummary),
    sensitiveRules: array(input.sensitiveRules).map((value) => {
      const rule = record(value, "sensitive rule");
      const severity = requiredString(rule.severity, "sensitive severity");
      if (!(["BLOCK", "NOTICE", "WARNING"] as const).includes(severity as never)) {
        throw new Error("Generation input has an invalid sensitive severity");
      }
      return {
        replacementSuggestion:
          typeof rule.replacementSuggestion === "string" ? rule.replacementSuggestion : null,
        riskType: requiredString(rule.riskType, "sensitive risk type"),
        severity: severity as SensitiveRuleInput["severity"],
        term: requiredString(rule.term, "sensitive term"),
      };
    }),
    sourceContext: record(input.sourceContext, "source context"),
  };
}

function syntheticBlueprint(prompt: string, input: GenerationInput) {
  if (input.medicalPlan)
    return {
      imageDirection: `问题任务：${input.medicalPlan.topics.map((topic) => topic.question).join("；")}；模式：${input.medicalPlan.imageMode}；无自动Logo。`,
      masterCopy: `合成测试，仅用于验证流程，不可发布。\n${input.medicalPlan.topics.map((topic) => topic.question).join("\n")}\n事实候选：${input.materialSummary}`,
    };
  return {
    imageDirection: input.generationStyle
      ? `小红书无文字竖版配图；主题为“${truncate(prompt, 120)}”；${input.generationStyle.imageStyle.name}。`
      : `小红书竖版信息海报；主题为“${truncate(prompt, 120)}”；暖白、珊瑚红和抽象技术纹理，不出现员工个人信息。`,
    masterCopy: [
      truncate(prompt, 500),
      input.materialSummary ? `可用事实：\n${input.materialSummary}` : "当前没有已授权素材。",
      input.geoSummary ? `GEO 信息：\n${input.geoSummary}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

function syntheticMedicalVariant(input: GenerationInput, ordinal: number): EmployeeVariant {
  const plan = input.medicalPlan;
  if (!plan) throw new Error("Synthetic medical plan missing");
  const topic = plan.topics[(ordinal - 1) % plan.topics.length];
  return {
    title: `测试：${topic?.question ?? "准备问题"}`,
    body: `这是一份合成流程测试稿，不能作为真实笔记发布。\n\n主要问题：${topic?.question ?? "准备问题"}。\n请核对真实依据、实际发布条件及图片授权；没有实际经历时不写个人诊疗体验。具体事项需要向专业人员确认，不能从测试内容推断医疗结论。`,
    hashtags: ["流程测试"],
    imagePrompt: `明确示意插画，不模拟真实人物或诊疗证据；问题为${topic?.question ?? "准备问题"}`,
  };
}

function syntheticEmployeeVariant(
  masterCopy: string,
  imageDirection: string,
  campaignTitle: string,
  ordinal: number,
  reviewFeedback?: string | null,
): EmployeeVariant {
  const openers = [
    "最近认真了解了一项很有意思的技术",
    "把复杂的技术说得简单一点",
    "今天想分享一个值得关注的新选择",
    "做功课时，我特别留意了这些细节",
    "如果你也在比较不同方案，可以先看这里",
  ];
  const angles = [
    "设备配置、操作流程与真实适用条件都值得逐项确认",
    "效果之外，也要关注规范评估与个体差异",
    "专业设备只是基础，完整流程同样重要",
    "先理解技术原理，再结合自身情况做判断会更稳妥",
  ];
  const opener = openers[(ordinal - 1) % openers.length] ?? openers[0] ?? "内容分享";
  const angle =
    angles[Math.floor((ordinal - 1) / openers.length) % angles.length] ?? angles[0] ?? "理性了解";
  return {
    body: [
      opener,
      "",
      truncate(masterCopy.split("\n")[0] ?? campaignTitle, 420),
      "",
      angle,
      reviewFeedback ? `\n本次已按审核要求调整：${truncate(reviewFeedback, 180)}` : "",
      "",
      "以上是信息分享，具体方案仍应以专业评估为准。",
    ].join("\n"),
    hashtags: ["小红书营销", "专业科普", "GEO内容", compactHashtag(campaignTitle)],
    imagePrompt: `${imageDirection}；视觉变化编号 ${ordinal}${reviewFeedback ? "；按审核意见重新构图" : ""}。`,
    title: `${truncate(campaignTitle, 62)}｜独立内容 ${ordinal}${reviewFeedback ? " 修订版" : ""}`,
  };
}

async function syntheticImage(title: string, seed: string, sequence: number): Promise<Uint8Array> {
  const digest = createHash("sha256").update(seed).digest("hex");
  const hue = 346 + (Number.parseInt(digest.slice(0, 4), 16) % 24);
  const x = 180 + (Number.parseInt(digest.slice(4, 8), 16) % 720);
  const y = 180 + (Number.parseInt(digest.slice(8, 12), 16) % 980);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440"><rect width="1080" height="1440" fill="#fffaf9"/><rect x="54" y="54" width="972" height="1332" rx="44" fill="hsl(${hue} 82% 95%)"/><circle cx="${x}" cy="${y}" r="210" fill="hsl(${hue} 80% 58%)" opacity=".12"/><path d="M120 1050 C ${x} 700, ${x + 200} 1250, 960 820" fill="none" stroke="hsl(${hue} 70% 48%)" stroke-width="28" opacity=".18"/><text x="112" y="340" font-family="Arial" font-size="66" font-weight="700" fill="#2b2022">SYNTHETIC PILOT</text><text x="112" y="430" font-family="Arial" font-size="32" fill="#6d555a">${escapeXml(truncate(title, 28))}</text><text x="112" y="1280" font-family="monospace" font-size="22" fill="#9e858a">${digest.slice(0, 20)} · ${sequence}</text></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

export function sanitizeVariant(variant: EmployeeVariant, rules: readonly SensitiveRuleInput[]) {
  const riskAssessment = {
    notices: [] as string[],
    passed: true,
    replacedBlocks: [] as string[],
    unresolvedBlocks: [] as string[],
    warnings: [] as string[],
  };
  let title = variant.title;
  let body = variant.body;
  for (const rule of rules) {
    const combined = `${title}\n${body}`;
    if (!containsLiteral(combined, rule.term)) continue;
    if (rule.severity === "BLOCK") {
      const replacement = rule.replacementSuggestion?.trim() || "审慎表述";
      title = replaceLiteral(title, rule.term, replacement);
      body = replaceLiteral(body, rule.term, replacement);
      riskAssessment.replacedBlocks.push(`${rule.term} → ${replacement}`);
    } else if (rule.severity === "WARNING") {
      riskAssessment.warnings.push(`${rule.riskType}: ${rule.term}`);
    } else {
      riskAssessment.notices.push(`${rule.riskType}: ${rule.term}`);
    }
  }
  riskAssessment.passed =
    riskAssessment.warnings.length === 0 && riskAssessment.unresolvedBlocks.length === 0;
  return { riskAssessment, variant: { ...variant, body, title } };
}

function mergeContentSafetyAssessment(
  local: ReturnType<typeof sanitizeVariant>["riskAssessment"],
  external: ContentSafetyScanResult | undefined,
) {
  if (!external) return local;
  const warnings = [...local.warnings];
  const unresolvedBlocks = [...local.unresolvedBlocks];
  const evidence = external.categories.map((category) => {
    const score = category.score === undefined ? "" : ` (${category.score.toFixed(4)})`;
    return `${category.code}${score}${category.message ? `: ${category.message}` : ""}`;
  });
  if (external.decision === "REVIEW") {
    warnings.push(...(evidence.length > 0 ? evidence : ["外部内容安全服务要求人工复核"]));
  }
  if (external.decision === "BLOCK") {
    unresolvedBlocks.push(...(evidence.length > 0 ? evidence : ["外部内容安全服务拒绝该图文"]));
  }
  return {
    ...local,
    contentSafety: {
      categories: external.categories,
      checkedAt: external.checkedAt,
      decision: external.decision,
      latencyMs: external.latencyMs,
      model: external.model,
      provider: external.provider,
      providerRequestId: external.providerRequestId,
    },
    passed: warnings.length === 0 && unresolvedBlocks.length === 0,
    unresolvedBlocks,
    warnings,
  };
}

async function finalizeGenerationRun(
  transaction: Prisma.TransactionClient,
  generationRunId: string,
  campaignId: string,
): Promise<void> {
  const [succeeded, failed, total] = await Promise.all([
    transaction.generationWorkItem.count({ where: { generationRunId, status: "SUCCEEDED" } }),
    transaction.generationWorkItem.count({ where: { generationRunId, status: "FAILED" } }),
    transaction.generationWorkItem.count({ where: { generationRunId } }),
  ]);
  const terminal = succeeded + failed === total;
  await transaction.generationRun.update({
    data: {
      completedCount: succeeded,
      failedCount: failed,
      finishedAt: terminal ? new Date() : null,
      status: terminal ? (failed > 0 ? "FAILED" : "SUCCEEDED") : "RUNNING",
    },
    where: { id: generationRunId },
  });
  await transaction.campaign.update({
    data: {
      generatedCount: succeeded,
      status: terminal ? (failed > 0 ? "GENERATION_FAILED" : "REVIEW_PENDING") : "GENERATING",
    },
    where: { id: campaignId },
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function truncate(value: string, length: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= length ? normalized : `${normalized.slice(0, length - 1)}…`;
}

function compactHashtag(value: string): string {
  return value.replace(/[\s#｜|]+/g, "").slice(0, 18) || "品牌内容";
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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
