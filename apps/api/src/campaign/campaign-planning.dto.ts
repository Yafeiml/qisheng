import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
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
import { MedicalSelectionInputDto } from "./medical-selection.dto";

export class CreatePromptTemplateDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 120)
  name!: string;

  @Transform(trimString)
  @IsString()
  @Length(4, 4000)
  content!: string;

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
}

export class CreateCampaignTemplateDto extends MedicalSelectionInputDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 120)
  name!: string;

  @Transform(trimString)
  @IsString()
  @Length(2, 200)
  title!: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(4, 4000)
  prompt?: string;

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

  @IsInt()
  @Min(1)
  @Max(9)
  imageCount!: number;

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
}

export class SaveCampaignDraftDto extends MedicalSelectionInputDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  focusEntityIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  referenceArtifactIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  logoArtifactId?: string | null;

  @IsInt()
  @Min(1)
  @Max(4)
  step!: number;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(4000)
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

  @Transform(trimString)
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

export class DisablePlanningTemplateDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}
