import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { CursorPaginationQueryDto } from "../http/cursor-pagination";

const METRIC_NAMES = ["views", "likes", "comments", "favorites", "shares"] as const;
const PRECISION_OPTIONS = ["EXACT", "APPROXIMATE", "UNAVAILABLE"] as const;
// Page abbreviations only, e.g. "1.2万+". Raw DOM/HTML and arbitrary text are never accepted.
export const SAFE_METRIC_DISPLAY =
  /^\s*(?:\d{1,9}|\d{1,3}(?:[,，]\d{3}){1,2})(?:[.．]\d{1,2})?\s*(?:[千万亿])?\s*[+＋]?\s*$/u;

export class MetricPrecisionDto {
  @ApiPropertyOptional({ enum: PRECISION_OPTIONS })
  @IsOptional()
  @IsIn(PRECISION_OPTIONS)
  views?: (typeof PRECISION_OPTIONS)[number];

  @ApiPropertyOptional({ enum: PRECISION_OPTIONS })
  @IsOptional()
  @IsIn(PRECISION_OPTIONS)
  likes?: (typeof PRECISION_OPTIONS)[number];

  @ApiPropertyOptional({ enum: PRECISION_OPTIONS })
  @IsOptional()
  @IsIn(PRECISION_OPTIONS)
  comments?: (typeof PRECISION_OPTIONS)[number];

  @ApiPropertyOptional({ enum: PRECISION_OPTIONS })
  @IsOptional()
  @IsIn(PRECISION_OPTIONS)
  favorites?: (typeof PRECISION_OPTIONS)[number];

  @ApiPropertyOptional({ enum: PRECISION_OPTIONS })
  @IsOptional()
  @IsIn(PRECISION_OPTIONS)
  shares?: (typeof PRECISION_OPTIONS)[number];
}

export class MetricDisplayDto {
  @ApiPropertyOptional({ maxLength: 32, pattern: SAFE_METRIC_DISPLAY.source, type: String })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  @Matches(SAFE_METRIC_DISPLAY)
  views?: string;

  @ApiPropertyOptional({ maxLength: 32, pattern: SAFE_METRIC_DISPLAY.source, type: String })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  @Matches(SAFE_METRIC_DISPLAY)
  likes?: string;

  @ApiPropertyOptional({ maxLength: 32, pattern: SAFE_METRIC_DISPLAY.source, type: String })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  @Matches(SAFE_METRIC_DISPLAY)
  comments?: string;

  @ApiPropertyOptional({ maxLength: 32, pattern: SAFE_METRIC_DISPLAY.source, type: String })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  @Matches(SAFE_METRIC_DISPLAY)
  favorites?: string;

  @ApiPropertyOptional({ maxLength: 32, pattern: SAFE_METRIC_DISPLAY.source, type: String })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  @Matches(SAFE_METRIC_DISPLAY)
  shares?: string;
}

export class IngestMetricMetadataDto {
  @ApiPropertyOptional({ type: MetricPrecisionDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MetricPrecisionDto)
  metricPrecision?: MetricPrecisionDto;

  @ApiPropertyOptional({ type: MetricDisplayDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MetricDisplayDto)
  metricDisplay?: MetricDisplayDto;
}

export const INGEST_METRIC_NAMES = METRIC_NAMES;

export class PublicationReviewQueryDto extends CursorPaginationQueryDto {
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(1, 64)
  taskId?: string;
}

export class SubmitPublicationDto {
  @Transform(trimString)
  @IsString()
  @Length(8, 4000)
  url!: string;
}

export class CreateDevelopmentPublicationDto {
  @IsOptional()
  @ApiProperty({ default: "MATCH", enum: ["MATCH", "UNRELATED"] })
  @IsIn(["MATCH", "UNRELATED"])
  contentMode: "MATCH" | "UNRELATED" = "MATCH";
}

export class ReviewPublicationDto {
  @IsIn(["VERIFIED", "REJECTED"])
  decision!: "VERIFIED" | "REJECTED";

  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;

  @ApiPropertyOptional({ description: "医疗人工复核：公开笔记的实际发布者平台 ID" })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{6,100}$/u)
  authorId?: string;

  @ApiPropertyOptional({ description: "医疗人工复核：核对员工与公开发布者归属的依据" })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(4, 500)
  authorEvidence?: string;
}

export class LateCorrectPublicationDto extends SubmitPublicationDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class RetryPublicationVerificationDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class IngestPublicationMetricsDto {
  @Transform(trimString)
  @IsString()
  @Length(8, 180)
  canonicalKey!: string;

  @IsDateString()
  observedAt!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(720)
  windowHours?: number;

  @Transform(trimString)
  @IsOptional()
  @ApiProperty({ default: "HERMES", type: String })
  @IsString()
  @Length(2, 80)
  source = "HERMES";

  @ApiPropertyOptional({
    description: "精确阅读数；未获取或页面仅显示近似值时留空或传 null",
    nullable: true,
    type: Number,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  views?: number | null;

  @ApiPropertyOptional({
    description: "精确点赞数；未知时留空或传 null",
    nullable: true,
    type: Number,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  likes?: number | null;

  @ApiPropertyOptional({
    description: "精确评论总数；未知时留空或传 null",
    nullable: true,
    type: Number,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  comments?: number | null;

  @ApiPropertyOptional({
    description: "精确收藏总数；未知时留空或传 null",
    nullable: true,
    type: Number,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  favorites?: number | null;

  @ApiPropertyOptional({
    description: "精确分享数；未知时留空或传 null",
    nullable: true,
    type: Number,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  shares?: number | null;

  @ApiPropertyOptional({
    description: "仅允许各指标的精度与短数字展示文本；不得传输登录态或页面原文",
    type: IngestMetricMetadataDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => IngestMetricMetadataDto)
  rawData?: IngestMetricMetadataDto;
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}
