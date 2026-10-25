import { createHash, randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type PublicationCollectionJob } from "@xhs-agentic/database";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { RequestAccessContext } from "../access/request-access-context";
import { medicalPublicationIssue } from "../campaign/medical-task-policy";
import { PrismaService } from "../database/prisma.service";
import { PlatformPublicationVerificationService } from "../platform-settings/platform-publication-verification.service";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import { CollectionEvidenceDto, type CollectionMetricValueDto } from "./publication-collector.dto";
import { extractPublicationAccessUrl, normalizePublicationUrl } from "./publication-url";
import { evaluatePublicationEvidence } from "./publication-verification-scoring";

const COLLECTOR_STATE_ID = "windows-browser";
const LEASE_MS = 15 * 60_000;
const METRICS_WINDOW_MS = 12 * 60 * 60_000;
const RISK = new Set([
  "CHALLENGE_REQUIRED",
  "RISK_BLOCKED",
  "LOGIN_REQUIRED",
  "RATE_LIMITED",
  "PARSER_CHANGED",
]);
type CollectionEvidenceJob = Prisma.PublicationCollectionJobGetPayload<{
  include: {
    submission: {
      include: {
        registry: true;
        task: {
          include: {
            campaign: { select: { selectionSnapshot: true } };
            membership: { select: { publisherContext: true } };
            employeeContent: { include: { images: true } };
          };
        };
      };
    };
  };
}>;

@Injectable()
export class PublicationCollectorService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(PlatformPublicationVerificationService)
    private readonly verifier: PlatformPublicationVerificationService,
    @Inject(TenantCapabilityService) private readonly capabilities: TenantCapabilityService,
    @Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader,
  ) {}

  async status() {
    if (process.env.NODE_ENV === "production") {
      return { paused: true, reason: "PUBLICATION_BROWSER_PRODUCTION_NOT_READY" };
    }
    const [state, mode] = await Promise.all([
      this.prisma.publicationCollectorState.findUnique({ where: { id: COLLECTOR_STATE_ID } }),
      this.settings.string("publication.mode"),
    ]);
    return {
      paused: Boolean(state?.pausedAt) || mode !== "BROWSER",
      reason: state?.pauseReason ?? (mode === "BROWSER" ? null : "BROWSER_MODE_DISABLED"),
    };
  }

  async claim() {
    if (process.env.NODE_ENV === "production") {
      return { job: null, paused: true, reason: "PUBLICATION_BROWSER_PRODUCTION_NOT_READY" };
    }
    const now = new Date();
    // Nonces older than the HMAC acceptance window have no authentication
    // value; retain seven days for incident analysis and bound table growth.
    await this.prisma.publicationCollectorRequestNonce.deleteMany({
      where: { receivedAt: { lt: new Date(now.getTime() - 7 * 24 * 60 * 60_000) } },
    });
    const state = await this.prisma.publicationCollectorState.upsert({
      create: { id: COLLECTOR_STATE_ID, lastSeenAt: now },
      update: { lastSeenAt: now },
      where: { id: COLLECTOR_STATE_ID },
    });
    if (state.pausedAt) return { job: null, paused: true, reason: state.pauseReason };
    if ((await this.settings.string("publication.mode")) !== "BROWSER") {
      return { job: null, paused: true, reason: "BROWSER_MODE_DISABLED" };
    }

    // Only a few due candidates are examined; the conditional UPDATE is the
    // claim linearization point even when multiple API replicas receive a poll.
    const candidates = await this.prisma.publicationCollectionJob.findMany({
      include: {
        submission: {
          select: {
            normalizedUrl: true,
            rawUrl: true,
            status: true,
            submittedAt: true,
            tenantId: true,
          },
        },
      },
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      take: 30,
      where: {
        dueAt: { lte: now },
        kind: { in: ["VERIFY", "METRICS"] },
        OR: [{ status: "QUEUED" }, { status: "LEASED", leaseExpiresAt: { lt: now } }],
      },
    });
    for (const candidate of candidates) {
      if (candidate.status === "LEASED") {
        // An expired lease might already have navigated to the note. Do not
        // mint a new token or spend a second visit on an uncertain attempt.
        await this.exhaust(candidate, now);
        continue;
      }
      if (
        (candidate.kind === "VERIFY" && candidate.submission.status !== "VERIFYING") ||
        (candidate.kind === "METRICS" && candidate.submission.status !== "VALID")
      ) {
        await this.prisma.publicationCollectionJob.updateMany({
          data: { status: "CANCELLED" },
          where: { id: candidate.id, status: candidate.status, leaseToken: candidate.leaseToken },
        });
        continue;
      }
      if (
        candidate.kind === "METRICS" &&
        !(await this.capabilities.current(candidate.submission.tenantId)).metricsIntegrationEnabled
      ) {
        await this.prisma.publicationCollectionJob.updateMany({
          data: {
            completedAt: now,
            errorCode: "TENANT_METRICS_INTEGRATION_DISABLED",
            status: "SKIPPED",
          },
          where: {
            id: candidate.id,
            leaseToken: candidate.leaseToken,
            status: candidate.status,
            ...(candidate.status === "LEASED" ? { leaseExpiresAt: { lt: now } } : {}),
          },
        });
        continue;
      }
      if (
        candidate.attempts >= 2 ||
        (candidate.kind === "METRICS" &&
          now.getTime() - candidate.dueAt.getTime() > METRICS_WINDOW_MS)
      ) {
        await this.exhaust(candidate, now);
        continue;
      }
      let accessUrl: string;
      try {
        accessUrl = extractPublicationAccessUrl(candidate.submission.rawUrl);
        if (!collectorAcceptsAccessUrl(accessUrl)) throw new Error("COLLECTOR_TARGET_FORBIDDEN");
      } catch {
        await this.quarantineIncompatibleTarget(candidate, now);
        continue;
      }
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
      const claimed = await this.prisma.publicationCollectionJob.updateMany({
        data: {
          attempts: { increment: 1 },
          heartbeatAt: now,
          leaseExpiresAt,
          leaseOwner: process.env.PUBLICATION_COLLECTOR_ID,
          leaseToken,
          status: "LEASED",
        },
        where: {
          id: candidate.id,
          leaseToken: candidate.leaseToken,
          status: candidate.status,
          ...(candidate.status === "LEASED" ? { leaseExpiresAt: { lt: now } } : {}),
        },
      });
      if (claimed.count !== 1) continue;
      const latestState = await this.status();
      if (latestState.paused) {
        // A risk signal raced this claim. No URL was exposed and no browser
        // visit started, so return the work item without spending an attempt.
        await this.prisma.publicationCollectionJob.updateMany({
          data: {
            attempts: { decrement: 1 },
            heartbeatAt: null,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            status: "QUEUED",
          },
          where: { id: candidate.id, leaseToken, status: "LEASED" },
        });
        return { job: null, paused: true, reason: latestState.reason };
      }
      return {
        paused: false,
        job: {
          id: candidate.id,
          kind: candidate.kind,
          accessUrl,
          submittedAt: candidate.submission.submittedAt.toISOString(),
          dueAt: candidate.dueAt.toISOString(),
          windowHours: candidate.windowHours,
          leaseToken,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
        },
      };
    }
    return { job: null, paused: false };
  }

  async heartbeat(jobId: string, leaseToken: string) {
    const now = new Date();
    const state = await this.status();
    if (state.paused) return { paused: true, leaseExpiresAt: null };
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const updated = await this.prisma.publicationCollectionJob.updateMany({
      data: { heartbeatAt: now, leaseExpiresAt },
      where: {
        id: jobId,
        leaseExpiresAt: { gt: now },
        leaseOwner: process.env.PUBLICATION_COLLECTOR_ID,
        leaseToken,
        status: "LEASED",
      },
    });
    if (updated.count !== 1) throw new ConflictException("采集工作单租约已失效");
    await this.prisma.publicationCollectorState.update({
      data: { lastSeenAt: now },
      where: { id: COLLECTOR_STATE_ID },
    });
    const finalState = await this.status();
    return { paused: finalState.paused, leaseExpiresAt: leaseExpiresAt.toISOString() };
  }

  async pause(reason: string) {
    const now = new Date();
    const state = await this.prisma.publicationCollectorState.upsert({
      create: { id: COLLECTOR_STATE_ID, pausedAt: now, pauseReason: reason, lastSeenAt: now },
      update: { pausedAt: now, pauseReason: reason, lastSeenAt: now },
      where: { id: COLLECTOR_STATE_ID },
    });
    await this.prisma.auditLog.create({
      data: {
        action: "publication.collector.paused",
        actorType: "INTEGRATION",
        metadata: { reason: state.pauseReason },
        resourceId: state.id,
        resourceType: "PublicationCollectorState",
      },
    });
    return { paused: true, reason: state.pauseReason };
  }

  async resume(reason: string) {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") {
      throw new ForbiddenException("恢复采集需要平台管理员人工处理");
    }
    const previous = await this.prisma.publicationCollectorState.findUnique({
      where: { id: COLLECTOR_STATE_ID },
    });
    if (!previous?.pausedAt) throw new ConflictException("采集器没有处于暂停状态");
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.publicationCollectorState.update({
        data: { pausedAt: null, pauseReason: null, resumedAt: now },
        where: { id: COLLECTOR_STATE_ID },
      }),
      this.prisma.auditLog.create({
        data: {
          action: "publication.collector.resumed",
          actorType: "USER",
          actorUserId: principal.userId,
          metadata: {
            pausedAt: previous.pausedAt.toISOString(),
            priorReason: previous.pauseReason,
          },
          reason,
          resourceId: COLLECTOR_STATE_ID,
          resourceType: "PublicationCollectorState",
        },
      }),
    ]);
    return { paused: false };
  }

  async evidence(jobId: string, input: CollectionEvidenceDto) {
    const now = new Date();
    const evidenceDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const job = await this.prisma.publicationCollectionJob.findUnique({
      include: {
        submission: {
          include: {
            registry: true,
            task: {
              include: {
                campaign: { select: { selectionSnapshot: true } },
                membership: { select: { publisherContext: true } },
                employeeContent: { include: { images: true } },
              },
            },
          },
        },
      },
      where: { id: jobId },
    });
    if (!job) throw new NotFoundException("采集工作单不存在");
    if (
      ["COMPLETED", "NEEDS_REVIEW", "SKIPPED"].includes(job.status) &&
      job.leaseToken === input.leaseToken
    ) {
      const stored = job.evidence;
      if (
        stored &&
        typeof stored === "object" &&
        !Array.isArray(stored) &&
        stored.evidencePayloadSha256 === evidenceDigest
      ) {
        return { status: job.status, alreadyAccepted: true };
      }
      throw new ConflictException("工作单已完成，冲突的证据版本被拒绝");
    }
    if (
      job.status !== "LEASED" ||
      job.leaseToken !== input.leaseToken ||
      job.leaseOwner !== process.env.PUBLICATION_COLLECTOR_ID ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= now
    ) {
      throw new ConflictException("采集工作单租约已失效，迟到证据被拒绝");
    }
    const observedAt = input.observedAt ? new Date(input.observedAt) : null;
    if (
      observedAt &&
      (observedAt.getTime() < job.createdAt.getTime() - 120_000 ||
        observedAt.getTime() > now.getTime() + 120_000)
    ) {
      throw new ConflictException("采集观察时间超出工作单有效范围");
    }
    const normalized = input.canonicalUrl ? normalizePublicationUrl(input.canonicalUrl) : null;
    const matched =
      normalized?.classification === "XHS_NOTE" &&
      (job.kind === "VERIFY"
        ? job.submission.canonicalKey.startsWith("xhs:short:") ||
          normalized.canonicalKey === job.submission.canonicalKey
        : normalized.canonicalKey === job.submission.registry?.canonicalKey);
    const isRisk = RISK.has(input.status);
    const configuration = job.kind === "VERIFY" ? await this.verifier.current() : null;

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const claimed = await tx.publicationCollectionJob.updateMany({
            data: { status: "COMPLETED" },
            where: {
              id: jobId,
              leaseExpiresAt: { gt: new Date() },
              leaseOwner: process.env.PUBLICATION_COLLECTOR_ID,
              leaseToken: input.leaseToken,
              status: "LEASED",
            },
          });
          if (claimed.count !== 1) throw new ConflictException("采集工作单租约已失效");
          if (isRisk) {
            await tx.publicationCollectorState.upsert({
              create: { id: COLLECTOR_STATE_ID, pausedAt: now, pauseReason: input.status },
              update: { pausedAt: now, pauseReason: input.status },
              where: { id: COLLECTOR_STATE_ID },
            });
          }
          const metricsEnabled = (await this.capabilities.current(job.submission.tenantId, tx))
            .metricsIntegrationEnabled;
          const {
            leaseToken: _secret,
            metrics: _metrics,
            metricsRaw: _metricsRaw,
            ...safePayload
          } = input;
          const safeEvidence = {
            ...safePayload,
            evidencePayloadSha256: evidenceDigest,
            ...(metricsEnabled ? { metrics: input.metrics, metricsRaw: input.metricsRaw } : {}),
            canonicalUrl:
              normalized?.classification === "XHS_NOTE" ? normalized.normalizedUrl : null,
            // URL query strings may include temporary media credentials.
            images: input.images?.map((image) => ({
              checksum: image.checksum ?? null,
              perceptualHash: image.perceptualHash ?? null,
            })),
          };
          const terminal = {
            evidence: safeEvidence as unknown as Prisma.InputJsonValue,
            observedAt,
          };
          let status = "COMPLETED";
          if (job.kind === "VERIFY") {
            status = await this.completeVerification(
              tx,
              job,
              input,
              normalized,
              matched,
              configuration,
              now,
              observedAt,
            );
          } else {
            status = await this.completeMetrics(tx, job, input, matched, observedAt, now);
          }
          await tx.publicationCollectionJob.update({
            data: {
              ...terminal,
              status,
              completedAt: status === "QUEUED" ? null : now,
              errorCode: status === "COMPLETED" ? null : input.status,
            },
            where: { id: job.id },
          });
          await tx.auditLog.create({
            data: {
              action: "publication.collector.evidence",
              actorType: "INTEGRATION",
              enterpriseId: job.submission.task.enterpriseId,
              metadata: {
                collectorStatus: input.status,
                jobKind: job.kind,
                result: status,
                windowHours: job.windowHours,
              },
              resourceId: job.id,
              resourceType: "PublicationCollectionJob",
              tenantId: job.submission.tenantId,
            },
          });
          return { status, paused: isRisk };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2002" || error.code === "P2034")
      ) {
        if (job.kind === "VERIFY" && normalized?.classification === "XHS_NOTE") {
          const winner = await this.prisma.publishedContentRegistry.findUnique({
            select: { submissionId: true },
            where: { canonicalKey: normalized.canonicalKey },
          });
          if (winner && winner.submissionId !== job.submissionId) {
            return this.finishDuplicateAfterRace(job, input, normalized, observedAt);
          }
        }
        throw new ConflictException("验真写入发生并发冲突，当前提交保留等待重试");
      }
      throw error;
    }
  }

  private async finishDuplicateAfterRace(
    job: CollectionEvidenceJob,
    input: CollectionEvidenceDto,
    normalized: ReturnType<typeof normalizePublicationUrl>,
    observedAt: Date | null,
  ) {
    const now = new Date();
    return this.prisma.$transaction(
      async (tx) => {
        const leased = await tx.publicationCollectionJob.updateMany({
          data: {
            completedAt: now,
            errorCode: "DUPLICATE_CANONICAL_KEY",
            evidence: {
              status: input.status,
              canonicalUrl: normalized.normalizedUrl,
              observedAt: input.observedAt ?? null,
              evidencePayloadSha256: createHash("sha256")
                .update(JSON.stringify(input))
                .digest("hex"),
            },
            observedAt,
            status: "COMPLETED",
          },
          where: {
            id: job.id,
            leaseExpiresAt: { gt: now },
            leaseOwner: process.env.PUBLICATION_COLLECTOR_ID,
            leaseToken: input.leaseToken,
            status: "LEASED",
          },
        });
        if (leased.count !== 1) throw new ConflictException("采集工作单租约已失效");
        const submission = await tx.publishSubmission.findUniqueOrThrow({
          where: { id: job.submissionId },
        });
        if (submission.status !== "VERIFYING") throw new ConflictException("验真尝试已被替代");
        const latestTask = await tx.distributionTask.findUniqueOrThrow({
          select: { status: true },
          where: { id: submission.taskId },
        });
        if (latestTask.status !== (submission.lateCorrection ? "EXPIRED" : "VERIFYING")) {
          await tx.publicationCollectionJob.update({
            data: { status: "CANCELLED" },
            where: { id: job.id },
          });
          await tx.publishSubmission.update({
            data: {
              failureReason: "该任务已由另一有效提交完成",
              status: "SUPERSEDED",
              verificationFinishedAt: now,
            },
            where: { id: submission.id },
          });
          return { status: "CANCELLED", paused: false };
        }
        await tx.publishSubmission.update({
          data: {
            adapterProvider: "WINDOWS_BROWSER",
            adapterRequestId: job.id,
            canonicalKey: normalized.canonicalKey,
            failureReason: "该公开内容已被其他员工任务有效使用",
            normalizedUrl: normalized.normalizedUrl,
            resolvedUrl: normalized.normalizedUrl,
            status: "DUPLICATE",
            verificationFinishedAt: now,
          },
          where: { id: submission.id },
        });
        const expired = submission.lateCorrection || now >= job.submission.task.expiresAt;
        await tx.distributionTask.update({
          data: expired
            ? { expiredAt: job.submission.task.expiredAt ?? now, status: "EXPIRED" }
            : { status: "AVAILABLE" },
          where: { id: submission.taskId },
        });
        await tx.auditLog.create({
          data: {
            action: "publication.collector.duplicate-race",
            actorType: "INTEGRATION",
            enterpriseId: job.submission.task.enterpriseId,
            resourceId: job.id,
            resourceType: "PublicationCollectionJob",
            tenantId: submission.tenantId,
          },
        });
        return { status: "COMPLETED", paused: false };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async completeVerification(
    tx: Prisma.TransactionClient,
    job: CollectionEvidenceJob,
    input: CollectionEvidenceDto,
    normalized: ReturnType<typeof normalizePublicationUrl> | null,
    matched: boolean,
    configuration: Awaited<ReturnType<PlatformPublicationVerificationService["current"]>> | null,
    now: Date,
    observedAt: Date | null,
  ): Promise<string> {
    const submission = await tx.publishSubmission.findUniqueOrThrow({
      where: { id: job.submissionId },
    });
    if (submission.status !== "VERIFYING") return "CANCELLED";
    const taskState = await tx.distributionTask.findUniqueOrThrow({
      select: { status: true },
      where: { id: submission.taskId },
    });
    if (taskState.status !== (submission.lateCorrection ? "EXPIRED" : "VERIFYING")) {
      await tx.publishSubmission.update({
        data: {
          failureReason: "任务已由其他有效验真尝试完成，此次迟到证据不再参与判定",
          status: "SUPERSEDED",
          verificationFinishedAt: now,
        },
        where: { id: submission.id },
      });
      return "CANCELLED";
    }
    const fullContent =
      input.status === "AVAILABLE" &&
      matched &&
      observedAt &&
      input.title?.trim() &&
      input.body?.trim() &&
      input.images?.some((image) => image.checksum || image.perceptualHash);
    if (
      !fullContent ||
      !normalized ||
      !configuration ||
      configuration.mode !== "BROWSER" ||
      !configuration.policy.requireImageMatch ||
      submission.verificationPolicyVersion !== configuration.policy.policyVersion ||
      !observedAt
    ) {
      const manual =
        input.status === "PARTIAL" ||
        input.status === "WRONG_TARGET" ||
        input.status === "PARSER_CHANGED" ||
        input.status === "AVAILABLE";
      await tx.publishSubmission.update({
        data: {
          failureReason: manual
            ? "浏览器读取的图文证据不完整或目标身份不一致，等待人工复核"
            : "公开内容暂时无法可靠获取，已保留提交时间并等待人工确认",
          status: manual ? "MANUAL_REVIEW" : "UNAVAILABLE",
          verificationFinishedAt: now,
        },
        where: { id: submission.id },
      });
      return "NEEDS_REVIEW";
    }
    const evidence = {
      title: input.title ?? "",
      body: input.body ?? "",
      hashtags: input.hashtags ?? [],
      images: (input.images ?? []).map((image) => ({
        checksum: image.checksum ?? null,
        perceptualHash: image.perceptualHash ?? null,
        url: null,
      })),
    };
    const scored = evaluatePublicationEvidence({
      actual: evidence,
      expected: job.submission.task.employeeContent,
      policy: configuration.policy,
    });
    const duplicate = await tx.publishedContentRegistry.findUnique({
      select: { id: true },
      where: { canonicalKey: normalized.canonicalKey },
    });
    const publishingIssue = medicalPublicationIssue(job.submission.task);
    const decision = duplicate ? "DUPLICATE" : publishingIssue ? "MANUAL_REVIEW" : scored.decision;
    const verdictAt = new Date();
    await tx.publishSubmission.update({
      data: {
        adapterProvider: "WINDOWS_BROWSER",
        adapterModel: input.parserVersion ?? "browser-dom-v1",
        adapterReference: input.screenshotSha256 ?? null,
        adapterRequestId: job.id,
        canonicalKey: normalized.canonicalKey,
        externalPublishedAt: input.externalPublishedAt ? new Date(input.externalPublishedAt) : null,
        extractedTitle: evidence.title,
        extractedBody: evidence.body,
        // Do not persist temporary signed media URLs from the collector.
        extractedImageUrls: [],
        normalizedUrl: normalized.normalizedUrl,
        resolvedUrl: normalized.normalizedUrl,
        matchScore: scored.overallScore,
        textSimilarityScore: scored.textScore,
        imageSimilarityScore: scored.imageScore,
        factMatchScore: scored.factScore,
        failureReason: duplicate
          ? "该公开内容已被其他员工任务有效使用"
          : (publishingIssue ?? scored.failureReason),
        status: decision,
        verificationFinishedAt: verdictAt,
        verifiedAt: decision === "VALID" ? verdictAt : null,
      },
      where: { id: submission.id },
    });
    if (decision === "VALID") {
      const registry = await tx.publishedContentRegistry.create({
        data: {
          campaignId: job.submission.task.campaignId,
          canonicalKey: normalized.canonicalKey,
          contentFingerprint: job.submission.task.employeeContent.contentFingerprint,
          normalizedUrl: normalized.normalizedUrl,
          submissionId: submission.id,
          taskId: submission.taskId,
          tenantId: submission.tenantId,
          verifiedAt: verdictAt,
        },
      });
      await tx.distributionTask.update({
        data: {
          status: submission.lateCorrection ? "LATE_CORRECTED" : "COMPLETED",
          submittedAt: submission.submittedAt,
          verifiedAt: verdictAt,
        },
        where: { id: submission.taskId },
      });
      if (!submission.lateCorrection) {
        const [campaign, completed] = await Promise.all([
          tx.campaign.findUniqueOrThrow({ where: { id: job.submission.task.campaignId } }),
          tx.distributionTask.count({
            where: { campaignId: job.submission.task.campaignId, status: "COMPLETED" },
          }),
        ]);
        if (completed === campaign.audienceCount && campaign.status !== "COMPLETED") {
          await tx.campaign.update({
            data: { status: "COMPLETED" },
            where: { id: campaign.id },
          });
        }
      }
      if ((await this.capabilities.current(submission.tenantId, tx)).metricsIntegrationEnabled) {
        // The browser observed metrics before the registry was written. Preserve
        // its observation time; only entitled tenants obtain metric work items.
        await this.writeMetrics(tx, registry, input, observedAt, 0);
        const baseline =
          input.externalPublishedAt && new Date(input.externalPublishedAt) <= observedAt
            ? new Date(input.externalPublishedAt)
            : observedAt;
        for (const windowHours of [24, 72]) {
          await tx.publicationCollectionJob.create({
            data: {
              dueAt: new Date(baseline.getTime() + windowHours * 60 * 60_000),
              kind: "METRICS",
              submissionId: submission.id,
              windowHours,
            },
          });
        }
      }
    } else if (decision !== "MANUAL_REVIEW") {
      const expired = submission.lateCorrection || now >= job.submission.task.expiresAt;
      await tx.distributionTask.update({
        data: expired
          ? { expiredAt: job.submission.task.expiredAt ?? now, status: "EXPIRED" }
          : { status: "AVAILABLE" },
        where: { id: submission.taskId },
      });
    }
    return decision === "MANUAL_REVIEW" ? "NEEDS_REVIEW" : "COMPLETED";
  }

  private async completeMetrics(
    tx: Prisma.TransactionClient,
    job: CollectionEvidenceJob,
    input: CollectionEvidenceDto,
    matched: boolean,
    observedAt: Date | null,
    now: Date,
  ): Promise<string> {
    if (
      !job.submission.registry ||
      !matched ||
      !observedAt ||
      !["AVAILABLE", "PARTIAL"].includes(input.status) ||
      now.getTime() - job.dueAt.getTime() > METRICS_WINDOW_MS
    ) {
      return "NEEDS_REVIEW";
    }
    if (!(await this.capabilities.current(job.submission.tenantId, tx)).metricsIntegrationEnabled) {
      return "SKIPPED";
    }
    if ((await this.settings.string("publication.mode")) !== "BROWSER") return "SKIPPED";
    const saved = await this.writeMetrics(
      tx,
      job.submission.registry,
      input,
      observedAt,
      job.windowHours,
    );
    return saved ? "COMPLETED" : "NEEDS_REVIEW";
  }

  private async writeMetrics(
    tx: Prisma.TransactionClient,
    registry: { id: string; campaignId: string; tenantId: string },
    input: CollectionEvidenceDto,
    observedAt: Date,
    windowHours: number,
  ): Promise<boolean> {
    const likes = preciseMetric("likes", input);
    const comments = preciseMetric("comments", input);
    const favorites = preciseMetric("favorites", input);
    const raw = input.metricsRaw;
    const displayed = ["likes", "comments", "favorites"].some(
      (key) => raw?.[key as "likes" | "comments" | "favorites"]?.precision === "APPROXIMATE",
    );
    if (likes === null && comments === null && favorites === null && !displayed) return false;
    await tx.publishMetricSnapshot.create({
      data: {
        registryId: registry.id,
        campaignId: registry.campaignId,
        tenantId: registry.tenantId,
        observedAt,
        windowHours,
        source: "WINDOWS_BROWSER",
        likes,
        comments,
        favorites,
        views: null,
        shares: null,
        rawData: {
          metricPrecision: {
            likes: raw?.likes?.precision ?? "UNAVAILABLE",
            comments: raw?.comments?.precision ?? "UNAVAILABLE",
            favorites: raw?.favorites?.precision ?? "UNAVAILABLE",
          },
          metricDisplay: {
            ...(raw?.likes?.precision === "APPROXIMATE" && raw.likes.raw
              ? { likes: raw.likes.raw }
              : {}),
            ...(raw?.comments?.precision === "APPROXIMATE" && raw.comments.raw
              ? { comments: raw.comments.raw }
              : {}),
            ...(raw?.favorites?.precision === "APPROXIMATE" && raw.favorites.raw
              ? { favorites: raw.favorites.raw }
              : {}),
          },
        },
      },
    });
    return true;
  }

  /** Admin-approved browser submissions keep the original observation and
   * receive the same entitlement-gated windows as automatically verified notes. */
  async scheduleMetricsAfterManualApproval(
    tx: Prisma.TransactionClient,
    submission: {
      id: string;
      tenantId: string;
      submittedAt: Date;
      externalPublishedAt: Date | null;
    },
    registry: { id: string; campaignId: string; tenantId: string },
    approvedAt: Date,
  ): Promise<void> {
    if (!(await this.capabilities.current(submission.tenantId, tx)).metricsIntegrationEnabled) {
      return;
    }
    const original = await tx.publicationCollectionJob.findUnique({
      where: {
        submissionId_kind_windowHours: {
          submissionId: submission.id,
          kind: "VERIFY",
          windowHours: 0,
        },
      },
    });
    const source = original?.evidence;
    const sourcePayload =
      source && typeof source === "object" && !Array.isArray(source)
        ? Object.fromEntries(
            Object.entries(source).filter(([key]) => key !== "evidencePayloadSha256"),
          )
        : null;
    const observation = sourcePayload
      ? plainToInstance(CollectionEvidenceDto, {
          ...sourcePayload,
          leaseToken: randomUUID(),
        })
      : null;
    const observedAt =
      original?.observedAt &&
      original.observedAt >= submission.submittedAt &&
      original.observedAt <= approvedAt
        ? original.observedAt
        : null;
    if (
      observation &&
      observedAt &&
      ["AVAILABLE", "PARTIAL"].includes(observation.status) &&
      validateSync(observation, { whitelist: true, forbidNonWhitelisted: true }).length === 0
    ) {
      await this.writeMetrics(tx, registry, observation, observedAt, 0);
    }
    const baseline =
      submission.externalPublishedAt && submission.externalPublishedAt <= (observedAt ?? approvedAt)
        ? submission.externalPublishedAt
        : (observedAt ?? approvedAt);
    for (const windowHours of [24, 72]) {
      await tx.publicationCollectionJob.create({
        data: {
          dueAt: new Date(baseline.getTime() + windowHours * 60 * 60_000),
          kind: "METRICS",
          submissionId: submission.id,
          windowHours,
        },
      });
    }
  }

  private async exhaust(job: PublicationCollectionJob, now: Date) {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.publicationCollectionJob.updateMany({
        data: {
          status: job.kind === "METRICS" ? "SKIPPED" : "NEEDS_REVIEW",
          completedAt: now,
          errorCode: "LEASE_EXPIRED_OR_WINDOW_MISSED",
        },
        where: {
          id: job.id,
          leaseToken: job.leaseToken,
          status: job.status,
          ...(job.status === "LEASED" ? { leaseExpiresAt: { lt: now } } : {}),
        },
      });
      if (updated.count !== 1 || job.kind !== "VERIFY") return;
      await tx.publishSubmission.updateMany({
        data: {
          failureReason: "采集端未在租约期限内返回可靠证据，提交时间已保留，等待人工确认",
          status: "UNAVAILABLE",
          verificationFinishedAt: now,
        },
        where: { id: job.submissionId, status: "VERIFYING" },
      });
    });
  }

  private async quarantineIncompatibleTarget(job: PublicationCollectionJob, now: Date) {
    await this.prisma.$transaction(async (tx) => {
      const skipped = await tx.publicationCollectionJob.updateMany({
        data: {
          completedAt: now,
          errorCode: "COLLECTOR_TARGET_FORBIDDEN",
          status: job.kind === "VERIFY" ? "NEEDS_REVIEW" : "SKIPPED",
        },
        where: {
          id: job.id,
          leaseToken: job.leaseToken,
          status: job.status,
        },
      });
      if (skipped.count !== 1) return;
      if (job.kind === "VERIFY") {
        await tx.publishSubmission.updateMany({
          data: {
            failureReason: "分享链接格式无法安全交给采集浏览器，按时提交事实已保留，请人工复核",
            status: "UNAVAILABLE",
            verificationFinishedAt: now,
          },
          where: { id: job.submissionId, status: "VERIFYING" },
        });
      }
      await tx.auditLog.create({
        data: {
          action: "publication.collector.target-quarantined",
          actorType: "SYSTEM",
          metadata: { jobKind: job.kind },
          resourceId: job.id,
          resourceType: "PublicationCollectionJob",
        },
      });
    });
  }
}

function collectorAcceptsAccessUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.hostname.endsWith(".") ||
      [...raw].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      return false;
    return extractPublicationAccessUrl(raw) === raw;
  } catch {
    return false;
  }
}

function preciseMetric(
  key: "likes" | "comments" | "favorites",
  input: CollectionEvidenceDto,
): number | null {
  const raw: CollectionMetricValueDto | undefined = input.metricsRaw?.[key];
  const exact: number | undefined = input.metrics?.[key];
  if (raw?.precision === "EXACT") {
    if (
      exact === undefined ||
      raw.value !== exact ||
      (raw.raw &&
        (!/^\d{1,9}(?:[,，]\d{3}){0,2}$/u.test(raw.raw) ||
          Number(raw.raw.replace(/[,，]/gu, "")) !== exact))
    ) {
      throw new ConflictException(`浏览器 ${key} 指标精确值与原始值不一致`);
    }
    return exact;
  }
  if (exact !== undefined) {
    throw new ConflictException(`浏览器 ${key} 指标没有精确证据`);
  }
  if (raw?.precision === "APPROXIMATE" && !raw.raw) {
    throw new ConflictException(`浏览器 ${key} 近似指标没有安全展示值`);
  }
  if (raw?.precision === "APPROXIMATE" && raw.value != null) {
    throw new ConflictException(`浏览器 ${key} 近似指标不能填充精确数值`);
  }
  if (raw?.precision === "UNAVAILABLE" && (raw.value != null || raw.raw != null)) {
    throw new ConflictException(`浏览器 ${key} 未获取的指标不得补值`);
  }
  return null;
}
