import { ApiProperty } from "@nestjs/swagger";
import { GeoEntityType, MaterialType, SensitiveSeverity } from "@xhs-agentic/database";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

export class MedicalMaterialDto {
  @Equals("medical-material-v1")
  schemaVersion!: "medical-material-v1";

  @IsIn(["ANSWER_EVIDENCE", "REAL_SCENE", "ARCHIVE"])
  purpose!: "ANSWER_EVIDENCE" | "REAL_SCENE" | "ARCHIVE";

  @IsOptional()
  @IsIn(["ENVIRONMENT", "ROUTE", "OBJECT", "WORKSPACE", "OTHER"])
  sceneType?: "ENVIRONMENT" | "ROUTE" | "OBJECT" | "WORKSPACE" | "OTHER";

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  question?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(2, 1000)
  sourceNote?: string;

  @IsOptional()
  @IsBoolean()
  privacyConfirmed?: boolean;
}

export class MedicalMaterialInputDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => MedicalMaterialDto)
  medicalMaterial?: MedicalMaterialDto;

  @IsOptional()
  @IsObject()
  structuredFacts?: Record<string, unknown>;
}

export class CreateMaterialDto extends MedicalMaterialInputDto {
  @IsEnum(MaterialType)
  type!: MaterialType;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(2, 200)
  title?: string;

  @Transform(trimString)
  @IsString()
  @Length(2, 50_000)
  content!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(1000)
  sourceUrl?: string;

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @Equals(true)
  authorizationConfirmed!: boolean;
}

export class CreateMaterialUploadIntentDto extends MedicalMaterialInputDto {
  @IsOptional()
  @IsIn(["REFERENCE", "LOGO"])
  usage?: "REFERENCE" | "LOGO";

  @IsIn(["DOCUMENT", "IMAGE_REFERENCE"])
  type!: "DOCUMENT" | "IMAGE_REFERENCE";

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(2, 200)
  title?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(5000)
  supplement?: string;

  @Transform(trimString)
  @IsString()
  @Length(1, 255)
  fileName!: string;

  @Transform(trimString)
  @IsString()
  @Length(3, 160)
  mimeType!: string;

  @IsInt()
  @Min(1)
  @Max(26_214_400)
  byteSize!: number;

  @Matches(/^[0-9a-f]{64}$/u)
  checksum!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  supersedesId?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  changeNote?: string;

  @Equals(true)
  authorizationConfirmed!: boolean;
}

export class MaterialRevisionFileDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsIn(["REFERENCE", "LOGO"])
  usage?: "REFERENCE" | "LOGO";

  @IsString()
  @Length(1, 255)
  fileName!: string;

  @IsString()
  @Length(3, 160)
  mimeType!: string;

  @IsInt()
  @Min(1)
  @Max(26_214_400)
  byteSize!: number;

  @Matches(/^[0-9a-f]{64}$/u)
  checksum!: string;
}

export class MaterialAttachmentDescriptionDto {
  @IsString()
  @Length(1, 64)
  artifactId!: string;

  @IsString()
  @MaxLength(5000)
  description!: string;

  @IsOptional()
  @IsIn(["REFERENCE", "LOGO"])
  usage?: "REFERENCE" | "LOGO";
}

export class CreateMaterialRevisionDto extends MedicalMaterialInputDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  removeArtifactIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MaterialAttachmentDescriptionDto)
  attachmentDescriptions?: MaterialAttachmentDescriptionDto[];

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MaterialRevisionFileDto)
  files!: MaterialRevisionFileDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  restoreArtifactIds?: string[];

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(5000)
  supplement?: string;

  @Equals(true)
  authorizationConfirmed!: boolean;
}

export class CompleteMaterialUploadDto {
  @Equals(true)
  uploadCompleted!: boolean;
}

export class SupplementMaterialDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 5000)
  supplement!: string;
}

export class CreateMaterialLinkDto extends MedicalMaterialInputDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 200)
  title!: string;

  @IsUrl({ require_protocol: true })
  @MaxLength(1000)
  sourceUrl!: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(20_000)
  content?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  supersedesId?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  changeNote?: string;

  @Equals(true)
  authorizationConfirmed!: boolean;
}

export class RetryMaterialIngestionDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class BulkTextMaterialItemDto extends MedicalMaterialInputDto {
  @Transform(trimString)
  @IsString()
  @Length(1, 100)
  rowKey!: string;

  @Transform(trimString)
  @IsString()
  @Length(2, 200)
  title!: string;

  @Transform(trimString)
  @IsString()
  @Length(2, 50_000)
  content!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  tags?: string[];
}

export class BulkCreateTextMaterialsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => BulkTextMaterialItemDto)
  rows!: BulkTextMaterialItemDto[];

  @IsBoolean()
  @ApiProperty({ default: true, type: Boolean })
  dryRun = true;

  @Equals(true)
  authorizationConfirmed!: boolean;
}

export class ImportSensitiveRulesCsvDto {
  @IsString()
  @Length(10, 200_000)
  csv!: string;

  @IsBoolean()
  @ApiProperty({ default: true, type: Boolean })
  dryRun = true;
}

export class CreateSensitiveRuleDto {
  @Transform(trimString)
  @IsString()
  @Length(1, 200)
  term!: string;

  @IsEnum(SensitiveSeverity)
  severity!: SensitiveSeverity;

  @Transform(trimString)
  @IsString()
  @Length(2, 80)
  riskType!: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  replacementSuggestion?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;
}

export class CreateGeoEntityDto {
  @IsEnum(GeoEntityType)
  type!: GeoEntityType;

  @Transform(trimString)
  @IsString()
  @Length(2, 200)
  name!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  aliases?: string[];

  @IsOptional()
  @IsObject()
  facts?: Record<string, unknown>;
}

export class CreateGeoTopicDto {
  @Transform(trimString)
  @IsString()
  entityId!: string;

  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  question!: string;

  @Transform(trimString)
  @IsString()
  @Length(2, 100)
  intent!: string;

  @IsInt()
  @ApiProperty({ default: 0, type: Number })
  @Min(0)
  @Max(100)
  priority = 0;
}

export class PublishMaterialVersionDto extends CreateMaterialDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  changeNote!: string;
}

export class PublishSensitiveRuleVersionDto extends CreateSensitiveRuleDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  changeNote!: string;
}

export class PublishGeoEntityVersionDto extends CreateGeoEntityDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  changeNote!: string;
}

export class PublishGeoTopicVersionDto extends CreateGeoTopicDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  changeNote!: string;
}

export class DisableContentDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}
