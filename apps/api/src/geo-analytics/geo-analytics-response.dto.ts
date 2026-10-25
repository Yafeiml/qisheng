import { ApiProperty } from "@nestjs/swagger";

export class GeoAssetCoverageDto {
  activeEntityCount!: number;
  activeTopicCount!: number;
  aliasCoverageRate!: number;
  completeEntityCount!: number;
  completenessRate!: number;
  entitiesWithoutTopics!: number;
  factsCoverageRate!: number;
  topicCoverageRate!: number;
}

export class GeoDeliveryCoverageDto {
  employeeContentCount!: number;
  entityEligibleCount!: number;
  entityHitCount!: number;
  entityHitRate!: number;
  topicEligibleCount!: number;
  topicHitCount!: number;
  topicHitRate!: number;
}

export class GeoTargetCoverageDto {
  campaignCount!: number;
  currentTargetedEntityCount!: number;
  currentTargetedTopicCount!: number;
  targetEntityCoverageRate!: number;
  targetTopicCoverageRate!: number;
  targetedEntityCount!: number;
  targetedTopicCount!: number;
}

export class GeoCoverageSummaryDto {
  @ApiProperty({ type: GeoAssetCoverageDto })
  assets!: GeoAssetCoverageDto;

  @ApiProperty({ type: GeoDeliveryCoverageDto })
  delivery!: GeoDeliveryCoverageDto;

  enterpriseId!: string;
  enterpriseName!: string;
  generatedAt!: string;
  geoLevel!: string;
  lookbackDays!: number;

  @ApiProperty({ type: GeoTargetCoverageDto })
  target!: GeoTargetCoverageDto;
}

export class GeoCampaignCoverageDto {
  campaignId!: string;
  campaignTitle!: string;
  createdAt!: string;

  @ApiProperty({ type: GeoDeliveryCoverageDto })
  delivery!: GeoDeliveryCoverageDto;

  status!: string;

  @ApiProperty({ type: GeoTargetCoverageDto })
  target!: GeoTargetCoverageDto;

  visibleAt!: string;
}

export class GeoCoverageTrendPointDto extends GeoCampaignCoverageDto {
  date!: string;
}

export class GeoCoverageGapDto {
  coverageRate!: number;
  deliveredContentCount!: number;
  eligibleContentCount!: number;

  @ApiProperty({ enum: ["NOT_DELIVERED", "NOT_TARGETED", "PARTIALLY_DELIVERED"] })
  gapType!: "NOT_DELIVERED" | "NOT_TARGETED" | "PARTIALLY_DELIVERED";

  @ApiProperty({ nullable: true, type: String })
  parentEntityName!: string | null;

  @ApiProperty({ enum: ["ENTITY", "TOPIC"] })
  resourceType!: "ENTITY" | "TOPIC";

  seriesId!: string;
  targetedCampaignCount!: number;
  title!: string;
}

export class GeoEnterpriseComparisonRowDto {
  activeEntityCount!: number;
  activeTopicCount!: number;
  completenessRate!: number;
  employeeContentCount!: number;
  enterpriseId!: string;
  enterpriseName!: string;
  entityDeliveryRate!: number;
  targetEntityCoverageRate!: number;
  targetTopicCoverageRate!: number;
  topicDeliveryRate!: number;
}

export class GeoTenantComparisonDto {
  @ApiProperty({ type: [GeoEnterpriseComparisonRowDto] })
  enterprises!: GeoEnterpriseComparisonRowDto[];

  generatedAt!: string;
  geoLevel!: string;
  lookbackDays!: number;
  tenantId!: string;
}
