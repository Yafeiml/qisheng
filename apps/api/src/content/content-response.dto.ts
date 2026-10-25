import { ApiProperty } from "@nestjs/swagger";

export class MaterialOptionsResponseDto {
  @ApiProperty({ type: Boolean })
  medical!: boolean;
}

export class FocusRecommendationDto {
  name!: string;
  aliases!: string[];
  @ApiProperty({ enum: ["BRAND", "DOCTOR", "DEVICE", "SERVICE"] })
  type!: "BRAND" | "DOCTOR" | "DEVICE" | "SERVICE";
  materialId!: string;
  materialTitle!: string;
  @ApiProperty({ nullable: true, type: String })
  enterpriseId!: string | null;
  evidence!: string;
}

export class VersionedContentDto {
  @ApiProperty({ nullable: true, type: String })
  changeNote!: string | null;

  createdAt!: string;
  createdBy!: string;

  @ApiProperty({ nullable: true, type: String })
  enterpriseId!: string | null;

  id!: string;
  seriesId!: string;
  status!: "ACTIVE" | "DISABLED";

  @ApiProperty({ nullable: true, type: String })
  supersedesId!: string | null;

  tenantId!: string;
  updatedAt!: string;
  version!: number;
}

export class MaterialResponseDto extends VersionedContentDto {
  @ApiProperty({ enum: ["AUTHORIZED", "EXPIRED", "PENDING", "REJECTED"] })
  authorizationStatus!: "AUTHORIZED" | "EXPIRED" | "PENDING" | "REJECTED";

  content!: string;

  @ApiProperty({ enum: ["PENDING", "USABLE", "NEEDS_INPUT"] })
  usabilityStatus!: "PENDING" | "USABLE" | "NEEDS_INPUT";

  @ApiProperty({ nullable: true, type: String })
  sourceText!: string | null;

  @ApiProperty({ nullable: true, type: String })
  supplement!: string | null;

  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  analysis!: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, type: String })
  contentChecksum!: string | null;

  @ApiProperty({ enum: ["FAILED", "PENDING", "PROCESSING", "QUARANTINED", "READY"] })
  ingestionStatus!: "FAILED" | "PENDING" | "PROCESSING" | "QUARANTINED" | "READY";

  @ApiProperty({ nullable: true, type: String })
  ingestionErrorCode!: string | null;

  @ApiProperty({ nullable: true, type: String })
  ingestionErrorMessage!: string | null;

  @ApiProperty({ nullable: true, type: String })
  parserVersion!: string | null;

  @ApiProperty({ nullable: true, type: String })
  readyAt!: string | null;

  artifacts!: MaterialArtifactResponseDto[];
  ingestionJobs!: MaterialIngestionJobResponseDto[];
  _count!: { chunks: number };

  @ApiProperty({ nullable: true, type: String })
  expiresAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  sourceUrl!: string | null;

  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  structuredFacts!: Record<string, unknown> | null;

  tags!: string[];
  title!: string;

  @ApiProperty({ enum: ["DOCUMENT", "IMAGE_REFERENCE", "LINK", "TEXT"] })
  type!: "DOCUMENT" | "IMAGE_REFERENCE" | "LINK" | "TEXT";

  @ApiProperty({ nullable: true, type: String })
  validFrom!: string | null;
}

export class MaterialArtifactResponseDto {
  description!: string;
  @ApiProperty({ enum: ["REFERENCE", "LOGO"] })
  usage!: "REFERENCE" | "LOGO";
  @ApiProperty({ enum: ["PENDING", "USABLE", "NEEDS_INPUT"] })
  usabilityStatus!: "PENDING" | "USABLE" | "NEEDS_INPUT";
  @ApiProperty({ type: "object", additionalProperties: true })
  analysis!: Record<string, unknown>;

  id!: string;
  kind!: "IMAGE_SOURCE" | "LINK_SNAPSHOT" | "UPLOAD";
  status!: "PENDING_UPLOAD" | "REJECTED" | "STORED" | "VERIFIED";
  mimeType!: string;

  @ApiProperty({ nullable: true, type: Number })
  byteSize!: number | null;

  @ApiProperty({ nullable: true, type: String })
  checksum!: string | null;

  @ApiProperty({ nullable: true, type: String })
  originalFileName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  sourceUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  verifiedAt!: string | null;

  createdAt!: string;
}

export class MaterialIngestionJobResponseDto {
  id!: string;
  status!: "FAILED" | "PENDING" | "PROCESSING" | "QUARANTINED" | "READY";
  attemptCount!: number;
  maxAttempts!: number;
  queueVersion!: number;

  @ApiProperty({ nullable: true, type: String })
  errorCode!: string | null;

  @ApiProperty({ nullable: true, type: String })
  errorMessage!: string | null;

  @ApiProperty({ nullable: true, type: String })
  finishedAt!: string | null;

  createdAt!: string;
}

export class SensitiveRuleResponseDto extends VersionedContentDto {
  @ApiProperty({ nullable: true, type: String })
  effectiveFrom!: string | null;

  @ApiProperty({ nullable: true, type: String })
  effectiveTo!: string | null;

  key!: string;

  @ApiProperty({ nullable: true, type: String })
  replacementSuggestion!: string | null;

  riskType!: string;
  scopeKey!: string;

  @ApiProperty({ enum: ["BLOCK", "NOTICE", "WARNING"] })
  severity!: "BLOCK" | "NOTICE" | "WARNING";

  term!: string;
}

export class GeoTopicResponseDto extends VersionedContentDto {
  entityId!: string;
  intent!: string;
  priority!: number;
  question!: string;
}

export class GeoEntityResponseDto extends VersionedContentDto {
  aliases!: string[];

  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  facts!: Record<string, unknown> | null;

  key!: string;
  name!: string;
  scopeKey!: string;

  @ApiProperty({
    enum: ["BRAND", "DEVICE", "DOCTOR", "ENTERPRISE", "LOCATION", "SERVICE", "TECHNOLOGY"],
  })
  type!: string;
}

export class GeoEntityWithTopicsDto extends GeoEntityResponseDto {
  topics!: GeoTopicResponseDto[];
}

export class BulkOperationCountsResponseDto {
  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  values!: Record<string, number>;
}

export class BulkMaterialRowResponseDto {
  @ApiProperty({ nullable: true, required: false, type: String })
  checksum?: string;

  @ApiProperty({ nullable: true, required: false, type: String })
  materialId?: string;

  @ApiProperty({ nullable: true, required: false, type: String })
  message?: string;

  row!: number;
  rowKey!: string;

  @ApiProperty({ enum: ["CREATED", "ERROR", "REUSED", "WOULD_CREATE"] })
  status!: "CREATED" | "ERROR" | "REUSED" | "WOULD_CREATE";
}

export class BulkMaterialReportResponseDto {
  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  counts!: Record<string, number>;

  dryRun!: boolean;

  @ApiProperty({ type: [BulkMaterialRowResponseDto] })
  rows!: BulkMaterialRowResponseDto[];
}

export class SensitiveRuleImportRowResponseDto {
  @ApiProperty({ nullable: true, required: false, type: String })
  message?: string;

  row!: number;

  @ApiProperty({ nullable: true, required: false, type: String })
  ruleId?: string;

  @ApiProperty({ enum: ["CONFLICT", "CREATED", "ERROR", "REUSED", "WOULD_CREATE"] })
  status!: "CONFLICT" | "CREATED" | "ERROR" | "REUSED" | "WOULD_CREATE";

  @ApiProperty({ nullable: true, required: false, type: String })
  term?: string;
}

export class SensitiveRuleImportReportResponseDto {
  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  counts!: Record<string, number>;

  dryRun!: boolean;

  @ApiProperty({ type: [SensitiveRuleImportRowResponseDto] })
  rows!: SensitiveRuleImportRowResponseDto[];
}

export class MaterialUploadIntentResponseDto {
  artifactId!: string;
  expiresInSeconds!: number;

  @ApiProperty({ additionalProperties: { type: "string" }, type: "object" })
  headers!: Record<string, string>;

  materialId!: string;
  uploadUrl!: string;
}

export class MaterialRevisionResponseDto {
  materialId!: string;

  @ApiProperty({ type: [MaterialUploadIntentResponseDto] })
  intents!: MaterialUploadIntentResponseDto[];
}

export class MaterialIngestionQueuedResponseDto {
  @ApiProperty({ type: MaterialArtifactResponseDto })
  artifact!: MaterialArtifactResponseDto;

  @ApiProperty({ nullable: true, type: MaterialIngestionJobResponseDto })
  job!: MaterialIngestionJobResponseDto | null;

  materialId!: string;
}

export class MaterialSupplementQueuedResponseDto {
  materialId!: string;
  job!: MaterialIngestionJobResponseDto;
}

export class MaterialArtifactPreviewResponseDto {
  expiresInSeconds!: number;

  @ApiProperty({ nullable: true, type: String })
  optimizedDataUrl!: string | null;

  url!: string;
}
