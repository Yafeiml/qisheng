import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { medicalPublicationIssue } from "../campaign/medical-task-policy";
import { PrismaService } from "../database/prisma.service";
import { PublicationReadbackConfigurationService } from "../platform-settings/publication-readback.configuration";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import type { ReadbackResultDto } from "./publication-readback.dto";
import { MANAGED_READBACK_NODE_ID, managedReadbackNodeKey } from "./publication-readback-node-key";
import { readbackPanelUrl } from "./publication-readback-panel-url";
import { READBACK_POLICY_VERSION, READBACK_SCORING_POLICY } from "./publication-readback-policy";
import { PublicationShortUrlError, resolvePublicationShortUrl } from "./publication-short-url";
import { normalizePublicationUrl } from "./publication-url";
import { evaluatePublicationEvidence } from "./publication-verification-scoring";

const STATE_ID = "distributed-readback";
const LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;

@Injectable()
export class PublicationReadbackService {
  private lastNonceCleanup = 0;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(TenantCapabilityService) private readonly capabilities: TenantCapabilityService,
    @Inject(PublicationReadbackConfigurationService)
    private readonly configuration: PublicationReadbackConfigurationService,
  ) {}

  async status() {
    const [state, configuration] = await Promise.all([
      this.prisma.publicationCollectorState.findUnique({ where: { id: STATE_ID } }),
      this.configuration.runtime(),
    ]);
    const configurationReady = configuration.externalMode || configuration.verified;
    return {
      paused: !configuration.enabled || !configurationReady || Boolean(state?.pausedAt),
      reason: !configuration.enabled
        ? "READBACK_DISABLED"
        : !configurationReady
          ? "READBACK_CONFIGURATION_NOT_VERIFIED"
          : (state?.pauseReason ?? null),
    };
  }

  private async dailyLimit() {
    const state = await this.prisma.publicationCollectorState.findUnique({
      where: { id: STATE_ID },
      select: { dailyLimit: true },
    });
    return state?.dailyLimit ?? positiveEnv("PUBLICATION_READBACK_DAILY_LIMIT", 1000);
  }

  async health() {
    const now = new Date();
    const [state, overdueJobs, dueRecent, completedRecent] = await Promise.all([
      this.status(),
      this.prisma.publicationCollectionJob.count({
        where: {
          kind: "READBACK",
          status: "QUEUED",
          dueAt: { lt: new Date(now.getTime() - 60 * 60_000) },
        },
      }),
      this.prisma.publicationCollectionJob.count({
        where: {
          kind: "READBACK",
          dueAt: { gte: new Date(now.getTime() - 2 * 60 * 60_000), lte: now },
        },
      }),
      this.prisma.publicationCollectionJob.count({
        where: {
          kind: "READBACK",
          status: "COMPLETED",
          completedAt: { gte: new Date(now.getTime() - 2 * 60 * 60_000) },
        },
      }),
    ]);
    return {
      ...state,
      overdueJobs,
      dueRecent,
      completedRecent,
      alert:
        state.reason === "READBACK_DISABLED"
          ? null
          : state.paused
            ? "READBACK_PAUSED"
            : overdueJobs >= 20
              ? "READBACK_BACKLOG"
              : dueRecent >= 20 && completedRecent === 0
                ? "READBACK_NO_COMPLETIONS"
                : null,
    };
  }

  // Collector control panels need operational metadata, never employee URLs,
  // tenant names, note IDs or supplier response bodies.
  async operations() {
    const now = new Date();
    const [state, budget, grouped, retrying, jobs, dailyLimit] = await Promise.all([
      this.status(),
      this.prisma.publicationReadbackBudget.findMany({
        orderBy: { day: "desc" },
        select: { day: true, used: true },
        take: 14,
      }),
      this.prisma.publicationCollectionJob.groupBy({
        by: ["status"],
        _count: { _all: true },
        where: { kind: "READBACK" },
      }),
      this.prisma.publicationCollectionJob.count({
        where: { kind: "READBACK", status: "QUEUED", attempts: { gt: 0 } },
      }),
      this.prisma.publicationCollectionJob.findMany({
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          status: true,
          attempts: true,
          createdAt: true,
          dueAt: true,
          updatedAt: true,
          completedAt: true,
          errorCode: true,
          leaseOwner: true,
        },
        take: 50,
        where: { kind: "READBACK" },
      }),
      this.dailyLimit(),
    ]);
    const count = (status: string) =>
      grouped.find((entry) => entry.status === status)?._count._all ?? 0;
    return {
      ...state,
      today: now.toISOString().slice(0, 10),
      dailyLimit,
      total: grouped.reduce((sum, row) => sum + row._count._all, 0),
      queued: count("QUEUED"),
      retrying,
      leased: count("LEASED"),
      completed: count("COMPLETED"),
      needsReview: count("NEEDS_REVIEW"),
      budget,
      jobs: jobs.map((job) => ({
        ...job,
        createdAt: job.createdAt.toISOString(),
        dueAt: job.dueAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        completedAt: job.completedAt?.toISOString() ?? null,
      })),
    };
  }

  async adminOperations() {
    const [operations, nodes] = await Promise.all([
      this.operations(),
      this.prisma.publicationReadbackNode.findMany({
        select: { id: true, lastSeenAt: true, panelHost: true, panelUrl: true },
      }),
    ]);
    let configured: string[] = [];
    try {
      const parsed: unknown = JSON.parse(process.env.PUBLICATION_READBACK_NODE_KEYS_JSON ?? "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        configured = Object.keys(parsed).filter(
          (id) => id !== MANAGED_READBACK_NODE_ID && /^[A-Za-z0-9_.-]{3,80}$/u.test(id),
        );
    } catch {
      // Malformed config cannot make a node appear healthy.
    }
    const cutoff = Date.now() - 90_000;
    if (managedReadbackNodeKey()) configured.push(MANAGED_READBACK_NODE_ID);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const visible = [...new Set(configured)].sort().map((id) => {
      const node = byId.get(id);
      const panelUrl = readbackPanelUrl(node?.panelUrl);
      const legacyHost = node?.panelHost && isIP(node.panelHost) === 4 ? node.panelHost : null;
      return {
        id,
        online: Boolean(node && node.lastSeenAt.getTime() >= cutoff),
        lastSeenAt: node?.lastSeenAt.toISOString() ?? null,
        panelHost: panelUrl?.hostname ?? legacyHost,
        panelUrl: panelUrl?.href ?? (legacyHost ? `http://${legacyHost}:13110/` : null),
      };
    });
    return {
      ...operations,
      nodes: visible,
      onlineNodes: visible.filter((node) => node.online).length,
    };
  }

  async claimManaged(nodeId: string) {
    if (nodeId !== MANAGED_READBACK_NODE_ID || !managedReadbackNodeKey())
      throw new ForbiddenException("只有已配置的同机回读节点可以领取托管任务");
    const configuration = await this.configuration.runtime();
    if (!configuration.enabled || !configuration.verified || !configuration.token) {
      if (!configuration.enabled) await this.configuration.recoverExpiredLeases();
      return {
        paused: true,
        reason: configuration.enabled ? "READBACK_CONFIGURATION_NOT_VERIFIED" : "READBACK_DISABLED",
        job: null,
        provider: null,
      };
    }
    const result = await this.claim(nodeId);
    return {
      ...result,
      provider: result.job
        ? { endpoint: configuration.endpoint, token: configuration.token }
        : null,
    };
  }

  async claim(nodeId: string) {
    const health = await this.status();
    if (health.paused) {
      if (health.reason === "READBACK_DISABLED") await this.configuration.recoverExpiredLeases();
      return { ...health, job: null };
    }
    const now = new Date();
    if (now.getTime() - this.lastNonceCleanup >= 60 * 60_000) {
      this.lastNonceCleanup = now.getTime();
      await this.prisma.publicationCollectorRequestNonce.deleteMany({
        where: { receivedAt: { lt: new Date(now.getTime() - 7 * 24 * 60 * 60_000) } },
      });
    }
    const active = await this.prisma.publicationCollectionJob.count({
      where: { kind: "READBACK", status: "LEASED", leaseExpiresAt: { gt: now } },
    });
    const maxDaily = await this.dailyLimit();
    if (active >= positiveEnv("PUBLICATION_READBACK_MAX_ACTIVE", 2))
      return { paused: false, reason: "CONCURRENCY_LIMIT", job: null };
    const day = now.toISOString().slice(0, 10);
    const budget = await this.prisma.publicationReadbackBudget.findUnique({ where: { day } });
    if (budget && budget.used >= maxDaily)
      return { paused: false, reason: "DAILY_LIMIT", job: null };
    const candidates = await this.prisma.publicationCollectionJob.findMany({
      include: {
        submission: {
          select: { canonicalKey: true, normalizedUrl: true, rawUrl: true, status: true },
        },
      },
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      take: 30,
      where: {
        kind: "READBACK",
        dueAt: { lte: now },
        OR: [{ status: "QUEUED" }, { status: "LEASED", leaseExpiresAt: { lt: now } }],
      },
    });
    let shortUrlAttempted = false;
    for (const candidate of candidates) {
      if (candidate.status === "LEASED") {
        // An API call may have been billed before its lease expired. Do not
        // automatically issue another paid request after an ambiguous result.
        await this.reviewCandidate(
          candidate.id,
          "LEASE_OUTCOME_UNKNOWN",
          now,
          "UNAVAILABLE",
          "LEASED",
        );
        continue;
      }
      if (candidate.submission.status !== "VERIFYING") {
        await this.prisma.publicationCollectionJob.updateMany({
          data: { status: "CANCELLED", completedAt: now },
          where: { id: candidate.id, kind: "READBACK", status: "QUEUED" },
        });
        continue;
      }
      let target: ReturnType<typeof normalizePublicationUrl>;
      try {
        target = normalizePublicationUrl(candidate.submission.normalizedUrl);
      } catch {
        await this.reviewCandidate(candidate.id, "TARGET_INVALID", now, "MANUAL_REVIEW", "QUEUED");
        continue;
      }
      if (target.classification === "XHS_SHORT") {
        if (shortUrlAttempted) break;
        shortUrlAttempted = true;
        try {
          target = await resolvePublicationShortUrl(candidate.submission.rawUrl);
        } catch (error) {
          await this.reviewCandidate(
            candidate.id,
            error instanceof PublicationShortUrlError ? error.code : "SHORT_URL_UNAVAILABLE",
            now,
            "MANUAL_REVIEW",
            "QUEUED",
          );
          continue;
        }
      }
      if (target.classification !== "XHS_NOTE") {
        await this.reviewCandidate(
          candidate.id,
          "NOTE_ID_REQUIRED",
          now,
          "MANUAL_REVIEW",
          "QUEUED",
        );
        continue;
      }
      const noteId = new URL(target.normalizedUrl).pathname.split("/").at(-1);
      if (!noteId) continue;
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
      const claimed = await this.prisma.$transaction(async (tx) => {
        // Serialize just the short reservation transaction across API replicas.
        // A pre-check alone permits every node to see the same free slot.
        await tx.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(7100910101::bigint)`;
        if (target.normalizedUrl !== candidate.submission.normalizedUrl) {
          const identityUpdated = await tx.publishSubmission.updateMany({
            data: {
              canonicalKey: target.canonicalKey,
              normalizedUrl: target.normalizedUrl,
              resolvedUrl: target.normalizedUrl,
            },
            where: {
              id: candidate.submissionId,
              status: "VERIFYING",
              canonicalKey: candidate.submission.canonicalKey,
              normalizedUrl: candidate.submission.normalizedUrl,
              collectionJobs: {
                some: { id: candidate.id, kind: "READBACK", status: "QUEUED", leaseToken: null },
              },
            },
          });
          if (identityUpdated.count !== 1) return "RACE_LOST";
        }
        const inFlight = await tx.publicationCollectionJob.count({
          where: { kind: "READBACK", status: "LEASED", leaseExpiresAt: { gt: now } },
        });
        if (inFlight >= positiveEnv("PUBLICATION_READBACK_MAX_ACTIVE", 2))
          return "CONCURRENCY_LIMIT";
        await tx.$executeRaw`
          INSERT INTO "publication_readback_budget" ("day", "used", "updated_at")
          VALUES (${day}, 0, NOW()) ON CONFLICT ("day") DO NOTHING
        `;
        // Re-read the override inside the serialized reservation transaction:
        // lowering the limit must take effect before any subsequent claim.
        const currentLimit =
          (
            await tx.publicationCollectorState.findUnique({
              where: { id: STATE_ID },
              select: { dailyLimit: true },
            })
          )?.dailyLimit ?? positiveEnv("PUBLICATION_READBACK_DAILY_LIMIT", 1000);
        const reserved = await tx.publicationReadbackBudget.updateMany({
          data: { used: { increment: 1 } },
          where: { day, used: { lt: currentLimit } },
        });
        if (reserved.count !== 1) return "DAILY_LIMIT";
        const updated = await tx.publicationCollectionJob.updateMany({
          data: {
            attempts: { increment: 1 },
            leaseOwner: nodeId,
            leaseToken,
            leaseExpiresAt,
            heartbeatAt: now,
            status: "LEASED",
          },
          where: {
            id: candidate.id,
            kind: "READBACK",
            status: "QUEUED",
            leaseToken: null,
            dueAt: { lte: now },
          },
        });
        if (updated.count === 1) return "CLAIMED";
        await tx.publicationReadbackBudget.update({
          data: { used: { decrement: 1 } },
          where: { day },
        });
        return "RACE_LOST";
      });
      if (claimed === "DAILY_LIMIT") return { paused: false, reason: "DAILY_LIMIT", job: null };
      if (claimed === "CONCURRENCY_LIMIT")
        return { paused: false, reason: "CONCURRENCY_LIMIT", job: null };
      if (claimed !== "CLAIMED") continue;
      const finalHealth = await this.status();
      if (finalHealth.paused) {
        await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(7100910101::bigint)`;
          const manual =
            finalHealth.reason === "READBACK_DISABLED" ||
            finalHealth.reason === "READBACK_CONFIGURATION_NOT_VERIFIED";
          const released = await tx.publicationCollectionJob.updateMany({
            data: {
              attempts: { decrement: 1 },
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              status: manual ? "NEEDS_REVIEW" : "QUEUED",
              ...(manual
                ? { errorCode: "READBACK_DISABLED_BY_ADMIN", completedAt: new Date() }
                : {}),
            },
            where: { id: candidate.id, status: "LEASED", leaseToken },
          });
          if (released.count !== 1) return;
          await tx.publicationReadbackBudget.updateMany({
            where: { day, used: { gt: 0 } },
            data: { used: { decrement: 1 } },
          });
          if (manual)
            await tx.publishSubmission.updateMany({
              where: { id: candidate.submissionId, status: "VERIFYING" },
              data: {
                status: "MANUAL_REVIEW",
                failureReason: "自动回读已停用，等待管理员人工复核",
              },
            });
        });
        return { ...finalHealth, job: null };
      }
      return {
        paused: false,
        reason: null,
        job: {
          id: candidate.id,
          noteId,
          dueAt: candidate.dueAt.toISOString(),
          leaseToken,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
        },
      };
    }
    return { paused: false, reason: null, job: null };
  }

  async result(nodeId: string, jobId: string, input: ReadbackResultDto) {
    const now = new Date();
    const payloadSha256 = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return this.prisma.$transaction(
      async (tx) => {
        const job = await tx.publicationCollectionJob.findUnique({
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
        const accepted = job?.evidence;
        if (
          job &&
          job.kind === "READBACK" &&
          ["COMPLETED", "NEEDS_REVIEW"].includes(job.status) &&
          job.leaseOwner === nodeId &&
          job.leaseToken === input.leaseToken &&
          accepted &&
          typeof accepted === "object" &&
          !Array.isArray(accepted) &&
          accepted.payloadSha256 === payloadSha256
        )
          return { status: job.status, alreadyAccepted: true };
        if (
          job?.kind !== "READBACK" ||
          job.status !== "LEASED" ||
          job.leaseOwner !== nodeId ||
          job.leaseToken !== input.leaseToken ||
          !job.leaseExpiresAt ||
          job.leaseExpiresAt <= now
        )
          throw new ConflictException("回读工作单租约已失效");
        const reserved = await tx.publicationCollectionJob.updateMany({
          data: {
            status: "COMPLETED",
            completedAt: now,
            errorCode: input.status === "AVAILABLE" ? null : input.code,
            evidence: { payloadSha256 },
          },
          where: {
            id: job.id,
            kind: "READBACK",
            status: "LEASED",
            leaseToken: input.leaseToken,
            leaseOwner: nodeId,
            leaseExpiresAt: { gt: now },
          },
        });
        if (reserved.count !== 1) throw new ConflictException("回读结果已被处理");
        if (job.submission.status !== "VERIFYING") {
          await tx.publicationCollectionJob.update({
            data: { status: "CANCELLED" },
            where: { id: job.id },
          });
          return { status: "CANCELLED" };
        }
        await tx.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(7100910101::bigint)`;
        const enabled = await this.configuration.enabled(tx);
        if (input.status === "AUTH_ERROR" && enabled) {
          await tx.publicationCollectorState.upsert({
            create: { id: STATE_ID, pausedAt: now, pauseReason: "PROVIDER_AUTH_ERROR" },
            update: { pausedAt: now, pauseReason: "PROVIDER_AUTH_ERROR" },
            where: { id: STATE_ID },
          });
        }
        if (enabled && (input.status === "RETRYABLE" || input.status === "AUTH_ERROR")) {
          if (job.attempts < MAX_ATTEMPTS) {
            await tx.publicationCollectionJob.update({
              data: {
                status: "QUEUED",
                completedAt: null,
                leaseOwner: null,
                leaseToken: null,
                leaseExpiresAt: null,
                heartbeatAt: null,
                dueAt: new Date(
                  now.getTime() +
                    (input.status === "AUTH_ERROR" ? 60_000 : 60_000 * 5 ** (job.attempts - 1)),
                ),
              },
              where: { id: job.id },
            });
            return { status: "RETRYABLE" };
          }
        }
        if (input.status !== "AVAILABLE" || !input.note || !input.observedAt) {
          await this.setNeedsReview(
            tx,
            job,
            now,
            !enabled || input.status === "INVALID_REQUEST" || input.status === "PARSER_CHANGED"
              ? "MANUAL_REVIEW"
              : "UNAVAILABLE",
            input.code,
          );
          return { status: "NEEDS_REVIEW" };
        }
        const observedAt = new Date(input.observedAt);
        const target = normalizePublicationUrl(job.submission.normalizedUrl);
        if (
          target.classification !== "XHS_NOTE" ||
          target.canonicalKey !== `xhs:note:${input.note.noteId.toLowerCase()}` ||
          !Number.isFinite(observedAt.getTime()) ||
          observedAt < job.dueAt ||
          observedAt.getTime() > now.getTime() + 60_000
        )
          throw new ConflictException("回读笔记身份或观察时间与工作单不符");
        const task = job.submission.task;
        const entitled = (await this.capabilities.current(job.submission.tenantId, tx))
          .metricsIntegrationEnabled;
        const metrics = entitled ? input.note : { likes: null, comments: null, favorites: null };
        await tx.publishReadbackSnapshot.create({
          data: {
            jobId: job.id,
            submissionId: job.submissionId,
            tenantId: job.submission.tenantId,
            campaignId: task.campaignId,
            windowHours: 24,
            observedAt,
            source: input.source,
            likes: metrics.likes ?? null,
            comments: metrics.comments ?? null,
            favorites: metrics.favorites ?? null,
          },
        });
        const scored = evaluatePublicationEvidence({
          actual: {
            title: input.note.title,
            body: input.note.body,
            hashtags: input.note.hashtags ?? [],
            images: [],
          },
          expected: task.employeeContent,
          policy: READBACK_SCORING_POLICY,
        });
        const publishingIssue = medicalPublicationIssue(task, input.note.authorId);
        if (task.campaign.selectionSnapshot)
          await tx.auditLog.create({
            data: {
              action: "publication.author-observed",
              actorType: "INTEGRATION",
              tenantId: task.tenantId,
              enterpriseId: task.enterpriseId,
              resourceId: job.submissionId,
              resourceType: "PublishSubmission",
              metadata: {
                authorId: input.note.authorId ?? null,
                contentRevision: task.employeeContent.revision,
                provider: input.source,
              },
            },
          });
        const duplicate = await tx.publishedContentRegistry.findUnique({
          where: { canonicalKey: target.canonicalKey },
        });
        const canAccept =
          !duplicate &&
          !publishingIssue &&
          Boolean(input.note.title.trim() && input.note.body.trim()) &&
          scored.decision === "VALID";
        await tx.publishSubmission.update({
          data: {
            adapterProvider: input.source,
            adapterModel: "note-detail-v3",
            adapterRequestId: job.id,
            extractedTitle: input.note.title,
            extractedBody: input.note.body,
            externalPublishedAt: input.note.publishedAt ? new Date(input.note.publishedAt) : null,
            matchScore: scored.overallScore,
            textSimilarityScore: scored.textScore,
            factMatchScore: scored.factScore,
            imageSimilarityScore: null,
            failureReason: canAccept
              ? null
              : duplicate
                ? "笔记链接已被其他任务使用，请人工核查"
                : (publishingIssue ?? "笔记已回读，内容或归属尚需人工确认"),
            status: canAccept ? "VALID" : "MANUAL_REVIEW",
            verificationFinishedAt: now,
            verifiedAt: canAccept ? now : null,
            verifier: "distributed-api-readback-v1",
          },
          where: { id: job.submissionId },
        });
        if (canAccept) {
          const registry = await tx.publishedContentRegistry.create({
            data: {
              tenantId: job.submission.tenantId,
              campaignId: task.campaignId,
              taskId: task.id,
              submissionId: job.submissionId,
              canonicalKey: target.canonicalKey,
              normalizedUrl: target.normalizedUrl,
              contentFingerprint: task.employeeContent.contentFingerprint,
              verifiedAt: now,
            },
          });
          if (entitled) {
            await tx.publishMetricSnapshot.create({
              data: {
                registryId: registry.id,
                tenantId: job.submission.tenantId,
                campaignId: task.campaignId,
                observedAt,
                windowHours: 24,
                source: input.source,
                likes: metrics.likes ?? null,
                comments: metrics.comments ?? null,
                favorites: metrics.favorites ?? null,
                views: null,
                shares: null,
                rawData: {
                  metricPrecision: {
                    likes:
                      metrics.likes === null || metrics.likes === undefined
                        ? "UNAVAILABLE"
                        : "EXACT",
                    comments:
                      metrics.comments === null || metrics.comments === undefined
                        ? "UNAVAILABLE"
                        : "EXACT",
                    favorites:
                      metrics.favorites === null || metrics.favorites === undefined
                        ? "UNAVAILABLE"
                        : "EXACT",
                  },
                },
              },
            });
          }
          await tx.distributionTask.update({
            data: {
              status: job.submission.lateCorrection ? "LATE_CORRECTED" : "COMPLETED",
              submittedAt: job.submission.submittedAt,
              verifiedAt: now,
            },
            where: { id: task.id },
          });
          if (!job.submission.lateCorrection) {
            const [campaign, completed] = await Promise.all([
              tx.campaign.findUniqueOrThrow({ where: { id: task.campaignId } }),
              tx.distributionTask.count({
                where: { campaignId: task.campaignId, status: "COMPLETED" },
              }),
            ]);
            if (completed === campaign.audienceCount && campaign.status !== "COMPLETED")
              await tx.campaign.update({
                data: { status: "COMPLETED" },
                where: { id: task.campaignId },
              });
          }
        }
        await tx.auditLog.create({
          data: {
            action: "publication.readback.completed",
            actorType: "INTEGRATION",
            enterpriseId: task.enterpriseId,
            tenantId: job.submission.tenantId,
            resourceId: job.id,
            resourceType: "PublicationCollectionJob",
            metadata: {
              matched: canAccept,
              provider: input.source,
              noteIdentityMatched: true,
              accountOwnershipChecked: Boolean(task.campaign.selectionSnapshot && !publishingIssue),
              ...(task.campaign.selectionSnapshot
                ? {
                    authorId: input.note.authorId ?? null,
                    contentRevision: task.employeeContent.revision,
                    publishingIssue,
                  }
                : {}),
              policyVersion: READBACK_POLICY_VERSION,
            },
          },
        });
        return { status: canAccept ? "COMPLETED" : "NEEDS_REVIEW" };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async resume(reason: string) {
    const principal = this.accessContext.requireSaasAdmin();
    const now = new Date();
    await this.prisma.publicationCollectorState.upsert({
      create: { id: STATE_ID, resumedAt: now },
      update: { pausedAt: null, pauseReason: null, resumedAt: now },
      where: { id: STATE_ID },
    });
    await this.prisma.auditLog.create({
      data: {
        action: "publication.readback.resume",
        actorType: "USER",
        actorUserId: principal.userId,
        resourceId: STATE_ID,
        resourceType: "PublicationCollectorState",
        reason,
      },
    });
    return this.status();
  }

  async setDailyLimit(dailyLimit: number, reason: string) {
    const principal = this.accessContext.requireSaasAdmin();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(7100910101::bigint)`;
      await tx.publicationCollectorState.upsert({
        create: { id: STATE_ID, dailyLimit },
        update: { dailyLimit },
        where: { id: STATE_ID },
      });
      await tx.auditLog.create({
        data: {
          action: "publication.readback.daily-limit.update",
          actorType: "USER",
          actorUserId: principal.userId,
          resourceId: STATE_ID,
          resourceType: "PublicationCollectorState",
          reason,
          metadata: { dailyLimit },
        },
      });
    });
    return this.adminOperations();
  }

  private async reviewCandidate(
    jobId: string,
    code: string,
    now: Date,
    submissionStatus: "UNAVAILABLE" | "MANUAL_REVIEW",
    previous: "QUEUED" | "LEASED",
  ) {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.publicationCollectionJob.updateMany({
        data: { status: "NEEDS_REVIEW", errorCode: code, completedAt: now },
        where: {
          id: jobId,
          kind: "READBACK",
          status: previous,
          ...(previous === "LEASED" ? { leaseExpiresAt: { lt: now } } : {}),
        },
      });
      if (updated.count !== 1) return;
      const job = await tx.publicationCollectionJob.findUniqueOrThrow({ where: { id: jobId } });
      await tx.publishSubmission.updateMany({
        data: {
          status: submissionStatus,
          failureReason: code.startsWith("SHORT_URL_")
            ? "暂时无法确认分享链接对应的小红书笔记，提交事实已保留，请重新复制笔记分享链接或等待人工核查"
            : "本次回读尚无可靠结论，提交事实已保留",
          verificationFinishedAt: now,
        },
        where: { id: job.submissionId, status: "VERIFYING" },
      });
    });
  }

  private async setNeedsReview(
    tx: Prisma.TransactionClient,
    job: { id: string; submissionId: string },
    now: Date,
    status: "UNAVAILABLE" | "MANUAL_REVIEW",
    code: string,
  ) {
    await tx.publicationCollectionJob.update({
      data: { status: "NEEDS_REVIEW", errorCode: code },
      where: { id: job.id },
    });
    await tx.publishSubmission.update({
      data: {
        status,
        failureReason: "本次回读尚无可靠结论，提交事实已保留",
        verificationFinishedAt: now,
        verifier: "distributed-api-readback-unconfirmed-v1",
      },
      where: { id: job.submissionId },
    });
  }
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}
