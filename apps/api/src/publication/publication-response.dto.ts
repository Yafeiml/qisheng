import { ApiProperty } from "@nestjs/swagger";
import type { CursorPageInfoDto } from "../http/cursor-page.dto";

export class PublicationAudienceSnapshotDto {
  campaignId!: string;
  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  departmentName!: string | null;

  employeeName!: string;
  employeePhone!: string;
  enterpriseId!: string;
  id!: string;
  membershipId!: string;
  tenantId!: string;
}

export class PublicationImageDto {
  @ApiProperty({ nullable: true, type: String })
  byteSize!: string | null;

  campaignId!: string;
  checksum!: string;
  createdAt!: string;
  employeeContentId!: string;
  height!: number;
  id!: string;
  imageUrl!: string;
  mimeType!: string;

  @ApiProperty({ nullable: true, type: String })
  perceptualHash!: string | null;

  sequence!: number;
  tenantId!: string;
  width!: number;
}

export class PublicationEmployeeContentDto {
  audienceSnapshot!: PublicationAudienceSnapshotDto;
  audienceSnapshotId!: string;
  body!: string;
  campaignId!: string;
  contentFingerprint!: string;
  createdAt!: string;
  enterpriseId!: string;
  hashtags!: string[];
  id!: string;
  images!: PublicationImageDto[];
  membershipId!: string;

  @ApiProperty({ additionalProperties: true, type: "object" })
  riskAssessment!: Record<string, unknown>;

  status!: string;
  tenantId!: string;
  title!: string;
  updatedAt!: string;
}

export class PublicationReviewTaskDto {
  campaignId!: string;

  @ApiProperty({ additionalProperties: true, type: "object" })
  campaign!: Record<string, unknown>;

  @ApiProperty({ nullable: true, type: String })
  copiedAt!: string | null;

  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  downloadedAt!: string | null;

  employeeContent!: PublicationEmployeeContentDto;
  employeeContentId!: string;
  enterpriseId!: string;

  @ApiProperty({ nullable: true, type: String })
  expiredAt!: string | null;

  expiresAt!: string;

  @ApiProperty({ nullable: true, type: String })
  firstViewedAt!: string | null;

  id!: string;
  membershipId!: string;
  @ApiProperty({
    enum: [
      "AVAILABLE",
      "CANCELLED",
      "COMPLETED",
      "EXPIRED",
      "LATE_CORRECTED",
      "LOCKED",
      "VERIFYING",
    ],
  })
  status!:
    | "AVAILABLE"
    | "CANCELLED"
    | "COMPLETED"
    | "EXPIRED"
    | "LATE_CORRECTED"
    | "LOCKED"
    | "VERIFYING";

  @ApiProperty({ nullable: true, type: String })
  submittedAt!: string | null;

  tenantId!: string;
  updatedAt!: string;

  @ApiProperty({ nullable: true, type: String })
  verifiedAt!: string | null;

  visibleAt!: string;
}

export class PublicationReadbackSnapshotResponseDto {
  observedAt!: string;
  windowHours!: number;
  source!: string;

  @ApiProperty({ nullable: true, type: Number })
  likes!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  comments!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  favorites!: number | null;
}

export class PublicationReviewDto {
  canonicalKey!: string;

  @ApiProperty({ nullable: true, type: String })
  correctionReason!: string | null;

  @ApiProperty({ nullable: true, type: String })
  extractedBody!: string | null;

  extractedImageUrls!: string[];

  @ApiProperty({ nullable: true, type: String })
  extractedTitle!: string | null;

  @ApiProperty({ nullable: true, type: String })
  extractedUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  externalPublishedAt!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  factMatchScore!: number | null;

  @ApiProperty({ nullable: true, type: String })
  failureReason!: string | null;

  id!: string;

  @ApiProperty({ nullable: true, type: () => PublicationReadbackSnapshotResponseDto })
  readback!: PublicationReadbackSnapshotResponseDto | null;

  @ApiProperty({ nullable: true, type: Number })
  imageSimilarityScore!: number | null;

  lateCorrection!: boolean;

  @ApiProperty({ nullable: true, type: Number })
  matchScore!: number | null;

  normalizedUrl!: string;
  rawUrl!: string;

  @ApiProperty({ nullable: true, type: String })
  resolvedUrl!: string | null;

  @ApiProperty({
    enum: [
      "DUPLICATE",
      "INVALID",
      "MANUAL_REVIEW",
      "PENDING",
      "SUPERSEDED",
      "UNAVAILABLE",
      "VALID",
      "VERIFYING",
    ],
  })
  status!:
    | "DUPLICATE"
    | "INVALID"
    | "MANUAL_REVIEW"
    | "PENDING"
    | "SUPERSEDED"
    | "UNAVAILABLE"
    | "VALID"
    | "VERIFYING";
  submittedAt!: string;
  task!: PublicationReviewTaskDto;
  taskId!: string;
  tenantId!: string;
  verificationAttempt!: number;

  @ApiProperty({ nullable: true, type: String })
  verificationFinishedAt!: string | null;

  verificationPolicyVersion!: string;

  @ApiProperty({ nullable: true, type: String })
  verificationStartedAt!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  textSimilarityScore!: number | null;

  @ApiProperty({ nullable: true, type: String })
  verifiedAt!: string | null;
}

export class PublicationReviewPageDto {
  items!: PublicationReviewDto[];
  pageInfo!: CursorPageInfoDto;
}

export class DevelopmentPublicationResponseDto {
  canonicalKey!: string;
  normalizedUrl!: string;
  notice!: string;
  synthetic!: boolean;
}

export class PublicationSubmissionResultDto {
  canonicalKey!: string;

  @ApiProperty({ nullable: true, required: false, type: String })
  failureReason?: string | null;

  @ApiProperty({ nullable: true, required: false, type: Number })
  matchScore?: number | null;

  normalizedUrl!: string;
  @ApiProperty({
    enum: ["DUPLICATE", "INVALID", "MANUAL_REVIEW", "UNAVAILABLE", "VALID", "VERIFYING"],
  })
  status!: "DUPLICATE" | "INVALID" | "MANUAL_REVIEW" | "UNAVAILABLE" | "VALID" | "VERIFYING";
  submissionId!: string;
  synthetic!: boolean;

  @ApiProperty({ nullable: true, required: false, type: String })
  verifiedAt?: string | null;
}

export class PublishSubmissionResponseDto {
  canonicalKey!: string;

  @ApiProperty({ nullable: true, type: String })
  correctionReason!: string | null;

  @ApiProperty({ nullable: true, type: String })
  extractedBody!: string | null;

  extractedImageUrls!: string[];

  @ApiProperty({ nullable: true, type: String })
  extractedTitle!: string | null;

  @ApiProperty({ nullable: true, type: String })
  extractedUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  externalPublishedAt!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  factMatchScore!: number | null;

  @ApiProperty({ nullable: true, type: String })
  failureReason!: string | null;

  id!: string;

  @ApiProperty({ nullable: true, type: Number })
  imageSimilarityScore!: number | null;

  lateCorrection!: boolean;

  @ApiProperty({ nullable: true, type: Number })
  matchScore!: number | null;

  normalizedUrl!: string;
  rawUrl!: string;

  @ApiProperty({ nullable: true, type: String })
  resolvedUrl!: string | null;

  @ApiProperty({
    enum: [
      "DUPLICATE",
      "INVALID",
      "MANUAL_REVIEW",
      "PENDING",
      "SUPERSEDED",
      "UNAVAILABLE",
      "VALID",
      "VERIFYING",
    ],
  })
  status!:
    | "DUPLICATE"
    | "INVALID"
    | "MANUAL_REVIEW"
    | "PENDING"
    | "SUPERSEDED"
    | "UNAVAILABLE"
    | "VALID"
    | "VERIFYING";
  submittedAt!: string;
  taskId!: string;
  tenantId!: string;

  @ApiProperty({ nullable: true, type: Number })
  textSimilarityScore!: number | null;

  verificationAttempt!: number;

  @ApiProperty({ nullable: true, type: String })
  verificationFinishedAt!: string | null;

  verificationPolicyVersion!: string;

  @ApiProperty({ nullable: true, type: String })
  verificationStartedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  verifiedAt!: string | null;
}

export class PublishMetricSnapshotResponseDto {
  campaignId!: string;
  @ApiProperty({ nullable: true, type: Number })
  comments!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  favorites!: number | null;
  id!: string;
  ingestedAt!: string;
  @ApiProperty({ nullable: true, type: Number })
  likes!: number | null;
  observedAt!: string;

  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  rawData!: Record<string, unknown> | null;

  registryId!: string;
  @ApiProperty({ nullable: true, type: Number })
  shares!: number | null;
  source!: string;
  tenantId!: string;
  @ApiProperty({ nullable: true, type: Number })
  views!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  windowHours!: number | null;
}
