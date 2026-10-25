import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { CampaignStatus, GenerationWorkItemStatus } from "@xhs-agentic/database";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";
import { CursorPaginationQueryDto } from "../http/cursor-pagination";
import { MedicalSelectionInputDto } from "./medical-selection.dto";

export class CreateCampaignDto extends MedicalSelectionInputDto {
  @ApiPropertyOptional({
    type: [String],
    maxItems: 20,
    description: "宣传重点；省略自动匹配，空数组不使用",
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  focusEntityIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsString({ each: true })
  referenceArtifactIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  logoArtifactId?: string | null;

  @Transform(trimString)
  @IsString()
  @Length(2, 200)
  title!: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(4, 4000)
  prompt?: string;

  @IsOptional()
  @IsDateString()
  visibleAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9)
  imageCount?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  membershipIds?: string[];

  @IsOptional()
  @IsIn(["ALL", "DEPARTMENT", "SELECTED"])
  audienceMode?: "ALL" | "DEPARTMENT" | "SELECTED";

  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contentDirection?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  contentDirectionPresetId?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  imageStyle?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  imageStylePresetId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(23, { each: true })
  reminderOffsetsHours?: number[];

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  promptTemplateId?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  campaignTemplateId?: string;
}

export class CampaignListQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: CampaignStatus })
  @IsOptional()
  @IsEnum(CampaignStatus)
  status?: CampaignStatus;

  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @IsOptional()
  @IsDateString()
  visibleFrom?: string;

  @IsOptional()
  @IsDateString()
  visibleTo?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(64)
  createdBy?: string;

  @ApiPropertyOptional({
    enum: [
      "CONTENT_COMPLIANCE",
      "INTERNAL_ERROR",
      "PLATFORM_CONFIGURATION",
      "RETRIED",
      "TEMPORARY_SERVICE",
    ],
  })
  @IsOptional()
  @IsIn([
    "CONTENT_COMPLIANCE",
    "INTERNAL_ERROR",
    "PLATFORM_CONFIGURATION",
    "RETRIED",
    "TEMPORARY_SERVICE",
  ])
  exceptionType?:
    | "CONTENT_COMPLIANCE"
    | "INTERNAL_ERROR"
    | "PLATFORM_CONFIGURATION"
    | "RETRIED"
    | "TEMPORARY_SERVICE";

  @ApiPropertyOptional({ default: "ACTIVE", enum: ["ACTIVE", "ALL", "ARCHIVED"] })
  @IsOptional()
  @IsIn(["ACTIVE", "ALL", "ARCHIVED"])
  archive = "ACTIVE" as "ACTIVE" | "ALL" | "ARCHIVED";
}

export class DashboardQueryDto {
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(64)
  campaignId?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(64)
  enterpriseId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class CampaignArchiveDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class CampaignWorkItemQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ enum: GenerationWorkItemStatus })
  @IsOptional()
  @IsEnum(GenerationWorkItemStatus)
  status?: GenerationWorkItemStatus;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(120)
  department?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(120)
  employee?: string;

  @ApiPropertyOptional({
    enum: ["CONTENT_COMPLIANCE", "INTERNAL_ERROR", "PLATFORM_CONFIGURATION", "TEMPORARY_SERVICE"],
  })
  @IsOptional()
  @IsIn(["CONTENT_COMPLIANCE", "INTERNAL_ERROR", "PLATFORM_CONFIGURATION", "TEMPORARY_SERVICE"])
  errorCategory?:
    | "CONTENT_COMPLIANCE"
    | "INTERNAL_ERROR"
    | "PLATFORM_CONFIGURATION"
    | "TEMPORARY_SERVICE";
}

export class ApproveCampaignDto {
  @IsOptional()
  @IsDateString()
  visibleAt?: string;
}

export class AcceptCampaignContentReviewDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class RegenerateCampaignContentDto {
  @ApiProperty({
    enum: ["COPY", "IMAGE", "BOTH"],
    description: "重生成范围",
  })
  @IsIn(["COPY", "IMAGE", "BOTH"])
  target!: "COPY" | "IMAGE" | "BOTH";

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(4, 1000)
  feedback?: string;

  @ApiPropertyOptional({
    enum: [
      "QUESTION_UNCLEAR",
      "TOO_MUCH_INFORMATION",
      "IMAGE_TEXT_MISMATCH",
      "FACT_UPDATE_REQUIRED",
      "AUTHORIZED_MATERIAL_CHANGE",
    ],
  })
  @IsOptional()
  @IsIn([
    "QUESTION_UNCLEAR",
    "TOO_MUCH_INFORMATION",
    "IMAGE_TEXT_MISMATCH",
    "FACT_UPDATE_REQUIRED",
    "AUTHORIZED_MATERIAL_CHANGE",
  ])
  reasonCode?:
    | "QUESTION_UNCLEAR"
    | "TOO_MUCH_INFORMATION"
    | "IMAGE_TEXT_MISMATCH"
    | "FACT_UPDATE_REQUIRED"
    | "AUTHORIZED_MATERIAL_CHANGE";
}

export class RescheduleCampaignDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;

  @IsDateString()
  visibleAt!: string;
}

export class ReopenCampaignReviewDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class CancelCampaignDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class EmployeeTaskEventDto {
  @IsIn(["COPY", "DOWNLOAD"])
  type!: "COPY" | "DOWNLOAD";
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}
