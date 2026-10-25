import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { CursorPageInfoDto } from "../http/cursor-page.dto";
import {
  type EnterpriseDto,
  EnterpriseWorkspaceSummaryDto,
  type TenantDto,
} from "../organization/organization-response.dto";

export class NamedResourceDto {
  id!: string;
  name!: string;
}

export class GenerationRunCampaignDto {
  id!: string;
  status!: string;
  title!: string;
}

export class GenerationRunListItemDto {
  activeWorkItemLeases!: number;
  attemptCount!: number;
  campaign!: GenerationRunCampaignDto;
  completedCount!: number;
  createdAt!: string;
  enterprise!: NamedResourceDto;
  estimatedCost!: number;
  failedCount!: number;

  @ApiProperty({ nullable: true, type: String })
  errorCode!: string | null;

  @ApiProperty({ nullable: true, type: Boolean })
  errorRetryable!: boolean | null;

  executionVersion!: number;

  @ApiProperty({ nullable: true, type: String })
  finishedAt!: string | null;

  id!: string;
  imageModel!: string;

  @ApiProperty({ nullable: true, type: String })
  leaseExpiresAt!: string | null;

  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  invocations!: Record<string, number>;

  provider!: string;
  queueVersion!: number;
  recoveryCount!: number;
  requestedCount!: number;
  retriedWorkItems!: number;

  @ApiProperty({ nullable: true, type: String })
  startedAt!: string | null;

  staleWorkItems!: number;
  status!: string;
  synthetic!: boolean;
  tenant!: NamedResourceDto;
  textModel!: string;

  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  workItems!: Record<string, number>;
}

export class GenerationRunPageDto {
  items!: GenerationRunListItemDto[];
  pageInfo!: CursorPageInfoDto;
}

export class GenerationWorkItemDiagnosticDto {
  attemptCount!: number;

  @ApiProperty({ nullable: true, type: String })
  errorCode!: string | null;

  @ApiProperty({ nullable: true, type: String })
  errorMessage!: string | null;

  @ApiProperty({ nullable: true, type: Boolean })
  errorRetryable!: boolean | null;

  executionVersion!: number;

  @ApiProperty({ nullable: true, type: String })
  finishedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  heartbeatAt!: string | null;

  id!: string;

  @ApiProperty({ nullable: true, type: String })
  leaseExpiresAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  leaseOwner!: string | null;

  maxAttempts!: number;

  @ApiProperty({ nullable: true, type: String })
  nextRetryAt!: string | null;

  queueVersion!: number;
  recoveryCount!: number;
  reservationVersion!: number;

  @ApiProperty({ nullable: true, type: String })
  startedAt!: string | null;

  status!: string;
}

export class GenerationRunDetailDto extends GenerationRunListItemDto {
  @ApiProperty({ nullable: true, type: String })
  errorMessage!: string | null;

  @ApiProperty({ nullable: true, type: String })
  heartbeatAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  leaseOwner!: string | null;

  maxAttempts!: number;

  @ApiProperty({ nullable: true, type: String })
  nextRetryAt!: string | null;

  workItemDetails!: GenerationWorkItemDiagnosticDto[];
}

export class GenerationRecoveryResponseDto {
  enqueuedRuns!: number;
  enqueuedWorkItems!: number;
  generationRunId!: string;
  recoveredRuns!: number;
  recoveredWorkItems!: number;
}

export class CustomerEnterpriseDto {
  code!: string;
  id!: string;
  name!: string;
  status!: string;
}

export class CustomerListItemDto {
  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  campaigns!: Record<string, number>;

  createdAt!: string;

  @ApiProperty({ enum: ["GROUP", "SINGLE_ENTERPRISE"] })
  customerType!: "GROUP" | "SINGLE_ENTERPRISE";

  enterprises!: CustomerEnterpriseDto[];

  @ApiProperty({ enum: ["HAS_ENTERPRISE", "NO_ENTERPRISE"] })
  enterpriseState!: "HAS_ENTERPRISE" | "NO_ENTERPRISE";

  id!: string;
  name!: string;

  readiness!: CustomerReadinessSummaryDto;

  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  memberships!: Record<string, number>;

  status!: string;
  timezone!: string;
}

export class CustomerPageDto {
  items!: CustomerListItemDto[];
  pageInfo!: CursorPageInfoDto;
}

export class CustomerReadinessSummaryDto {
  blockedEnterprises!: number;
  readyEnterprises!: number;

  @ApiProperty({ enum: ["BLOCKED", "NOT_APPLICABLE", "READY"] })
  state!: "BLOCKED" | "NOT_APPLICABLE" | "READY";

  totalEnterprises!: number;
}

export class PlatformCustomerRouteReasonDto {
  code!: string;
  message!: string;
}

export class PlatformCustomerRouteModelDto {
  displayName!: string;
  externalModelId!: string;
  healthStatus!: string;
  id!: string;
  providerCode!: string;
  providerName!: string;
  providerStatus!: string;
  status!: string;
  synthetic!: boolean;
  tier!: string;
}

export class PlatformCustomerRouteQualificationDto {
  checkedAt!: string;
  estimatedCost!: number;
  @ApiProperty({ nullable: true, type: String })
  expiresAt!: string | null;
  id!: string;
}

export class PlatformCustomerRouteDiagnosticDto {
  configurationFingerprint!: string;
  eligible!: boolean;
  id!: string;
  image!: PlatformCustomerRouteModelDto;

  @ApiProperty({ nullable: true, type: PlatformCustomerRouteQualificationDto })
  qualification!: PlatformCustomerRouteQualificationDto | null;

  reasons!: PlatformCustomerRouteReasonDto[];
  scopeId!: string;
  scopeType!: string;
  text!: PlatformCustomerRouteModelDto;
}

export class CustomerAdministratorContactDto {
  @ApiProperty({ nullable: true, type: String })
  email!: string | null;

  id!: string;

  @ApiProperty({ nullable: true, type: String })
  name!: string | null;

  phone!: string;
}

export class PlatformCustomerEnterpriseDetailDto {
  administrators!: CustomerAdministratorContactDto[];
  enterprise!: CustomerEnterpriseDto;

  @ApiProperty({ nullable: true, type: PlatformCustomerRouteDiagnosticDto })
  route!: PlatformCustomerRouteDiagnosticDto | null;

  @ApiProperty({ nullable: true, type: String })
  routeError!: string | null;

  @ApiProperty({ type: EnterpriseWorkspaceSummaryDto })
  workspace!: EnterpriseWorkspaceSummaryDto;
}

export class PlatformCustomerGenerationQualityDto {
  averageAttempts!: number;
  estimatedCost!: number;
  invocationFailures!: number;
  invocations!: number;

  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  runsByStatus!: Record<string, number>;

  @ApiProperty({ nullable: true, type: Number })
  successRate!: number | null;

  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  workItemsByStatus!: Record<string, number>;
}

export class PlatformCustomerAuditDto {
  action!: string;

  @ApiProperty({ nullable: true, type: String })
  actorUserId!: string | null;

  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  enterpriseId!: string | null;

  id!: string;

  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  metadata!: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ nullable: true, type: String })
  resourceId!: string | null;

  resourceType!: string;
}

export class PlatformCustomerNoteDto {
  body!: string;
  createdAt!: string;
  createdBy!: string;

  @ApiProperty({ nullable: true, type: String })
  createdByPhone!: string | null;

  id!: string;
  tenantId!: string;
}

export class CustomerLifecycleResponseDto {
  status!: string;
  tenantId!: string;
}

export class PlatformCustomerDetailDto {
  administrators!: CustomerAdministratorContactDto[];
  audits!: PlatformCustomerAuditDto[];
  customer!: CustomerListItemDto;
  enterprises!: PlatformCustomerEnterpriseDetailDto[];
  generation!: PlatformCustomerGenerationQualityDto;
  notes!: PlatformCustomerNoteDto[];
}

export class PlatformGenerationOverviewDto {
  @ApiProperty({ nullable: true, type: Number })
  averageInvocationLatencyMs!: number | null;

  invocationCostToday!: number;
  invocationFailuresToday!: number;
  invocationsToday!: number;

  @ApiProperty({ nullable: true, type: Number })
  runSuccessRate!: number | null;

  queue!: PlatformGenerationQueueOverviewDto;

  retriedWorkItemsToday!: number;

  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  runsByStatus!: Record<string, number>;

  runsToday!: number;
  staleRuns!: number;
  staleWorkItems!: number;

  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  workItemsByStatus!: Record<string, number>;
}

export class PlatformGenerationQueueOverviewDto {
  active!: number;
  completed!: number;
  delayed!: number;
  failed!: number;
  paused!: boolean;
  waiting!: number;
  workers!: number;
}

export class PlatformModelOverviewDto {
  activeProviders!: number;
  blockedRoutes!: number;

  @ApiProperty({ enum: ["DEVELOPMENT", "PRODUCTION"] })
  deliveryMode!: "DEVELOPMENT" | "PRODUCTION";

  halfOpenCircuitProviders!: number;
  openCircuitProviders!: number;
  qualifiedRoutes!: number;
  realProviders!: number;
  staleHealthProviders!: number;
  syntheticProviders!: number;
  syntheticRoutes!: number;
}

export class PlatformTenantOverviewDto {
  activeEnterprises!: number;
  activeTenants!: number;
  groups!: number;
  singleEnterprises!: number;
}

export class ProductionReadinessStageDto {
  @ApiProperty({ enum: ["CONFIGURATION", "CONNECTION", "VALIDATION", "PRODUCTION"] })
  code!: "CONFIGURATION" | "CONNECTION" | "VALIDATION" | "PRODUCTION";

  title!: string;

  @ApiProperty({ enum: ["READY", "BLOCKED", "UNKNOWN", "SKIPPED", "WARNING"] })
  status!: "READY" | "BLOCKED" | "UNKNOWN" | "SKIPPED" | "WARNING";

  message!: string;
  action!: string;
  href!: string;
}

export class ProductionReadinessCheckDto {
  action!: string;

  @ApiProperty({ enum: ["ADAPTER", "INFRASTRUCTURE", "MODEL", "RUNTIME", "SECURITY"] })
  category!: "ADAPTER" | "INFRASTRUCTURE" | "MODEL" | "RUNTIME" | "SECURITY";

  code!: string;

  @ApiProperty({ additionalProperties: true, type: "object" })
  evidence!: Record<string, boolean | number | string | null>;

  href!: string;
  message!: string;

  @ApiProperty({ enum: ["BLOCKED", "READY", "WARNING"] })
  status!: "BLOCKED" | "READY" | "WARNING";

  title!: string;

  @ApiPropertyOptional({ type: [ProductionReadinessStageDto] })
  stages?: ProductionReadinessStageDto[];
}

export class ProductionReadinessSummaryDto {
  blocked!: number;
  ready!: number;
  total!: number;
  warning!: number;
}

export class ProductionReadinessAuditDto {
  @ApiProperty({ type: [ProductionReadinessCheckDto] })
  checks!: ProductionReadinessCheckDto[];

  @ApiProperty({ enum: ["DEVELOPMENT", "PRODUCTION"] })
  deliveryMode!: "DEVELOPMENT" | "PRODUCTION";

  generatedAt!: string;
  schemaVersion!: number;

  @ApiProperty({ enum: ["BLOCKED", "READY"] })
  state!: "BLOCKED" | "READY";

  summary!: ProductionReadinessSummaryDto;
}

export class PlatformOperationsOverviewDto {
  generatedAt!: string;
  generation!: PlatformGenerationOverviewDto;
  models!: PlatformModelOverviewDto;
  productionReadiness!: ProductionReadinessAuditDto;
  tenants!: PlatformTenantOverviewDto;
}

export class ProvisionedAdministratorDto {
  username!: string;
  phone!: string;
  roleBindingId!: string;
  userId!: string;
}

export class ProvisionCustomerResponseDto {
  administrator!: ProvisionedAdministratorDto;
  enterprise!: EnterpriseDto;
  tenant!: TenantDto;
}
