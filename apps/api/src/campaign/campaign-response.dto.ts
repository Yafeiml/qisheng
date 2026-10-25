import { ApiProperty } from "@nestjs/swagger";
import type { CursorPageInfoDto } from "../http/cursor-page.dto";
import type { PublicationAudienceSnapshotDto } from "../publication/publication-response.dto";

export class CampaignCountDto {
  distributionTasks!: number;
  employeeContents!: number;
}

export class GenerationWorkItemSummaryDto {
  attemptCount!: number;

  @ApiProperty({ enum: ["CANCELLED", "FAILED", "QUEUED", "RUNNING", "SUCCEEDED"] })
  status!: "CANCELLED" | "FAILED" | "QUEUED" | "RUNNING" | "SUCCEEDED";
}

export class CampaignGenerationRunSummaryDto {
  completedCount!: number;
  createdAt!: string;
  failedCount!: number;

  @ApiProperty({ nullable: true, type: String })
  finishedAt!: string | null;

  id!: string;
  requestedCount!: number;

  @ApiProperty({ nullable: true, type: String })
  startedAt!: string | null;

  @ApiProperty({ enum: ["CANCELLED", "FAILED", "QUEUED", "RUNNING", "SUCCEEDED"] })
  status!: "CANCELLED" | "FAILED" | "QUEUED" | "RUNNING" | "SUCCEEDED";

  @ApiProperty({ type: [GenerationWorkItemSummaryDto] })
  workItems!: GenerationWorkItemSummaryDto[];
}

export class CampaignListItemDto {
  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  selectionSnapshot!: Record<string, unknown> | null;
  _count!: CampaignCountDto;

  @ApiProperty({ nullable: true, type: String })
  approvedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  approvedBy!: string | null;

  audienceCount!: number;

  @ApiProperty({ enum: ["ALL", "DEPARTMENT", "SELECTED"] })
  audienceMode!: "ALL" | "DEPARTMENT" | "SELECTED";

  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  audienceSelector!: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, type: String })
  archivedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  archivedBy!: string | null;

  @ApiProperty({ nullable: true, type: String })
  cancelledAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  cancelledBy!: string | null;

  @ApiProperty({ nullable: true, type: String })
  cancellationReason!: string | null;

  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  cancellationSummary!: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, type: String })
  campaignTemplateId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  contentDirection!: string | null;

  createdAt!: string;
  createdBy!: string;
  enterpriseId!: string;
  expiresAt!: string;
  generatedCount!: number;

  @ApiProperty({ type: [CampaignGenerationRunSummaryDto] })
  generationRuns!: CampaignGenerationRunSummaryDto[];
  id!: string;
  imageCount!: number;

  @ApiProperty({ nullable: true, type: String })
  imageStyle!: string | null;

  @ApiProperty({ nullable: true, type: String })
  lastRescheduledAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  lastRescheduledBy!: string | null;
  prompt!: string;

  @ApiProperty({ nullable: true, type: String })
  promptTemplateId!: string | null;

  reminderOffsetsHours!: number[];

  @ApiProperty({
    enum: [
      "ACTIVE",
      "APPROVED",
      "CANCELLED",
      "COMPLETED",
      "DRAFT",
      "EXPIRED",
      "GENERATING",
      "GENERATION_FAILED",
      "REVIEW_PENDING",
    ],
  })
  status!: string;

  tenantId!: string;
  title!: string;
  updatedAt!: string;
  visibleAt!: string;
}

export class CampaignListPageDto {
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "integer", minimum: 0 },
    description: "当前筛选范围的全部状态数量，不受 status、cursor 或 limit 限制",
  })
  statusCounts!: Record<string, number>;

  @ApiProperty({ type: [CampaignListItemDto] })
  items!: CampaignListItemDto[];
  pageInfo!: CursorPageInfoDto;
}

export class CampaignBlueprintSourceContextDto {
  geoEntityCount!: number;
  geoTopicCount!: number;
  materialCount!: number;
  materialTitles!: string[];
  sensitiveRuleCount!: number;

  @ApiProperty({ nullable: true, type: String })
  schemaVersion!: string | null;
}

export class CampaignBlueprintResponseDto {
  campaignId!: string;
  createdAt!: string;

  imageDirection!: string;
  masterCopy!: string;

  @ApiProperty({ type: CampaignBlueprintSourceContextDto })
  sourceContext!: CampaignBlueprintSourceContextDto;

  updatedAt!: string;
}

export class GenerationWorkItemAudienceDto {
  @ApiProperty({ nullable: true, type: String })
  departmentName!: string | null;

  employeeName!: string;
  employeePhone!: string;
}

export class GenerationWorkItemDetailDto {
  attemptCount!: number;

  @ApiProperty({ type: GenerationWorkItemAudienceDto })
  audience!: GenerationWorkItemAudienceDto;

  createdAt!: string;

  @ApiProperty({
    enum: ["CONTENT_COMPLIANCE", "INTERNAL_ERROR", "PLATFORM_CONFIGURATION", "TEMPORARY_SERVICE"],
    nullable: true,
    type: String,
  })
  errorCategory!:
    | "CONTENT_COMPLIANCE"
    | "INTERNAL_ERROR"
    | "PLATFORM_CONFIGURATION"
    | "TEMPORARY_SERVICE"
    | null;

  @ApiProperty({ nullable: true, type: String })
  finishedAt!: string | null;

  id!: string;
  membershipId!: string;

  @ApiProperty({ nullable: true, type: String })
  reviewFeedback!: string | null;

  reviewRegenerationCount!: number;

  @ApiProperty({ nullable: true, type: String })
  startedAt!: string | null;

  @ApiProperty({ enum: ["CANCELLED", "FAILED", "QUEUED", "RUNNING", "SUCCEEDED"] })
  status!: "CANCELLED" | "FAILED" | "QUEUED" | "RUNNING" | "SUCCEEDED";

  updatedAt!: string;
}

export class CampaignGenerationRunDetailDto {
  completedCount!: number;
  createdAt!: string;

  @ApiProperty({
    enum: ["CONTENT_COMPLIANCE", "INTERNAL_ERROR", "PLATFORM_CONFIGURATION", "TEMPORARY_SERVICE"],
    nullable: true,
    type: String,
  })
  errorCategory!:
    | "CONTENT_COMPLIANCE"
    | "INTERNAL_ERROR"
    | "PLATFORM_CONFIGURATION"
    | "TEMPORARY_SERVICE"
    | null;

  failedCount!: number;

  @ApiProperty({ nullable: true, type: String })
  finishedAt!: string | null;

  id!: string;
  requestedCount!: number;

  @ApiProperty({ nullable: true, type: String })
  startedAt!: string | null;

  @ApiProperty({ enum: ["CANCELLED", "FAILED", "QUEUED", "RUNNING", "SUCCEEDED"] })
  status!: "CANCELLED" | "FAILED" | "QUEUED" | "RUNNING" | "SUCCEEDED";

  updatedAt!: string;

  @ApiProperty({ type: [GenerationWorkItemDetailDto] })
  workItems!: GenerationWorkItemDetailDto[];
}

export class CampaignGeneratedImageDto {
  @ApiProperty({ nullable: true, type: String })
  byteSize!: string | null;

  checksum!: string;
  createdAt!: string;
  height!: number;
  id!: string;
  imageUrl!: string;
  mimeType!: string;

  @ApiProperty({ nullable: true, type: String })
  perceptualHash!: string | null;

  sequence!: number;
  width!: number;
}

export class CampaignRiskAssessmentDto {
  notices!: string[];
  passed!: boolean;
  replacedBlocks!: string[];
  unresolvedBlocks?: string[];
  warnings!: string[];

  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  reviewDisposition?: Record<string, unknown> | null;
}

export class CampaignContentRevisionImageDto {
  @ApiProperty({ nullable: true, type: String })
  byteSize!: string | null;
  checksum!: string;
  height!: number;
  mimeType!: string;

  @ApiProperty({ nullable: true, type: String })
  perceptualHash!: string | null;

  sequence!: number;
  width!: number;
}

export class CampaignContentRevisionSnapshotDto {
  body!: string;
  contentFingerprint!: string;
  hashtags!: string[];

  @ApiProperty({ type: [CampaignContentRevisionImageDto] })
  images!: CampaignContentRevisionImageDto[];

  @ApiProperty({ type: CampaignRiskAssessmentDto })
  riskAssessment!: CampaignRiskAssessmentDto;

  status!: string;
  synthetic!: boolean;
  title!: string;
}

export class CampaignEmployeeContentRevisionDto {
  createdAt!: string;
  createdBy!: string;
  id!: string;

  @ApiProperty({ nullable: true, type: String })
  reviewFeedback!: string | null;

  revision!: number;

  @ApiProperty({ type: CampaignContentRevisionSnapshotDto })
  snapshot!: CampaignContentRevisionSnapshotDto;
}

export class CampaignEmployeeContentDto {
  audienceSnapshot!: PublicationAudienceSnapshotDto;
  audienceSnapshotId!: string;
  body!: string;
  campaignId!: string;
  contentFingerprint!: string;
  createdAt!: string;
  enterpriseId!: string;
  hashtags!: string[];
  id!: string;

  @ApiProperty({ type: [CampaignGeneratedImageDto] })
  images!: CampaignGeneratedImageDto[];
  membershipId!: string;
  revision!: number;

  @ApiProperty({ type: [CampaignEmployeeContentRevisionDto] })
  revisions!: CampaignEmployeeContentRevisionDto[];

  @ApiProperty({ type: CampaignRiskAssessmentDto })
  riskAssessment!: CampaignRiskAssessmentDto;

  status!: string;
  tenantId!: string;
  title!: string;
  updatedAt!: string;
}

export class CampaignSubmissionSummaryDto {
  canonicalKey!: string;

  @ApiProperty({ nullable: true, type: String })
  extractedBody!: string | null;

  extractedImageUrls!: string[];

  @ApiProperty({ nullable: true, type: String })
  extractedTitle!: string | null;

  @ApiProperty({ nullable: true, type: String })
  failureReason!: string | null;

  id!: string;

  @ApiProperty({ nullable: true, type: Number })
  matchScore!: number | null;

  normalizedUrl!: string;
  rawUrl!: string;
  status!: string;
  submittedAt!: string;
  synthetic!: boolean;
  taskId!: string;
  tenantId!: string;
  verifier!: string;

  @ApiProperty({ nullable: true, type: String })
  verifiedAt!: string | null;
}

export class CampaignDistributionTaskDto {
  campaignId!: string;

  @ApiProperty({ nullable: true, type: String })
  factsReturnedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  factsReturnReason!: string | null;

  @ApiProperty({ nullable: true, type: String })
  copiedAt!: string | null;

  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  downloadedAt!: string | null;

  employeeContentId!: string;
  enterpriseId!: string;

  @ApiProperty({ nullable: true, type: String })
  expiredAt!: string | null;

  expiresAt!: string;

  @ApiProperty({ nullable: true, type: String })
  firstViewedAt!: string | null;

  id!: string;
  membershipId!: string;
  status!: string;

  @ApiProperty({ nullable: true, type: String })
  submittedAt!: string | null;

  submissions!: CampaignSubmissionSummaryDto[];
  tenantId!: string;
  updatedAt!: string;

  @ApiProperty({ nullable: true, type: String })
  verifiedAt!: string | null;

  visibleAt!: string;
}

export class CampaignCancellationPreviewDto {
  cancelledDistributionTasks!: number;
  cancelledGenerationRuns!: number;
  cancelledWorkItems!: number;
}

export class CampaignDetailDto {
  @ApiProperty({ nullable: true, type: "object", additionalProperties: true })
  selectionSnapshot!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: String })
  approvedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  approvedBy!: string | null;

  audienceCount!: number;

  @ApiProperty({ enum: ["ALL", "DEPARTMENT", "SELECTED"] })
  audienceMode!: "ALL" | "DEPARTMENT" | "SELECTED";

  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  audienceSelector!: Record<string, unknown> | null;

  audienceSnapshots!: PublicationAudienceSnapshotDto[];

  @ApiProperty({ nullable: true, type: String })
  archivedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  archivedBy!: string | null;

  @ApiProperty({ nullable: true, type: CampaignBlueprintResponseDto })
  blueprint!: CampaignBlueprintResponseDto | null;

  @ApiProperty({ nullable: true, type: String })
  cancelledAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  cancelledBy!: string | null;

  @ApiProperty({ nullable: true, type: String })
  cancellationReason!: string | null;

  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  cancellationSummary!: Record<string, unknown> | null;

  createdAt!: string;
  createdBy!: string;
  distributionTasks!: CampaignDistributionTaskDto[];

  @ApiProperty({ type: [CampaignEmployeeContentDto] })
  employeeContents!: CampaignEmployeeContentDto[];
  enterpriseId!: string;
  expiresAt!: string;
  generatedCount!: number;

  @ApiProperty({ type: [CampaignGenerationRunDetailDto] })
  generationRuns!: CampaignGenerationRunDetailDto[];
  id!: string;
  imageCount!: number;

  @ApiProperty({ nullable: true, type: String })
  lastRescheduledAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  lastRescheduledBy!: string | null;
  prompt!: string;
  retrievalEvidence!: CampaignRetrievalEvidenceDto[];
  status!: string;
  tenantId!: string;
  title!: string;
  updatedAt!: string;
  visibleAt!: string;
}

export class CampaignCopyInputDto {
  @ApiProperty({ nullable: true, type: "object", additionalProperties: true })
  selection!: Record<string, unknown> | null;
  selectionRequired!: boolean;
  @ApiProperty({ required: false, type: [String] })
  focusEntityIds?: string[];
  @ApiProperty({ enum: ["ALL", "DEPARTMENT", "SELECTED"] })
  audienceMode!: "ALL" | "DEPARTMENT" | "SELECTED";

  @ApiProperty({ nullable: true, type: String })
  departmentId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  contentDirection!: string | null;

  @ApiProperty({ nullable: true, type: String })
  contentDirectionPresetId!: string | null;

  imageCount!: number;

  @ApiProperty({ nullable: true, type: String })
  imageStyle!: string | null;

  @ApiProperty({ nullable: true, type: String })
  imageStylePresetId!: string | null;

  membershipIds!: string[];
  prompt!: string;
  reminderOffsetsHours!: number[];
  sourceCampaignId!: string;
  title!: string;
  visibleAt!: string;
}

export class CampaignTimelineEventDto {
  actorType!: "INTEGRATION" | "SYSTEM" | "USER";

  @ApiProperty({ nullable: true, type: String })
  actorUserId!: string | null;

  category!: string;
  description!: string;
  id!: string;
  occurredAt!: string;
  source!: string;
  status!: string;
  title!: string;
}

export class CampaignTimelineDto {
  campaignId!: string;

  @ApiProperty({ type: [CampaignTimelineEventDto] })
  events!: CampaignTimelineEventDto[];
}

export class CampaignWorkItemListItemDto {
  attemptCount!: number;
  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  departmentName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  errorCategory!: string | null;

  @ApiProperty({ nullable: true, type: String })
  finishedAt!: string | null;

  id!: string;
  membershipId!: string;
  employeeName!: string;
  employeePhone!: string;

  @ApiProperty({ nullable: true, type: String })
  startedAt!: string | null;

  status!: string;
}

export class CampaignWorkItemPageDto {
  @ApiProperty({ type: [CampaignWorkItemListItemDto] })
  items!: CampaignWorkItemListItemDto[];

  pageInfo!: CursorPageInfoDto;
}

export class CampaignRetrievalEvidenceDto {
  id!: string;
  materialId!: string;
  chunkId!: string;
  materialTitle!: string;
  materialType!: "DOCUMENT" | "IMAGE_REFERENCE" | "LINK" | "TEXT";
  materialVersion!: number;
  frozenSnippet!: string;
  score!: number;
  lexicalScore!: number;
  vectorScore!: number;
  tagScore!: number;
  rank!: number;
  hitReasons!: string[];
  strategyVersion!: string;
  createdAt!: string;
}

export class MaterialRetrievalHitResponseDto {
  chunkId!: string;

  @ApiProperty({ nullable: true, type: String })
  enterpriseId!: string | null;

  hitReasons!: string[];
  lexicalScore!: number;
  materialId!: string;
  materialScopeKey!: string;
  materialSeriesId!: string;
  materialTitle!: string;

  @ApiProperty({ enum: ["DOCUMENT", "IMAGE_REFERENCE", "LINK", "TEXT"] })
  materialType!: "DOCUMENT" | "IMAGE_REFERENCE" | "LINK" | "TEXT";

  materialVersion!: number;
  rank!: number;
  score!: number;
  snippet!: string;
  tagScore!: number;
  vectorScore!: number;
}

export class MaterialImageCandidateDto {
  artifactId!: string;
  materialId!: string;
  title!: string;
  description!: string;
  fileName!: string;
  @ApiProperty({ enum: ["REFERENCE", "LOGO"] })
  usage!: "REFERENCE" | "LOGO";
  score!: number;
  @ApiProperty({ nullable: true, type: String })
  enterpriseId!: string | null;
}

export class PromotionFocusOptionDto {
  id!: string;
  name!: string;
  aliases!: string[];
  type!: string;
  @ApiProperty({ nullable: true, type: String })
  enterpriseId!: string | null;
}

export class MaterialRetrievalResponseDto {
  @ApiProperty({
    required: false,
    type: Boolean,
    description: "人物描述不能唯一确定，参考图片需由用户选择；未选择时不自动引用",
  })
  imageSelectionRequired?: boolean;

  focusEntityIds!: string[];
  @ApiProperty({ type: [PromotionFocusOptionDto] })
  focusOptions!: PromotionFocusOptionDto[];
  @ApiProperty({ type: [MaterialImageCandidateDto] })
  images!: MaterialImageCandidateDto[];

  contextCharacters!: number;

  @ApiProperty({ type: [MaterialRetrievalHitResponseDto] })
  hits!: MaterialRetrievalHitResponseDto[];

  query!: string;
  strategyVersion!: string;
}

export class PublishMetricDto {
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

export class CampaignNamedResourceDto {
  id!: string;
  name!: string;
}

export class DashboardTaskRowDto {
  campaignId!: string;
  campaignTitle!: string;
  employeeName!: string;
  employeePhone!: string;
  enterpriseId!: string;
  enterpriseName!: string;
  expiresAt!: string;

  @ApiProperty({ nullable: true, type: PublishMetricDto })
  latestMetrics!: PublishMetricDto | null;

  membershipId!: string;
  status!: string;
  taskId!: string;

  @ApiProperty({ nullable: true, type: String })
  verifiedAt!: string | null;
}

export class DashboardRankingDto extends DashboardTaskRowDto {
  rank!: number;
}

export class DashboardCampaignDto {
  audienceCount!: number;
  completedCount!: number;

  @ApiProperty({ nullable: true, type: String })
  contentDirection!: string | null;

  enterprise!: CampaignNamedResourceDto;
  expiresAt!: string;
  id!: string;

  @ApiProperty({ nullable: true, type: String })
  imageStyle!: string | null;

  status!: string;
  title!: string;
  visibleAt!: string;
}

export class DashboardMetricTotalsDto {
  @ApiProperty({ nullable: true, type: Number })
  comments!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  favorites!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  likes!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  shares!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  views!: number | null;
}

export class DashboardMetricCoverageDto {
  comments!: number;
  favorites!: number;
  likes!: number;
  shares!: number;
  views!: number;
}

export class DashboardSummaryDto {
  campaignCount!: number;
  completionRate!: number;
  expiredIncompleteCount!: number;
  lateCorrectedCount!: number;
  metricCoverage!: DashboardMetricCoverageDto;
  metricTotals!: DashboardMetricTotalsDto;
  taskCount!: number;
  verifiedCount!: number;
}

export class DashboardPeriodDto {
  @ApiProperty({ nullable: true, type: String })
  from!: string | null;

  @ApiProperty({ nullable: true, type: String })
  previousFrom!: string | null;

  @ApiProperty({ nullable: true, type: String })
  previousTo!: string | null;

  @ApiProperty({ nullable: true, type: String })
  to!: string | null;
}

export class DashboardSummaryChangesDto {
  completionRate!: number;
  lateCorrectedCount!: number;
  taskCount!: number;
  verifiedCount!: number;
  @ApiProperty({ nullable: true, type: Number })
  views!: number | null;
}

export class DashboardEnterpriseComparisonDto extends DashboardSummaryDto {
  enterpriseId!: string;
  enterpriseName!: string;
}

export class DashboardContentComparisonDto {
  campaignCount!: number;
  completionRate!: number;
  dimension!: "CONTENT_DIRECTION" | "IMAGE_STYLE" | "VISIBLE_HOUR";
  taskCount!: number;
  value!: string;
  viewCoverage!: number;

  @ApiProperty({ nullable: true, type: Number })
  views!: number | null;
}

export class DashboardMetricWindowDto {
  campaignTitle!: string;
  dueAt!: string;
  employeeName!: string;
  hasSnapshot!: boolean;

  @ApiProperty({ nullable: true, type: String })
  observedAt!: string | null;

  status!: string;
  taskId!: string;
  windowHours!: number;
}

export class DashboardReminderDto {
  campaignId!: string;
  campaignTitle!: string;
  dueAt!: string;
  offsetHours!: number;
  pendingCount!: number;
  status!: "COMPLETED" | "DUE" | "UPCOMING";
}

export class CampaignDashboardDto {
  campaigns!: DashboardCampaignDto[];
  contentComparisons!: DashboardContentComparisonDto[];
  enterpriseComparisons!: DashboardEnterpriseComparisonDto[];
  incompleteEmployees!: DashboardTaskRowDto[];
  metricObservations!: DashboardTaskRowDto[];
  metricWindows!: DashboardMetricWindowDto[];
  period!: DashboardPeriodDto;

  @ApiProperty({ nullable: true, type: DashboardSummaryDto })
  previousSummary!: DashboardSummaryDto | null;

  rankings!: DashboardRankingDto[];
  reminders!: DashboardReminderDto[];
  summary!: DashboardSummaryDto;

  @ApiProperty({ nullable: true, type: DashboardSummaryChangesDto })
  summaryChanges!: DashboardSummaryChangesDto | null;
}

export class EmployeeTaskImageDto {
  @ApiProperty({ nullable: true, type: String })
  byteSize!: string | null;

  height!: number;
  id!: string;
  imageUrl!: string;
  mimeType!: string;
  synthetic!: boolean;
  width!: number;
}

export class EmployeeTaskContentDto {
  body!: string;
  hashtags!: string[];
  images!: EmployeeTaskImageDto[];
  synthetic!: boolean;
  title!: string;
}

export class EmployeeTaskPublicationDto {
  @ApiProperty({ nullable: true, type: PublishMetricDto })
  latestMetrics!: PublishMetricDto | null;

  normalizedUrl!: string;
  verifiedAt!: string;
}

export class EmployeeTaskCampaignDto {
  id!: string;
  status!: string;
  title!: string;
}

export class EmployeeTaskDto {
  contentRevision!: number;
  factsConfirmationRequired!: boolean;
  factsConfirmed!: boolean;
  factsReturned!: boolean;

  @ApiProperty({ nullable: true, type: String })
  publishingArrangement!: string | null;

  campaign!: EmployeeTaskCampaignDto;

  @ApiProperty({ nullable: true, type: EmployeeTaskContentDto })
  content!: EmployeeTaskContentDto | null;

  contentVisible!: boolean;

  @ApiProperty({ nullable: true, type: String })
  copiedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  downloadedAt!: string | null;

  enterprise!: CampaignNamedResourceDto;
  expiresAt!: string;

  @ApiProperty({ nullable: true, type: String })
  firstViewedAt!: string | null;

  id!: string;

  @ApiProperty({ nullable: true, type: EmployeeTaskPublicationDto })
  publication!: EmployeeTaskPublicationDto | null;

  status!: string;

  @ApiProperty({ nullable: true, type: String })
  submissionFailureReason!: string | null;

  @ApiProperty({ nullable: true, type: String })
  submittedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  verifiedAt!: string | null;

  visibleAt!: string;
}
