import { ApiProperty } from "@nestjs/swagger";
import { CursorPageInfoDto } from "../http/cursor-page.dto";

export class TenantDto {
  createdAt!: string;

  @ApiProperty({ enum: ["GROUP", "SINGLE_ENTERPRISE"] })
  customerType!: "GROUP" | "SINGLE_ENTERPRISE";

  id!: string;
  name!: string;

  @ApiProperty({ enum: ["ACTIVE", "CLOSED", "SUSPENDED"] })
  status!: "ACTIVE" | "CLOSED" | "SUSPENDED";

  timezone!: string;
  updatedAt!: string;
}

export class EnterpriseDto {
  @ApiProperty({ nullable: true, type: String })
  brandName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  city!: string | null;

  code!: string;
  createdAt!: string;
  id!: string;

  @ApiProperty({ nullable: true, type: String })
  industry!: string | null;

  name!: string;

  @ApiProperty({ enum: ["ACTIVE", "DISABLED"] })
  status!: "ACTIVE" | "DISABLED";

  tenantId!: string;
  updatedAt!: string;
}

export class EnterpriseOverviewDto extends EnterpriseDto {
  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  campaigns!: Record<string, number>;

  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  seats!: Record<string, number>;
}

export class EnterpriseWorkspaceCapabilitiesDto {
  geoEnabled!: boolean;
  geoLevel!: string;
  groupSharedMaterialsEnabled!: boolean;
  imagesPerDistribution!: number;
}

export class EnterpriseWorkspaceCountsDto {
  activeGeoEntities!: number;
  activeGeoTopics!: number;
  effectiveMaterials!: number;
  effectiveSensitiveRules!: number;
  enabledSeats!: number;
  enterpriseAdministrators!: number;
  memberProfiles!: number;
}

export class EnterpriseWorkspaceGenerationDto {
  failed!: number;
  queued!: number;
  running!: number;
  succeeded!: number;

  @ApiProperty({ nullable: true, type: Number })
  successRate!: number | null;
}

export class EnterpriseWorkspaceCampaignsDto {
  active!: number;
  approved!: number;
  completed!: number;
  generating!: number;
  generationFailed!: number;
  reviewPending!: number;
  total!: number;
}

export class EnterpriseWorkspaceReadinessStepDto {
  code!: string;
  current!: number;
  description!: string;
  href!: string;
  required!: number;

  @ApiProperty({ enum: ["BLOCKING", "COMPLETE", "RECOMMENDED"] })
  status!: "BLOCKING" | "COMPLETE" | "RECOMMENDED";

  title!: string;
}

export class EnterpriseWorkspaceNextActionDto {
  code!: string;
  description!: string;
  href!: string;
  title!: string;
}

export class EnterpriseWorkspaceSummaryDto {
  campaignReady!: boolean;

  campaigns!: EnterpriseWorkspaceCampaignsDto;

  @ApiProperty({ nullable: true, type: EnterpriseWorkspaceCapabilitiesDto })
  capabilities!: EnterpriseWorkspaceCapabilitiesDto | null;

  counts!: EnterpriseWorkspaceCountsDto;
  enterprise!: EnterpriseDto;
  generation!: EnterpriseWorkspaceGenerationDto;
  nextAction!: EnterpriseWorkspaceNextActionDto;

  steps!: EnterpriseWorkspaceReadinessStepDto[];
}

export class EnterpriseMembershipDto {
  @ApiProperty({ type: "object", additionalProperties: true, nullable: true })
  publisherContext!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: String })
  boundAt!: string | null;

  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  departmentId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  employeeNo!: string | null;

  enterpriseId!: string;

  @ApiProperty({ nullable: true, type: String })
  globalUserId!: string | null;

  id!: string;
  name!: string;
  phone!: string;

  @ApiProperty({ enum: ["PENDING_VERIFICATION", "NORMAL", "NEEDS_REVIEW"], nullable: true })
  smsNotificationStatus!: "PENDING_VERIFICATION" | "NORMAL" | "NEEDS_REVIEW" | null;

  @ApiProperty({ nullable: true, type: () => EnterpriseMembershipParticipationDto })
  participation!: EnterpriseMembershipParticipationDto | null;

  @ApiProperty({ enum: ["ENABLED", "NOT_ENABLED"] })
  seatStatus!: "ENABLED" | "NOT_ENABLED";

  @ApiProperty({ nullable: true, type: String })
  seatDisabledAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  seatEnabledAt!: string | null;

  @ApiProperty({ enum: ["ACTIVE", "DISABLED", "LEFT", "PENDING_BIND"] })
  status!: "ACTIVE" | "DISABLED" | "LEFT" | "PENDING_BIND";

  tenantId!: string;
  updatedAt!: string;
}

export class EnterpriseMembershipParticipationDto {
  controlOwner!: "ENTERPRISE" | "TENANT";

  @ApiProperty({ nullable: true, type: String })
  effectiveUntil!: string | null;

  lockedByTenant!: boolean;
  status!: "EXEMPT" | "PARTICIPATING" | "PAUSED" | "PENDING_REVIEW";
}

export class EnterpriseMembershipPageInfoDto extends CursorPageInfoDto {
  totalCount!: number;
}

export class EnterpriseMembershipPageDto {
  items!: EnterpriseMembershipDto[];
  pageInfo!: EnterpriseMembershipPageInfoDto;
}

export class GroupOverviewEnterpriseGenerationDto {
  failed!: number;
  running!: number;
  succeeded!: number;

  @ApiProperty({ nullable: true, type: Number })
  successRate!: number | null;
}

export class GroupOverviewEnterpriseDto {
  blockers!: string[];
  campaignReady!: boolean;

  @ApiProperty({ additionalProperties: { type: "integer" }, type: "object" })
  campaigns!: Record<string, number>;

  code!: string;
  effectiveMaterials!: number;
  effectiveSensitiveRules!: number;
  enabledSeats!: number;
  generation!: GroupOverviewEnterpriseGenerationDto;
  id!: string;
  name!: string;
  status!: string;
}

export class GroupOverviewSharedMaterialUsageDto {
  enterpriseId!: string;
  hitCount!: number;

  @ApiProperty({ nullable: true, type: String })
  lastHitAt!: string | null;
  materialId!: string;
  materialTitle!: string;
  materialVersion!: number;
}

export class GroupOverviewExpiringMaterialDto {
  expiresAt!: string;
  id!: string;
  title!: string;
  version!: number;
}

export class GroupOverviewSharedMaterialsDto {
  effectiveCount!: number;
  expiring!: GroupOverviewExpiringMaterialDto[];
  usage!: GroupOverviewSharedMaterialUsageDto[];
}

export class GroupOverviewSummaryDto {
  activeEnterprises!: number;
  blockedEnterprises!: number;
  campaignReadyEnterprises!: number;
  enabledSeats!: number;
  totalCampaigns!: number;
  totalEnterprises!: number;
}

export class GroupOverviewTenantDto {
  customerType!: string;
  id!: string;
  name!: string;
  timezone!: string;
}

export class GroupOverviewDto {
  enterprises!: GroupOverviewEnterpriseDto[];

  sharedMaterials!: GroupOverviewSharedMaterialsDto;
  summary!: GroupOverviewSummaryDto;
  tenant!: GroupOverviewTenantDto;
}
