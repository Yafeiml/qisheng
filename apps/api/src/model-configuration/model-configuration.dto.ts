import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ModelCapability,
  ModelProviderProtocol,
  ModelRouteScopeType,
  ModelTier,
} from "@xhs-agentic/database";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";

export class CreateModelProviderDto {
  @Transform(upperTrimmedString)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,79}$/u)
  code!: string;

  @Transform(trimString)
  @IsString()
  @Length(2, 120)
  name!: string;

  @Transform(trimString)
  @IsString()
  @Length(4, 1000)
  baseUrl!: string;

  @Transform(trimString)
  @IsOptional()
  @ApiPropertyOptional({ description: "仅写入；平台不会回传该值。", writeOnly: true })
  @IsString()
  @Length(4, 2000)
  apiKey?: string;

  @IsOptional()
  @ApiPropertyOptional({ default: 60_000, type: Number })
  @IsInt()
  @Min(1000)
  @Max(600_000)
  timeoutMs = 60_000;

  @IsOptional()
  @ApiPropertyOptional({ default: false, type: Boolean })
  @IsBoolean()
  synthetic = false;

  @IsOptional()
  @IsEnum(ModelProviderProtocol)
  protocol?: ModelProviderProtocol;
}

export class QualifyModelRouteDto {
  @ApiPropertyOptional({
    description: "默认同时验证文案与生图；false 仅验证文案，供原图和本地问题卡使用",
  })
  @IsOptional()
  @IsBoolean()
  requiresImage?: boolean;
}

export class RotateModelProviderCredentialDto {
  @Transform(trimString)
  @ApiProperty({ description: "仅写入；平台不会回传该值。", writeOnly: true })
  @IsString()
  @Length(4, 2000)
  apiKey!: string;

  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class RevokeModelProviderCredentialDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class ResetModelProviderCircuitDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class UpdateModelProviderDto {
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(4, 1000)
  baseUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(600_000)
  timeoutMs?: number;

  @IsOptional()
  @IsIn(["ACTIVE", "DISABLED"])
  status?: "ACTIVE" | "DISABLED";

  @IsOptional()
  @ApiPropertyOptional({ default: false, type: Boolean })
  @IsBoolean()
  emergency = false;

  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class UpdateModelDefinitionDto {
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 160)
  displayName?: string;

  @IsOptional()
  @IsIn(["ACTIVE", "DISABLED"])
  status?: "ACTIVE" | "DISABLED";

  @IsOptional()
  @ApiPropertyOptional({ default: false, type: Boolean })
  @IsBoolean()
  emergency = false;

  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class CreateModelDefinitionDto {
  @Transform(upperTrimmedString)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,99}$/u)
  code!: string;

  @Transform(trimString)
  @IsString()
  @Length(2, 160)
  displayName!: string;

  @Transform(trimString)
  @IsString()
  @Length(1, 200)
  externalModelId!: string;

  @IsArray()
  @ArrayMaxSize(5)
  @IsEnum(ModelCapability, { each: true })
  capabilities!: ModelCapability[];

  @IsOptional()
  @IsEnum(ModelTier)
  tier: ModelTier = ModelTier.STANDARD;

  @IsOptional()
  @ApiPropertyOptional({ default: false, type: Boolean })
  @IsBoolean()
  synthetic = false;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ConfigureModelRouteDto {
  @IsIn([ModelRouteScopeType.PLATFORM, ModelRouteScopeType.TENANT, ModelRouteScopeType.ENTERPRISE])
  scopeType!: ModelRouteScopeType;

  @Transform(trimString)
  @IsString()
  @Length(1, 64)
  scopeId!: string;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  enterpriseId?: string;

  @IsString()
  textModelId!: string;

  @IsString()
  imageModelId!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  textFallbackModelIds: string[] = [];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  imageFallbackModelIds: string[] = [];

  @IsOptional()
  @ApiPropertyOptional({ default: 2, type: Number })
  @IsInt()
  @Min(1)
  @Max(5)
  maxAttemptsPerModel = 2;
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}

function upperTrimmedString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim().toLocaleUpperCase() : value;
}
