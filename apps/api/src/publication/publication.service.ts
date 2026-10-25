import { createHash, randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  type Prisma,
  Prisma as PrismaNamespace,
  type PublishSubmission,
} from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { CampaignService } from "../campaign/campaign.service";
import { ImageDeliveryService } from "../campaign/image-delivery.service";
import {
  assertTaskFactsConfirmed,
  assertTaskPublishingCurrent,
  medicalPublicationIssue,
} from "../campaign/medical-task-policy";
import { PrismaService } from "../database/prisma.service";
import { pageTake, timestampCursorWhere, toCursorPageBy } from "../http/cursor-pagination";
import {
  PlatformPublicationVerificationService,
  type PublicationVerificationConfiguration,
  PublicationVerificationInvocationError,
  type PublicContentEvidence,
  type PublicContentResolution,
} from "../platform-settings/platform-publication-verification.service";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import type {
  CreateDevelopmentPublicationDto,
  IngestPublicationMetricsDto,
  LateCorrectPublicationDto,
  PublicationReviewQueryDto,
  ReviewPublicationDto,
  SubmitPublicationDto,
} from "./publication.dto";
import { PublicationCollectorService } from "./publication-collector.service";
import { normalizeMetricSnapshot } from "./publication-metric-snapshot";
import { publicMetricSnapshot } from "./publication-metrics-public";
import {
  publicationMetricsProductionMode,
  publicationMetricsSignatureStatus,
} from "./publication-metrics-security";
import { READBACK_POLICY_VERSION } from "./publication-readback-policy";
import { recoverDisabledReadbackLeases } from "./publication-readback-recovery";
import {
  extractPublicationAccessUrl,
  type NormalizedPublicationUrl,
  normalizePublicationUrl,
} from "./publication-url";
import { evaluatePublicationEvidence } from "./publication-verification-scoring";

type EnterpriseScope = Readonly<{ tenantId: string; enterpriseId: string }>;

const VERIFICATION_TASK_INCLUDE = {
  campaign: {
    select: { audienceCount: true, id: true, status: true, title: true, selectionSnapshot: true },
  },
  membership: { select: { publisherContext: true } },
  employeeContent: {
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
          campaignId: true,
          checksum: true,
          createdAt: true,
          employeeContentId: true,
          height: true,
          id: true,
          imageUrl: true,
          mimeType: true,
          perceptualHash: true,
          sequence: true,
          storageKey: true,
          tenantId: true,
          width: true,
        },
      },
      membershipId: true,
      riskAssessment: true,
      revision: true,
      status: true,
      tenantId: true,
      title: true,
      updatedAt: true,
    },
  },
  enterprise: { select: { id: true, name: true } },
} as const satisfies Prisma.DistributionTaskInclude;

type VerificationTask = Prisma.DistributionTaskGetPayload<{
  include: typeof VERIFICATION_TASK_INCLUDE;
}>;

type VerificationActor = Readonly<{
  actorType: "USER";
  actorUserId: string;
}>;

type VerificationStart = Readonly<{
  attempt: number;
  correctionReason: string | null;
  lateCorrection: boolean;
}>;

@Injectable()
export class PublicationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(TenantCapabilityService)
    private readonly capabilities: TenantCapabilityService,
    @Inject(CampaignService) private readonly campaigns: CampaignService,
    @Inject(ImageDeliveryService) private readonly imageDelivery: ImageDeliveryService,
    @Inject(PlatformPublicationVerificationService)
    private readonly publicationVerification: PlatformPublicationVerificationService,
    @Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader,
    @Inject(PublicationCollectorService)
    private readonly collector: PublicationCollectorService,
  ) {}

  async createDevelopmentPublication(taskId: string, input: CreateDevelopmentPublicationDto) {
    this.assertDevelopmentFixtureEnabled();
    const principal = this.accessContext.requireEmployee();
    const now = new Date();
    await this.campaigns.reconcileEmployeeTasks(principal.membershipIds, now);
    const task = await this.findEmployeeTask(taskId, principal.membershipIds);
    assertEmployeeSubmissionAllowed(task, now);
    const existing = await this.prisma.publicContentFixture.findUnique({
      where: { taskId: task.id },
    });
    if (existing) return fixtureResponse(existing);

    const fixtureId = randomUUID();
    const url = normalizePublicationUrl(`https://fixture.xhs.local/explore/${fixtureId}`);
    const matching = input.contentMode === "MATCH";
    const fixture = await this.prisma.publicContentFixture.create({
      data: {
        body: matching
          ? `${task.employeeContent.body}\n\n${task.employeeContent.hashtags.map((tag) => `#${tag}`).join(" ")}`
          : "这是一条与任务主题无关的开发验真样本，用于证明错误内容不会被系统通过。",
        canonicalKey: url.canonicalKey,
        imageUrls: matching
          ? task.employeeContent.images.map(({ imageUrl }) => imageUrl)
          : ["https://fixture.xhs.local/assets/unrelated-synthetic.svg"],
        normalizedUrl: url.normalizedUrl,
        synthetic: true,
        taskId: task.id,
        tenantId: task.tenantId,
        title: matching ? task.employeeContent.title : "无关内容验真样本",
      },
    });
    return fixtureResponse(fixture);
  }

  async submitEmployeePublication(taskId: string, input: SubmitPublicationDto) {
    const principal = this.accessContext.requireEmployee();
    const now = new Date();
    await this.campaigns.reconcileEmployeeTasks(principal.membershipIds, now);
    const task = await this.findEmployeeTask(taskId, principal.membershipIds);
    assertEmployeeSubmissionAllowed(task, now);
    return this.verifyNewSubmission(
      task,
      input.url,
      { actorType: "USER", actorUserId: principal.userId },
      { attempt: 1, correctionReason: null, lateCorrection: false },
    );
  }

  async lateCorrectPublication(
    scope: EnterpriseScope,
    taskId: string,
    input: LateCorrectPublicationDto,
  ) {
    const principal = this.requireEnterpriseScope(scope);
    const task = await this.prisma.distributionTask.findFirst({
      include: VERIFICATION_TASK_INCLUDE,
      where: {
        enterpriseId: scope.enterpriseId,
        id: taskId,
        status: "EXPIRED",
        tenantId: scope.tenantId,
      },
    });
    if (!task) throw new NotFoundException("可逾期核实的员工任务不存在于当前企业");
    return this.verifyNewSubmission(
      task,
      input.url,
      { actorType: "USER", actorUserId: principal.userId },
      { attempt: 1, correctionReason: input.reason, lateCorrection: true },
    );
  }

  async retryPublicationVerification(scope: EnterpriseScope, submissionId: string, reason: string) {
    const principal = this.requireEnterpriseScope(scope);
    const submission = await this.prisma.publishSubmission.findFirst({
      include: { task: { include: VERIFICATION_TASK_INCLUDE } },
      where: {
        id: submissionId,
        status: { in: ["UNAVAILABLE", "MANUAL_REVIEW"] },
        task: { enterpriseId: scope.enterpriseId },
        tenantId: scope.tenantId,
      },
    });
    if (!submission) {
      throw new NotFoundException("可重试的发布验真记录不存在于当前企业");
    }
    await this.prisma.auditLog.create({
      data: {
        action: "publication.verification.retry-requested",
        actorType: "USER",
        actorUserId: principal.userId,
        enterpriseId: scope.enterpriseId,
        reason,
        resourceId: submission.id,
        resourceType: "PublishSubmission",
        tenantId: scope.tenantId,
      },
    });
    return this.verifyNewSubmission(
      submission.task,
      submission.rawUrl,
      { actorType: "USER", actorUserId: principal.userId },
      {
        attempt: submission.verificationAttempt + 1,
        correctionReason: submission.correctionReason,
        lateCorrection: submission.lateCorrection,
      },
    );
  }

  async listManualReviews(scope: EnterpriseScope, query: PublicationReviewQueryDto) {
    this.requireEnterpriseScope(scope);
    await recoverDisabledReadbackLeases(this.prisma, this.settings, scope);
    const direction = query.taskId ? "desc" : "asc";
    const submissions = await this.prisma.publishSubmission.findMany({
      include: {
        task: { include: VERIFICATION_TASK_INCLUDE },
        readbackSnapshots: {
          orderBy: { observedAt: "desc" },
          select: {
            observedAt: true,
            windowHours: true,
            source: true,
            likes: true,
            comments: true,
            favorites: true,
          },
          take: 1,
        },
      },
      orderBy: [{ submittedAt: direction }, { id: direction }],
      take: pageTake(query),
      where: {
        AND: [
          {
            ...(query.taskId
              ? { taskId: query.taskId }
              : { status: { in: ["MANUAL_REVIEW", "UNAVAILABLE"] } }),
            task: { enterpriseId: scope.enterpriseId },
            tenantId: scope.tenantId,
          },
          timestampCursorWhere(query, "submittedAt", direction),
        ],
      },
    });
    const page = toCursorPageBy(submissions, query, ({ submittedAt }) => submittedAt);
    return {
      ...page,
      items: await Promise.all(
        page.items.map(async (submission) => ({
          ...publicationSubmissionView(submission),
          readback: submission.readbackSnapshots[0] ?? null,
          task: {
            ...submission.task,
            employeeContent: {
              ...submission.task.employeeContent,
              images: (
                await this.imageDelivery.signImages(submission.task.employeeContent.images)
              ).map(({ storageKey: _storageKey, ...image }) => image),
            },
          },
        })),
      ),
    };
  }

  async reviewManualSubmission(
    scope: EnterpriseScope,
    submissionId: string,
    input: ReviewPublicationDto,
  ) {
    const principal = this.requireEnterpriseScope(scope);
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const submission = await transaction.publishSubmission.findFirst({
            include: { task: { include: VERIFICATION_TASK_INCLUDE } },
            where: {
              id: submissionId,
              status: { in: ["MANUAL_REVIEW", "UNAVAILABLE"] },
              task: { enterpriseId: scope.enterpriseId },
              tenantId: scope.tenantId,
            },
          });
          if (!submission) throw new NotFoundException("人工复核记录不存在于当前企业");
          const now = new Date();
          if (input.decision === "REJECTED") {
            await transaction.publishSubmission.update({
              data: {
                failureReason: input.reason,
                status: "INVALID",
                verificationFinishedAt: now,
                verifier: "admin-manual-v2",
              },
              where: { id: submission.id },
            });
            await transaction.distributionTask.update({
              data:
                submission.lateCorrection || submission.task.expiresAt <= now
                  ? { expiredAt: submission.task.expiredAt ?? now, status: "EXPIRED" }
                  : { status: "AVAILABLE" },
              where: { id: submission.taskId },
            });
          } else {
            assertTaskFactsConfirmed(submission.task, submission.task.employeeContent.revision);
            if (submission.task.campaign.selectionSnapshot) {
              const issue = medicalPublicationIssue(submission.task, input.authorId, true);
              if (issue || !input.authorEvidence?.trim())
                throw new ConflictException(issue ?? "请填写核对员工与实际发布者归属的依据。");
              const observation = await transaction.auditLog.findFirst({
                where: {
                  tenantId: scope.tenantId,
                  enterpriseId: scope.enterpriseId,
                  action: "publication.author-observed",
                  resourceId: submission.id,
                },
                orderBy: { createdAt: "desc" },
                select: { metadata: true },
              });
              const observed = observation?.metadata;
              if (observed && typeof observed === "object" && !Array.isArray(observed)) {
                if (observed.authorId && observed.authorId !== input.authorId)
                  throw new ConflictException("人工填写的发布者与回读证据不一致，请核查原笔记。");
                if (observed.contentRevision !== submission.task.employeeContent.revision)
                  throw new ConflictException("回读后内容已更新，请提交最新版本的发布链接。");
              }
            }
            const duplicate = await transaction.publishedContentRegistry.findUnique({
              select: { id: true },
              where: { canonicalKey: submission.canonicalKey },
            });
            if (duplicate) throw new DuplicateCanonicalKeyError();
            await transaction.publishSubmission.update({
              data: {
                failureReason: null,
                matchScore: submission.matchScore ?? 1,
                status: "VALID",
                verificationFinishedAt: now,
                verifiedAt: now,
                verifier: "admin-manual-v2",
              },
              where: { id: submission.id },
            });
            const registry = await transaction.publishedContentRegistry.create({
              data: {
                campaignId: submission.task.campaignId,
                canonicalKey: submission.canonicalKey,
                contentFingerprint: submission.task.employeeContent.contentFingerprint,
                normalizedUrl: submission.normalizedUrl,
                submissionId: submission.id,
                taskId: submission.taskId,
                tenantId: scope.tenantId,
                verifiedAt: now,
              },
            });
            if (submission.adapterProvider === "WINDOWS_BROWSER") {
              await this.collector.scheduleMetricsAfterManualApproval(
                transaction,
                submission,
                registry,
                now,
              );
            }
            await transaction.distributionTask.update({
              data: {
                status: submission.lateCorrection ? "LATE_CORRECTED" : "COMPLETED",
                submittedAt: submission.submittedAt,
                verifiedAt: now,
              },
              where: { id: submission.taskId },
            });
            if (!submission.lateCorrection) {
              await completeCampaignIfEligible(
                transaction,
                submission.task.campaignId,
                scope.tenantId,
              );
            }
          }
          await transaction.auditLog.create({
            data: {
              action: `publication.manual-review.${input.decision.toLocaleLowerCase()}`,
              actorType: "USER",
              actorUserId: principal.userId,
              enterpriseId: scope.enterpriseId,
              reason: input.reason,
              metadata: {
                lateCorrection: submission.lateCorrection,
                submittedBeforeExpiry: submission.submittedAt < submission.task.expiresAt,
                ...(submission.task.campaign.selectionSnapshot && input.decision === "VERIFIED"
                  ? {
                      accountOwnershipChecked: true,
                      ownershipEvidenceType: "ENTERPRISE_MANUAL_DECLARATION",
                      authorId: input.authorId,
                      authorEvidence: input.authorEvidence,
                      contentRevision: submission.task.employeeContent.revision,
                    }
                  : {}),
              },
              resourceId: submission.id,
              resourceType: "PublishSubmission",
              tenantId: scope.tenantId,
            },
          });
          return publicationSubmissionView(
            await transaction.publishSubmission.findUniqueOrThrow({ where: { id: submission.id } }),
          );
        },
        { isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof DuplicateCanonicalKeyError ||
        (error instanceof PrismaNamespace.PrismaClientKnownRequestError && error.code === "P2002")
      ) {
        throw new ConflictException("该公开内容已被其他员工任务有效占用");
      }
      throw error;
    }
  }

  async ingestMetrics(
    timestamp: string | undefined,
    signature: string | undefined,
    input: IngestPublicationMetricsDto,
  ) {
    await this.assertMetricsSignature(timestamp, signature, input);
    const metricEvidence = normalizeMetricSnapshot(input);
    const registry = await this.prisma.publishedContentRegistry.findUnique({
      select: { campaignId: true, id: true, tenantId: true, verifiedAt: true },
      where: { canonicalKey: input.canonicalKey },
    });
    if (!registry) throw new NotFoundException("有效发布内容不存在");
    await this.capabilities.requireMetricsIntegration(registry.tenantId);
    const observedAt = new Date(input.observedAt);
    if (observedAt < registry.verifiedAt) {
      throw new ConflictException("指标观察时间不能早于发布验真时间");
    }
    const source = input.source.trim().toLocaleUpperCase();
    const unique = { observedAt, registryId: registry.id, source };
    const matches = (snapshot: {
      comments: number | null;
      favorites: number | null;
      likes: number | null;
      rawData: Prisma.JsonValue | null;
      shares: number | null;
      views: number | null;
      windowHours: number | null;
    }) =>
      snapshot.comments === metricEvidence.values.comments &&
      snapshot.favorites === metricEvidence.values.favorites &&
      snapshot.likes === metricEvidence.values.likes &&
      snapshot.shares === metricEvidence.values.shares &&
      snapshot.views === metricEvidence.values.views &&
      snapshot.windowHours === (input.windowHours ?? null) &&
      stableJson(snapshot.rawData) === stableJson(metricEvidence.rawData);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const previous = await transaction.publishMetricSnapshot.findUnique({
          where: { registryId_observedAt_source: unique },
        });
        if (previous) {
          if (!matches(previous)) throw new ConflictException("同一时间的公开指标已有不同证据");
          return publicMetricSnapshot(previous);
        }
        const snapshot = await transaction.publishMetricSnapshot.create({
          data: {
            campaignId: registry.campaignId,
            comments: metricEvidence.values.comments,
            favorites: metricEvidence.values.favorites,
            likes: metricEvidence.values.likes,
            observedAt,
            rawData: metricEvidence.rawData
              ? (metricEvidence.rawData as Prisma.InputJsonValue)
              : undefined,
            registryId: registry.id,
            shares: metricEvidence.values.shares,
            source,
            tenantId: registry.tenantId,
            views: metricEvidence.values.views,
            windowHours: input.windowHours,
          },
        });
        await transaction.auditLog.create({
          data: {
            action: "publication.metrics.ingest",
            actorType: "INTEGRATION",
            metadata: {
              canonicalKeyHash: createHash("sha256").update(input.canonicalKey).digest("hex"),
              observedAt: input.observedAt,
              source,
              windowHours: input.windowHours ?? null,
            },
            resourceId: snapshot.id,
            resourceType: "PublishMetricSnapshot",
            tenantId: registry.tenantId,
          },
        });
        return publicMetricSnapshot(snapshot);
      });
    } catch (error) {
      if (
        error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const previous = await this.prisma.publishMetricSnapshot.findUnique({
          where: { registryId_observedAt_source: unique },
        });
        if (previous && matches(previous)) return publicMetricSnapshot(previous);
        throw new ConflictException("同一时间的公开指标已有不同证据");
      }
      throw error;
    }
  }

  private async verifyNewSubmission(
    task: VerificationTask,
    rawUrl: string,
    actor: VerificationActor,
    start: VerificationStart,
  ) {
    assertTaskFactsConfirmed(task, task.employeeContent.revision);
    const normalized = normalizePublicationUrl(rawUrl);
    assertSupportedPublicationUrl(normalized, start.lateCorrection);
    const configuration = await this.publicationVerification.current();
    let deferredReadback =
      configuration.mode === "READBACK" && normalized.classification !== "DEV_FIXTURE";
    let manualReview =
      (configuration.mode === "MANUAL" || configuration.mode === "DEVELOPMENT") &&
      normalized.classification !== "DEV_FIXTURE";
    if (normalized.classification === "DEV_FIXTURE") this.assertDevelopmentFixtureEnabled();
    if (
      !deferredReadback &&
      configuration.mode === "BROWSER" &&
      normalized.classification !== "DEV_FIXTURE"
    ) {
      // Reject unsendable links before recording an outbox row that could
      // otherwise block the collector indefinitely at the head of the queue.
      extractPublicationAccessUrl(rawUrl);
    }
    const startedAt = new Date();
    const submission = await this.prisma.$transaction(async (transaction) => {
      if (deferredReadback) {
        await transaction.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(7100910101::bigint)`;
        const current = await this.settings.resolveMany(
          ["publication.readback_enabled"],
          transaction,
        );
        if (current.get("publication.readback_enabled")?.value !== true) {
          deferredReadback = false;
          manualReview = true;
        }
      }
      // Reserve the confirmed revision together with its submission and outbox row.
      const reserved = await transaction.distributionTask.updateMany({
        data: start.lateCorrection
          ? { status: "EXPIRED" }
          : { status: "VERIFYING", submittedAt: startedAt },
        where: {
          id: task.id,
          status: start.lateCorrection
            ? "EXPIRED"
            : start.attempt === 1
              ? "AVAILABLE"
              : task.status,
          ...(!start.lateCorrection && start.attempt === 1 ? { expiresAt: { gt: startedAt } } : {}),
          employeeContent: { revision: task.employeeContent.revision },
          factsConfirmedAt: { not: null },
          factsConfirmedRevision: task.employeeContent.revision,
          factsReturnedAt: null,
        },
      });
      if (reserved.count !== 1) {
        throw new ConflictException("任务、内容版本或真实性确认已变化，请刷新后重新确认");
      }
      await supersedeOpenSubmissions(transaction, task.id);
      const created = await transaction.publishSubmission.create({
        data: {
          adapterProvider:
            normalized.classification === "DEV_FIXTURE"
              ? "DEVELOPMENT_FIXTURE"
              : deferredReadback
                ? "DISTRIBUTED_READBACK"
                : configuration.mode === "BROWSER"
                  ? "WINDOWS_BROWSER"
                  : configuration.adapter?.providerCode,
          canonicalKey: normalized.canonicalKey,
          correctionReason: start.correctionReason,
          extractedUrl: normalized.normalizedUrl,
          lateCorrection: start.lateCorrection,
          normalizedUrl: normalized.normalizedUrl,
          rawUrl,
          resolvedUrl: normalized.normalizedUrl,
          status: manualReview ? "MANUAL_REVIEW" : "VERIFYING",
          submittedAt: startedAt,
          synthetic: normalized.classification === "DEV_FIXTURE",
          taskId: task.id,
          tenantId: task.tenantId,
          verificationAttempt: start.attempt,
          verificationPolicyVersion: deferredReadback
            ? READBACK_POLICY_VERSION
            : configuration.policy.policyVersion,
          verificationStartedAt: startedAt,
          verifier:
            normalized.classification === "DEV_FIXTURE"
              ? "development-fixture-content-match-v2"
              : manualReview
                ? "enterprise-manual-review-pending-v1"
                : deferredReadback
                  ? "distributed-api-readback-pending-v1"
                  : configuration.mode === "BROWSER"
                    ? "windows-browser-awaiting-evidence-v1"
                    : `${configuration.adapter?.providerCode ?? "unconfigured"}-http-v1`,
        },
      });
      if (manualReview) {
        await transaction.auditLog.create({
          data: {
            action: "publication.manual-review.requested",
            actorType: "USER",
            actorUserId: actor.actorUserId,
            tenantId: task.tenantId,
            enterpriseId: task.enterpriseId,
            resourceType: "PublishSubmission",
            resourceId: created.id,
            reason: "发布回填已保留，等待企业管理员人工复核",
          },
        });
      } else if (deferredReadback) {
        await transaction.publicationCollectionJob.create({
          data: {
            dueAt: new Date(startedAt.getTime() + 24 * 60 * 60_000),
            kind: "READBACK",
            submissionId: created.id,
            windowHours: 24,
          },
        });
      } else if (configuration.mode === "BROWSER" && normalized.classification !== "DEV_FIXTURE") {
        await transaction.publicationCollectionJob.create({
          data: { dueAt: startedAt, kind: "VERIFY", submissionId: created.id },
        });
      }
      return created;
    });

    // The outbox row and submittedAt were committed together; no browser
    // navigation or external HTTP call occurs in an employee request.
    if (
      manualReview ||
      deferredReadback ||
      (configuration.mode === "BROWSER" && normalized.classification !== "DEV_FIXTURE")
    ) {
      return submissionResult(submission);
    }

    let resolution: PublicContentResolution;
    try {
      resolution = await this.resolvePublicContent(task, normalized, submission.id, configuration);
    } catch (error) {
      const invocation =
        error instanceof PublicationVerificationInvocationError
          ? error
          : new PublicationVerificationInvocationError(
              "公开内容验真服务暂时不可用",
              "PUBLICATION_VERIFICATION_UNKNOWN",
              true,
            );
      return this.finalizeUnavailable(task, submission.id, normalized, configuration, invocation);
    }
    if (!resolution.available) {
      return this.finalizeUnavailable(
        task,
        submission.id,
        normalized,
        configuration,
        new PublicationVerificationInvocationError(
          resolution.reason,
          "PUBLIC_CONTENT_UNAVAILABLE",
          true,
        ),
      );
    }
    return this.finalizeEvidence(task, submission.id, resolution.evidence, configuration, actor);
  }

  private async resolvePublicContent(
    task: VerificationTask,
    normalized: NormalizedPublicationUrl,
    submissionId: string,
    configuration: PublicationVerificationConfiguration,
  ): Promise<PublicContentResolution> {
    if (normalized.classification === "DEV_FIXTURE") {
      this.assertDevelopmentFixtureEnabled();
      const fixture = await this.prisma.publicContentFixture.findUnique({
        where: { canonicalKey: normalized.canonicalKey },
      });
      if (!fixture) return { available: false, reason: "本机公开内容样本不存在" };
      return {
        available: true,
        evidence: {
          adapterModel: "fixture-v2",
          adapterReference: fixture.id,
          adapterRequestId: `fixture:${fixture.id}`,
          body: fixture.body,
          canonicalKey: fixture.canonicalKey,
          canonicalUrl: fixture.normalizedUrl,
          externalPublishedAt: fixture.publishedAt.toISOString(),
          hashtags: [],
          images: fixture.imageUrls.map((url) => ({
            checksum: null,
            perceptualHash: null,
            url,
          })),
          provider: "DEVELOPMENT_FIXTURE",
          title: fixture.title,
        },
      };
    }
    if (!configuration.adapter) {
      return {
        available: false,
        reason: "当前未配置正式公开内容验真服务，提交事实已保留并等待人工确认",
      };
    }
    return configuration.adapter.resolve(
      normalized.normalizedUrl,
      `submission:${submissionId}:task:${task.id}`,
    );
  }

  private async finalizeEvidence(
    task: VerificationTask,
    submissionId: string,
    evidence: PublicContentEvidence,
    configuration: PublicationVerificationConfiguration,
    actor: VerificationActor,
  ) {
    const existingRegistry = await this.prisma.publishedContentRegistry.findUnique({
      select: { id: true },
      where: { canonicalKey: evidence.canonicalKey },
    });
    if (existingRegistry) {
      return this.finalizeDuplicate(task, submissionId, evidence);
    }
    const evaluation = evaluatePublicationEvidence({
      actual: evidence,
      expected: task.employeeContent,
      policy: configuration.policy,
    });
    const latest = await this.prisma.distributionTask.findUniqueOrThrow({
      include: VERIFICATION_TASK_INCLUDE,
      where: { id: task.id },
    });
    if (task.campaign.selectionSnapshot)
      await this.prisma.auditLog.create({
        data: {
          action: "publication.author-observed",
          actorType: "INTEGRATION",
          tenantId: task.tenantId,
          enterpriseId: task.enterpriseId,
          resourceId: submissionId,
          resourceType: "PublishSubmission",
          metadata: {
            authorId: evidence.authorId ?? null,
            contentRevision: task.employeeContent.revision,
            provider: evidence.provider,
          },
        },
      });
    const publishingIssue =
      latest.employeeContent.revision !== task.employeeContent.revision
        ? "验真期间内容已更新，请提交最新版本的发布链接。"
        : medicalPublicationIssue(latest, evidence.authorId);
    if (publishingIssue)
      return this.finalizeNonValid(latest, submissionId, evidence, {
        failureReason: publishingIssue,
        factScore: evaluation.factScore,
        imageScore: evaluation.imageScore,
        overallScore: evaluation.overallScore,
        status: "MANUAL_REVIEW",
        textScore: evaluation.textScore,
      });
    if (evaluation.decision === "VALID") {
      return this.finalizeValid(
        task,
        submissionId,
        evidence,
        configuration,
        actor,
        evaluation.textScore,
        evaluation.imageScore,
        evaluation.factScore,
        evaluation.overallScore,
      );
    }
    return this.finalizeNonValid(task, submissionId, evidence, {
      failureReason: evaluation.failureReason ?? "公开内容未通过验真策略",
      factScore: evaluation.factScore,
      imageScore: evaluation.imageScore,
      overallScore: evaluation.overallScore,
      status: evaluation.decision,
      textScore: evaluation.textScore,
    });
  }

  private async finalizeValid(
    task: VerificationTask,
    submissionId: string,
    evidence: PublicContentEvidence,
    configuration: PublicationVerificationConfiguration,
    actor: VerificationActor,
    textScore: number,
    imageScore: number | null,
    factScore: number | null,
    overallScore: number,
  ) {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const current = await transaction.publishSubmission.findUniqueOrThrow({
            where: { id: submissionId },
          });
          const latest = await transaction.distributionTask.findUniqueOrThrow({
            include: VERIFICATION_TASK_INCLUDE,
            where: { id: task.id },
          });
          const issue =
            latest.employeeContent.revision !== task.employeeContent.revision
              ? "验真期间内容已更新，请提交最新版本的发布链接。"
              : medicalPublicationIssue(latest, evidence.authorId);
          if (issue)
            return submissionResult(
              await transaction.publishSubmission.update({
                where: { id: current.id },
                data: {
                  status: "MANUAL_REVIEW",
                  failureReason: issue,
                  verificationFinishedAt: new Date(),
                },
              }),
            );
          const duplicate = await transaction.publishedContentRegistry.findUnique({
            select: { id: true },
            where: { canonicalKey: evidence.canonicalKey },
          });
          if (duplicate) throw new DuplicateCanonicalKeyError();
          const verifiedAt = new Date();
          await transaction.publishSubmission.update({
            data: {
              adapterModel: evidence.adapterModel,
              adapterProvider: evidence.provider,
              adapterReference: evidence.adapterReference,
              adapterRequestId: evidence.adapterRequestId,
              canonicalKey: evidence.canonicalKey,
              externalPublishedAt: evidence.externalPublishedAt
                ? new Date(evidence.externalPublishedAt)
                : null,
              extractedBody: evidence.body,
              extractedImageUrls: evidence.images.flatMap(({ url }) => (url ? [url] : [])),
              extractedTitle: evidence.title,
              failureReason: null,
              factMatchScore: factScore,
              imageSimilarityScore: imageScore,
              matchScore: overallScore,
              normalizedUrl: evidence.canonicalUrl,
              resolvedUrl: evidence.canonicalUrl,
              status: "VALID",
              textSimilarityScore: textScore,
              verificationFinishedAt: verifiedAt,
              verifiedAt,
            },
            where: { id: current.id },
          });
          const registry = await transaction.publishedContentRegistry.create({
            data: {
              campaignId: task.campaignId,
              canonicalKey: evidence.canonicalKey,
              contentFingerprint: task.employeeContent.contentFingerprint,
              normalizedUrl: evidence.canonicalUrl,
              submissionId,
              taskId: task.id,
              tenantId: task.tenantId,
              verifiedAt,
            },
          });
          await transaction.distributionTask.update({
            data: {
              status: current.lateCorrection ? "LATE_CORRECTED" : "COMPLETED",
              submittedAt: current.submittedAt,
              verifiedAt,
            },
            where: { id: task.id },
          });
          if (!current.lateCorrection) {
            await completeCampaignIfEligible(transaction, task.campaignId, task.tenantId);
          }
          await transaction.auditLog.create({
            data: {
              action: current.lateCorrection
                ? "publication.late-correction.valid"
                : "publication.verify.valid",
              actorType: actor.actorType,
              actorUserId: actor.actorUserId,
              enterpriseId: task.enterpriseId,
              metadata: {
                accountOwnershipChecked: Boolean(task.campaign.selectionSnapshot),
                ...(task.campaign.selectionSnapshot
                  ? { authorId: evidence.authorId, contentRevision: task.employeeContent.revision }
                  : {}),
                factScore,
                imageScore,
                policyVersion: configuration.policy.policyVersion,
                provider: evidence.provider,
                synthetic: current.synthetic,
                textScore,
              },
              reason: current.correctionReason,
              resourceId: registry.id,
              resourceType: "PublishedContentRegistry",
              tenantId: task.tenantId,
            },
          });
          return submissionResult(
            await transaction.publishSubmission.findUniqueOrThrow({ where: { id: submissionId } }),
          );
        },
        { isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof DuplicateCanonicalKeyError ||
        (error instanceof PrismaNamespace.PrismaClientKnownRequestError && error.code === "P2002")
      ) {
        return this.finalizeDuplicate(task, submissionId, evidence);
      }
      if (
        error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
        error.code === "P2034"
      ) {
        const claimed = await this.prisma.publishedContentRegistry.findUnique({
          select: { id: true },
          where: { canonicalKey: evidence.canonicalKey },
        });
        if (claimed) return this.finalizeDuplicate(task, submissionId, evidence);
      }
      throw error;
    }
  }

  private async finalizeDuplicate(
    task: VerificationTask,
    submissionId: string,
    evidence: PublicContentEvidence,
  ) {
    const now = new Date();
    const submission = await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.publishSubmission.update({
        data: {
          adapterModel: evidence.adapterModel,
          adapterProvider: evidence.provider,
          adapterReference: evidence.adapterReference,
          adapterRequestId: evidence.adapterRequestId,
          canonicalKey: evidence.canonicalKey,
          failureReason: "该公开内容已被其他员工任务有效使用",
          normalizedUrl: evidence.canonicalUrl,
          resolvedUrl: evidence.canonicalUrl,
          status: "DUPLICATE",
          verificationFinishedAt: now,
        },
        where: { id: submissionId },
      });
      await transaction.distributionTask.update({
        data: current.lateCorrection
          ? { status: "EXPIRED" }
          : now < task.expiresAt
            ? { status: "AVAILABLE" }
            : { expiredAt: task.expiredAt ?? now, status: "EXPIRED" },
        where: { id: task.id },
      });
      return current;
    });
    return submissionResult(submission);
  }

  private async finalizeNonValid(
    task: VerificationTask,
    submissionId: string,
    evidence: PublicContentEvidence,
    outcome: Readonly<{
      failureReason: string;
      factScore: number | null;
      imageScore: number | null;
      overallScore: number;
      status: "INVALID" | "MANUAL_REVIEW";
      textScore: number;
    }>,
  ) {
    const now = new Date();
    const submission = await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.publishSubmission.update({
        data: {
          adapterModel: evidence.adapterModel,
          adapterProvider: evidence.provider,
          adapterReference: evidence.adapterReference,
          adapterRequestId: evidence.adapterRequestId,
          canonicalKey: evidence.canonicalKey,
          externalPublishedAt: evidence.externalPublishedAt
            ? new Date(evidence.externalPublishedAt)
            : null,
          extractedBody: evidence.body,
          extractedImageUrls: evidence.images.flatMap(({ url }) => (url ? [url] : [])),
          extractedTitle: evidence.title,
          failureReason: outcome.failureReason,
          factMatchScore: outcome.factScore,
          imageSimilarityScore: outcome.imageScore,
          matchScore: outcome.overallScore,
          normalizedUrl: evidence.canonicalUrl,
          resolvedUrl: evidence.canonicalUrl,
          status: outcome.status,
          textSimilarityScore: outcome.textScore,
          verificationFinishedAt: now,
        },
        where: { id: submissionId },
      });
      await transaction.distributionTask.update({
        data: current.lateCorrection
          ? { status: "EXPIRED" }
          : outcome.status === "MANUAL_REVIEW"
            ? { status: "VERIFYING" }
            : now < task.expiresAt
              ? { status: "AVAILABLE" }
              : { expiredAt: task.expiredAt ?? now, status: "EXPIRED" },
        where: { id: task.id },
      });
      return current;
    });
    return submissionResult(submission);
  }

  private async finalizeUnavailable(
    task: VerificationTask,
    submissionId: string,
    normalized: NormalizedPublicationUrl,
    configuration: PublicationVerificationConfiguration,
    error: PublicationVerificationInvocationError,
  ) {
    const now = new Date();
    const submission = await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.publishSubmission.update({
        data: {
          failureReason: "公开内容暂时无法可靠获取，已保留提交时间并等待重试或人工确认",
          normalizedUrl: normalized.normalizedUrl,
          resolvedUrl: normalized.normalizedUrl,
          status: "UNAVAILABLE",
          verificationFinishedAt: now,
          verifier: `${configuration.adapter?.providerCode ?? "unconfigured"}-unavailable-v1`,
        },
        where: { id: submissionId },
      });
      if (!current.lateCorrection) {
        await transaction.distributionTask.update({
          data: { status: "VERIFYING" },
          where: { id: task.id },
        });
      }
      await transaction.auditLog.create({
        data: {
          action: "publication.verify.unavailable",
          actorType: "SYSTEM",
          enterpriseId: task.enterpriseId,
          metadata: {
            errorCode: error.code,
            policyVersion: configuration.policy.policyVersion,
            retryable: error.retryable,
          },
          resourceId: submissionId,
          resourceType: "PublishSubmission",
          tenantId: task.tenantId,
        },
      });
      return current;
    });
    return submissionResult(submission);
  }

  private async findEmployeeTask(taskId: string, membershipIds: readonly string[]) {
    const task = await this.prisma.distributionTask.findFirst({
      include: VERIFICATION_TASK_INCLUDE,
      where: { id: taskId, membershipId: { in: [...membershipIds] } },
    });
    if (!task) throw new NotFoundException("当前员工没有该任务");
    return task;
  }

  private requireEnterpriseScope(scope: EnterpriseScope) {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "ENTERPRISE" ||
      principal.scope.tenantId !== scope.tenantId ||
      principal.scope.enterpriseId !== scope.enterpriseId
    ) {
      throw new ForbiddenException("当前管理作用域与发布任务企业不一致");
    }
    return principal;
  }

  private assertDevelopmentFixtureEnabled(): void {
    if (process.env.NODE_ENV === "production" || process.env.ENABLE_DEV_AUTH !== "true") {
      throw new ForbiddenException("本机公开内容样本只允许在显式开发模式使用");
    }
  }

  private async assertMetricsSignature(
    timestamp: string | undefined,
    signature: string | undefined,
    input: IngestPublicationMetricsDto,
  ): Promise<void> {
    const key = (await this.settings.resolve("publication.metrics_ingest_key")).value;
    const status = publicationMetricsSignatureStatus({
      body: input,
      key,
      productionStrengthRequired: publicationMetricsProductionMode(),
      signature,
      timestamp,
    });
    if (status === "EXPIRED") throw new UnauthorizedException("公开指标回填请求已过期");
    if (status !== "VALID") throw new UnauthorizedException("公开指标回填签名无效");
  }
}

class DuplicateCanonicalKeyError extends Error {}

function assertEmployeeSubmissionAllowed(task: VerificationTask, now: Date): void {
  assertTaskPublishingCurrent(task, now);
  assertTaskFactsConfirmed(task, task.employeeContent.revision);
  if (now < task.visibleAt || task.status === "LOCKED") {
    throw new ForbiddenException("任务尚未到统一开放时间");
  }
  if (now >= task.expiresAt || task.status === "EXPIRED") {
    throw new ConflictException("任务已超过 24 小时提交期限并记为未按时完成");
  }
  if (["COMPLETED", "LATE_CORRECTED"].includes(task.status)) {
    throw new ConflictException("该任务已经形成有效发布记录");
  }
  if (task.status === "VERIFYING") {
    throw new ConflictException("链接正在验证或等待人工确认，无需重复提交");
  }
  if (task.status !== "AVAILABLE") {
    throw new ConflictException("当前任务无法提交发布链接，请返回任务列表查看最新状态。");
  }
}

function assertSupportedPublicationUrl(
  normalized: NormalizedPublicationUrl,
  lateCorrection: boolean,
): void {
  if (normalized.classification === "OTHER") {
    throw new ConflictException("只接受受支持的小红书公开链接或分享文本");
  }
  if (lateCorrection && normalized.classification === "DEV_FIXTURE") {
    throw new ConflictException("逾期纠错不能使用本机开发样本");
  }
}

async function completeCampaignIfEligible(
  transaction: Prisma.TransactionClient,
  campaignId: string,
  tenantId: string,
): Promise<void> {
  const [campaign, completedCount] = await Promise.all([
    transaction.campaign.findFirstOrThrow({
      select: { audienceCount: true, status: true },
      where: { id: campaignId, tenantId },
    }),
    transaction.distributionTask.count({
      where: { campaignId, status: "COMPLETED", tenantId },
    }),
  ]);
  if (completedCount === campaign.audienceCount && campaign.status !== "COMPLETED") {
    await transaction.campaign.update({ data: { status: "COMPLETED" }, where: { id: campaignId } });
  }
}

async function supersedeOpenSubmissions(
  transaction: Prisma.TransactionClient,
  taskId: string,
): Promise<void> {
  await transaction.publicationCollectionJob.updateMany({
    data: { status: "CANCELLED" },
    where: {
      kind: { in: ["VERIFY", "READBACK"] },
      status: { in: ["QUEUED", "LEASED", "NEEDS_REVIEW"] },
      submission: {
        taskId,
        status: { in: ["PENDING", "VERIFYING", "UNAVAILABLE", "MANUAL_REVIEW"] },
      },
    },
  });
  await transaction.publishSubmission.updateMany({
    data: {
      failureReason: "已由更新的提交或重试记录替代",
      status: "SUPERSEDED",
      verifier: "superseded-by-new-attempt-v2",
    },
    where: {
      status: { in: ["PENDING", "VERIFYING", "UNAVAILABLE", "MANUAL_REVIEW"] },
      taskId,
    },
  });
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fixtureResponse(fixture: {
  canonicalKey: string;
  normalizedUrl: string;
  synthetic: boolean;
}) {
  return {
    canonicalKey: fixture.canonicalKey,
    normalizedUrl: fixture.normalizedUrl,
    notice: "本链接仅用于本机开发验真，不代表真实小红书公开内容获取能力。",
    synthetic: fixture.synthetic,
  };
}

function submissionResult(submission: {
  canonicalKey: string;
  failureReason: string | null;
  matchScore: number | null;
  normalizedUrl: string;
  status: string;
  id: string;
  synthetic: boolean;
  verifiedAt: Date | null;
}) {
  return {
    canonicalKey: submission.canonicalKey,
    failureReason: submission.failureReason,
    matchScore: submission.matchScore,
    normalizedUrl: submission.normalizedUrl,
    status: submission.status,
    submissionId: submission.id,
    synthetic: submission.synthetic,
    verifiedAt: submission.verifiedAt,
  };
}

function publicationSubmissionView(submission: PublishSubmission) {
  return {
    canonicalKey: submission.canonicalKey,
    correctionReason: submission.correctionReason,
    extractedBody: submission.extractedBody,
    extractedImageUrls: submission.extractedImageUrls,
    extractedTitle: submission.extractedTitle,
    extractedUrl: submission.normalizedUrl,
    externalPublishedAt: submission.externalPublishedAt,
    factMatchScore: submission.factMatchScore,
    failureReason: submission.failureReason,
    id: submission.id,
    imageSimilarityScore: submission.imageSimilarityScore,
    lateCorrection: submission.lateCorrection,
    matchScore: submission.matchScore,
    normalizedUrl: submission.normalizedUrl,
    rawUrl: submission.normalizedUrl,
    resolvedUrl: submission.normalizedUrl,
    status: submission.status,
    submittedAt: submission.submittedAt,
    taskId: submission.taskId,
    tenantId: submission.tenantId,
    textSimilarityScore: submission.textSimilarityScore,
    verificationAttempt: submission.verificationAttempt,
    verificationFinishedAt: submission.verificationFinishedAt,
    verificationPolicyVersion: submission.verificationPolicyVersion,
    verificationStartedAt: submission.verificationStartedAt,
    verifiedAt: submission.verifiedAt,
  };
}
