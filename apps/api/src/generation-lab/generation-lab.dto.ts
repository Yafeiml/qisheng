import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from "class-validator";
import { MedicalSelectionInputDto } from "../campaign/medical-selection.dto";

export class LabCheckDto extends MedicalSelectionInputDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @ArrayUnique()
  @IsString({ each: true })
  membershipIds?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsString({ each: true })
  referenceArtifactIds?: string[];
  @IsString() @Length(1, 100) enterpriseId!: string;
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(2, 200)
  title!: string;
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsOptional()
  @IsString()
  @Length(4, 6000)
  brief?: string;
  @IsOptional() @IsString() @Length(0, 1000) keywords?: string;
  @IsOptional() @IsString() @Length(1, 64) contentDirectionPresetId?: string;
  @IsOptional() @IsString() @Length(1, 64) imageStylePresetId?: string;
}
export class LabCopyDto {
  @IsString() @Length(4, 100) title!: string;
  @IsString() @Length(1, 3000) body!: string;
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  hashtags!: string[];
  @IsString() @Length(4, 1800) imagePrompt!: string;
}
export class LabExecuteDto {
  @IsIn(["COPY", "IMAGE", "FULL"]) action!: "COPY" | "IMAGE" | "FULL";
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  referenceArtifactIds!: string[];
  @IsOptional() @IsString() @Length(0, 100) logoArtifactId?: string;
  @IsOptional() @ValidateNested() @Type(() => LabCopyDto) copy?: LabCopyDto;
  @IsOptional() @IsString() @Length(0, 4000) copyBasePrompt?: string;
  @IsOptional() @IsString() @Length(0, 4000) imageBasePrompt?: string;
  @IsOptional() @IsString() @Length(0, 3000) contentDirectionPrompt?: string;
  @IsOptional() @IsString() @Length(0, 3000) imageStylePrompt?: string;
}
export class LabUploadDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(2, 1000)
  description!: string;
}
export class LabPromoteDto {
  @IsIn(["CONTENT", "IMAGE", "GLOBAL", "TEMPLATE"]) kind!:
    | "CONTENT"
    | "IMAGE"
    | "GLOBAL"
    | "TEMPLATE";
  @IsString() @Length(2, 60) name!: string;
  @IsInt() @Min(0) version!: number;
}
export class LabRunResponseDto {
  id!: string;
  title!: string;
  status!: string;
  action!: string;
  enterpriseId!: string;
  parentId!: string | null;
  reviewStatus!: string;
  error!: string | null;
  createdAt!: string;
  @ApiProperty({ type: Object, additionalProperties: true }) input!: Record<string, unknown>;
  @ApiPropertyOptional({ type: Object, additionalProperties: true }) result?: Record<
    string,
    unknown
  > | null;
  @ApiPropertyOptional({ type: Object, additionalProperties: true }) review?: Record<
    string,
    unknown
  > | null;
  @ApiProperty({ type: "array", items: { type: "object", additionalProperties: true } })
  assets!: Record<string, unknown>[];
  @ApiProperty({ type: "array", items: { type: "object", additionalProperties: true } })
  calls!: Record<string, unknown>[];
}
