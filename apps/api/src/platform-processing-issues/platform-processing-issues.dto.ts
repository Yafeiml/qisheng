import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { RetryMaterialIngestionDto } from "../content/content.dto";
import { CursorPageInfoDto } from "../http/cursor-page.dto";
import { CursorPaginationQueryDto } from "../http/cursor-pagination";

export const PROCESSING_ISSUE_STATUSES = [
  "NEEDS_ADMIN",
  "NEEDS_USER",
  "AUTO_RETRYING",
  "RESOLVED",
] as const;
export type ProcessingIssueStatus = (typeof PROCESSING_ISSUE_STATUSES)[number];
export class ProcessingIssuesQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ enum: ["ALL", ...PROCESSING_ISSUE_STATUSES], default: "NEEDS_ADMIN" })
  @IsIn(["ALL", ...PROCESSING_ISSUE_STATUSES])
  status: ProcessingIssueStatus | "ALL" = "NEEDS_ADMIN";

  @ApiPropertyOptional({ maxLength: 160 })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(160)
  search?: string;
}

export class RetryProcessingIssueDto extends RetryMaterialIngestionDto {
  @ApiPropertyOptional({
    description: "异常对应的处理任务ID，用于拒绝旧通知上的操作。",
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ingestionJobId?: string;
}

export class ProcessingIssueNamedResourceDto {
  id!: string;
  name!: string;
}

export class ProcessingIssueActorDto {
  id!: string;
  @ApiProperty({ type: String, nullable: true })
  name!: string | null;
  @ApiProperty({ type: String, nullable: true })
  phoneMasked!: string | null;
}

export class ProcessingIssueDto {
  id!: string;
  @ApiProperty({ enum: ["MATERIAL"] })
  source!: "MATERIAL";
  resourceId!: string;
  resourceTitle!: string;
  occurredAt!: string;
  tenant!: ProcessingIssueNamedResourceDto;
  @ApiProperty({ type: ProcessingIssueNamedResourceDto, nullable: true })
  enterprise!: ProcessingIssueNamedResourceDto | null;
  @ApiProperty({ type: ProcessingIssueActorDto, nullable: true })
  actor!: ProcessingIssueActorDto | null;
  @ApiProperty({ enum: PROCESSING_ISSUE_STATUSES })
  status!: ProcessingIssueStatus;
  errorCode!: string;
  @ApiProperty({ enum: ["ANALYSIS", "EMBEDDING", "FILE", "STORAGE", "SYSTEM"] })
  stage!: "ANALYSIS" | "EMBEDDING" | "FILE" | "STORAGE" | "SYSTEM";
  reason!: string;
  suggestedActions!: string[];
  attemptCount!: number;
  maxAttempts!: number;
  canRetry!: boolean;
  @ApiProperty({ type: String, nullable: true })
  settingsPath!: string | null;
  @ApiProperty({ type: String, nullable: true })
  resolutionNote!: string | null;
}

export class ProcessingIssuePageDto {
  @ApiProperty({ type: [ProcessingIssueDto] })
  items!: ProcessingIssueDto[];
  @ApiProperty({ type: CursorPageInfoDto })
  pageInfo!: CursorPageInfoDto;
}
