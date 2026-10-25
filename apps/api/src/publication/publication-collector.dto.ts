import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { SAFE_METRIC_DISPLAY } from "./publication.dto";

export class ClaimCollectionJobDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1)
  limit?: number;
}

export class CollectionLeaseDto {
  @IsUUID()
  leaseToken!: string;
}

export class CollectionMetricValueDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  value?: number | null;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  @Matches(SAFE_METRIC_DISPLAY)
  raw?: string | null;

  @IsIn(["EXACT", "APPROXIMATE", "UNAVAILABLE"])
  precision!: "EXACT" | "APPROXIMATE" | "UNAVAILABLE";
}

export class CollectionMetricsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  likes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  comments?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  favorites?: number;
}

export class CollectionMetricsRawDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionMetricValueDto)
  likes?: CollectionMetricValueDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionMetricValueDto)
  comments?: CollectionMetricValueDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionMetricValueDto)
  favorites?: CollectionMetricValueDto;
}

export class CollectionImageDto {
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @Length(1, 1800)
  url?: string;

  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/iu)
  checksum?: string;

  @IsOptional()
  @Matches(/^[a-f0-9]{16}$/iu)
  perceptualHash?: string;
}

export const COLLECTION_EVIDENCE_STATUSES = [
  "AVAILABLE",
  "PARTIAL",
  "UNAVAILABLE",
  "WRONG_TARGET",
  "LINK_UNAVAILABLE",
  "LOGIN_REQUIRED",
  "CHALLENGE_REQUIRED",
  "RISK_BLOCKED",
  "RATE_LIMITED",
  "PARSER_CHANGED",
  "NETWORK_ERROR",
  "TIMEOUT",
] as const;

export class CollectionEvidenceDto extends CollectionLeaseDto {
  @IsIn(COLLECTION_EVIDENCE_STATUSES)
  status!: (typeof COLLECTION_EVIDENCE_STATUSES)[number];

  @IsOptional()
  @IsISO8601({ strict: true })
  observedAt?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @Length(1, 1800)
  canonicalUrl?: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 20000)
  body?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  hashtags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CollectionImageDto)
  images?: CollectionImageDto[];

  @IsOptional()
  @IsISO8601({ strict: true })
  externalPublishedAt?: string;

  @IsOptional()
  @IsIn(["ANONYMOUS", "COLLECTOR_ACCOUNT", "UNKNOWN"])
  visibilityContext?: "ANONYMOUS" | "COLLECTOR_ACCOUNT" | "UNKNOWN";

  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/iu)
  screenshotSha256?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  collectorVersion?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  parserVersion?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionMetricsDto)
  metrics?: CollectionMetricsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionMetricsRawDto)
  metricsRaw?: CollectionMetricsRawDto;
}

export class PauseCollectionDto {
  @IsString()
  @Length(4, 80)
  @Matches(/^[A-Z][A-Z0-9_]*$/u)
  reason!: string;
}

export class ResumeCollectionDto {
  @IsString()
  @Length(2, 160)
  reason!: string;
}
