import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { PUBLICATION_SCORING_PROFILE_VERSION } from "../publication/publication-verification-scoring";
import { PlatformPublicationVerificationService } from "./platform-publication-verification.service";
import type { RegisterPublicationPolicyEvidenceDto } from "./platform-settings.dto";
import { PlatformSettingsReader } from "./platform-settings.reader";
import {
  normalizeProductionEndpoint,
  parsePublicationPolicyEvidence,
} from "./publication-policy-evidence";

@Injectable()
export class PublicationPolicyEvidenceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader,
    @Inject(PlatformPublicationVerificationService)
    private readonly publicationVerification: PlatformPublicationVerificationService,
  ) {}

  async register(input: RegisterPublicationPolicyEvidenceDto) {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") {
      throw new ConflictException("P-014 evidence registration requires platform scope");
    }
    let evidence: ReturnType<typeof parsePublicationPolicyEvidence>;
    try {
      evidence = parsePublicationPolicyEvidence(input.acceptanceReportJson);
    } catch (error) {
      throw new ConflictException({
        code: "PUBLICATION_POLICY_EVIDENCE_INVALID",
        message: error instanceof Error ? error.message : "P-014 acceptance report is invalid",
      });
    }
    await this.assertMatchesCurrentPolicy(evidence);
    try {
      const created = await this.prisma.$transaction(async (transaction) => {
        const row = await transaction.publicationVerificationPolicyEvidence.create({
          data: {
            acceptanceReportSha256: evidence.acceptanceReportSha256,
            benchmarkId: evidence.benchmarkId,
            imageSimilarityThreshold: new Prisma.Decimal(evidence.imageSimilarityThreshold),
            manualReviewMargin: new Prisma.Decimal(evidence.manualReviewMargin),
            policyVersion: evidence.policyVersion,
            providerCode: evidence.providerCode,
            providerEndpoint: evidence.providerEndpoint,
            registeredBy: principal.userId,
            report: evidence.report as Prisma.InputJsonValue,
            reportCheckedAt: evidence.reportCheckedAt,
            requireImageMatch: evidence.requireImageMatch,
            reviewer: evidence.reviewer,
            sampleCount: evidence.sampleCount,
            scoringProfileVersion: evidence.scoringProfileVersion,
            textSimilarityThreshold: new Prisma.Decimal(evidence.textSimilarityThreshold),
          },
        });
        await transaction.auditLog.create({
          data: {
            action: "platform-setting.publication-policy-evidence.register",
            actorType: "USER",
            actorUserId: principal.userId,
            metadata: {
              acceptanceReportSha256: evidence.acceptanceReportSha256,
              benchmarkId: evidence.benchmarkId,
              policyVersion: evidence.policyVersion,
              providerCode: evidence.providerCode,
              sampleCount: evidence.sampleCount,
              scoringProfileVersion: evidence.scoringProfileVersion,
            },
            reason: input.reason,
            resourceId: row.id,
            resourceType: "PublicationVerificationPolicyEvidence",
          },
        });
        return row;
      });
      return evidenceResponse(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException({
          code: "PUBLICATION_POLICY_EVIDENCE_ALREADY_REGISTERED",
          message: "This exact P-014 acceptance report has already been registered",
        });
      }
      throw error;
    }
  }

  async platformCurrent() {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") {
      throw new ConflictException("P-014 evidence inspection requires platform scope");
    }
    return this.matchingCurrent();
  }

  async matchingCurrent() {
    let configuration: Awaited<ReturnType<PlatformPublicationVerificationService["current"]>>;
    let endpoint: string;
    try {
      [configuration, endpoint] = await Promise.all([
        this.publicationVerification.current(),
        this.settings.string("publication.endpoint"),
      ]);
    } catch {
      return null;
    }
    if (!configuration.adapter || configuration.mode !== "HTTP") return null;
    const policy = configuration.policy;
    const row = await this.prisma.publicationVerificationPolicyEvidence.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        imageSimilarityThreshold: new Prisma.Decimal(policy.imageSimilarityThreshold),
        manualReviewMargin: new Prisma.Decimal(policy.manualReviewMargin),
        policyVersion: policy.policyVersion,
        providerCode: configuration.adapter.providerCode,
        providerEndpoint: normalizeProductionEndpoint(endpoint),
        requireImageMatch: true,
        scoringProfileVersion: PUBLICATION_SCORING_PROFILE_VERSION,
        textSimilarityThreshold: new Prisma.Decimal(policy.textSimilarityThreshold),
      },
    });
    return row ? evidenceResponse(row) : null;
  }

  private async assertMatchesCurrentPolicy(
    evidence: ReturnType<typeof parsePublicationPolicyEvidence>,
  ): Promise<void> {
    const [configuration, endpoint] = await Promise.all([
      this.publicationVerification.current(),
      this.settings.string("publication.endpoint"),
    ]);
    const mismatches: string[] = [];
    if (!configuration.adapter || configuration.mode !== "HTTP") {
      mismatches.push("publication.mode must be HTTP");
    } else if (configuration.adapter.providerCode !== evidence.providerCode) {
      mismatches.push("provider code does not match the active publication adapter");
    }
    if (normalizeProductionEndpoint(endpoint) !== evidence.providerEndpoint) {
      mismatches.push("provider endpoint does not match the active publication adapter");
    }
    if (evidence.scoringProfileVersion !== PUBLICATION_SCORING_PROFILE_VERSION) {
      mismatches.push("scoring profile does not match the current production implementation");
    }
    const policy = configuration.policy;
    if (policy.policyVersion !== evidence.policyVersion) {
      mismatches.push("policy version does not match the active policy");
    }
    if (policy.textSimilarityThreshold !== evidence.textSimilarityThreshold) {
      mismatches.push("text similarity threshold does not match the active policy");
    }
    if (policy.imageSimilarityThreshold !== evidence.imageSimilarityThreshold) {
      mismatches.push("image similarity threshold does not match the active policy");
    }
    if (policy.manualReviewMargin !== evidence.manualReviewMargin) {
      mismatches.push("manual review margin does not match the active policy");
    }
    if (!policy.requireImageMatch) {
      mismatches.push("active policy does not require employee-specific image matching");
    }
    if (mismatches.length > 0) {
      throw new ConflictException({
        code: "PUBLICATION_POLICY_EVIDENCE_MISMATCH",
        details: mismatches,
        message: "P-014 evidence does not match the currently active publication policy",
      });
    }
  }
}

function evidenceResponse(row: {
  acceptanceReportSha256: string;
  benchmarkId: string;
  createdAt: Date;
  id: string;
  policyVersion: string;
  providerCode: string;
  reportCheckedAt: Date;
  reviewer: string;
  sampleCount: number;
  scoringProfileVersion: string;
}) {
  return {
    acceptanceReportSha256: row.acceptanceReportSha256,
    benchmarkId: row.benchmarkId,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    policyVersion: row.policyVersion,
    providerCode: row.providerCode,
    reportCheckedAt: row.reportCheckedAt.toISOString(),
    reviewer: row.reviewer,
    sampleCount: row.sampleCount,
    scoringProfileVersion: row.scoringProfileVersion,
  };
}
