import { ApiHideProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { EnterpriseStatus, TenantCustomerType } from "@xhs-agentic/database";
import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from "class-validator";
import { CursorPaginationQueryDto } from "../http/cursor-pagination";

export class EnterpriseMembershipQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ enum: ["PENDING_VERIFICATION", "NORMAL", "NEEDS_REVIEW"] })
  @IsOptional()
  @IsIn(["PENDING_VERIFICATION", "NORMAL", "NEEDS_REVIEW"])
  smsNotificationStatus?: "PENDING_VERIFICATION" | "NORMAL" | "NEEDS_REVIEW";
}

export class UpdatePublisherContextDto {
  @IsIn(["ORDINARY", "UNKNOWN", "MEDICAL_KOS", "INSTITUTION"])
  category!: "ORDINARY" | "UNKNOWN" | "MEDICAL_KOS" | "INSTITUTION";
  @Transform(trimString)
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{6,100}$/u)
  authorId!: string;
  @IsDateString() validUntil!: string;
  @Transform(trimString)
  @IsString()
  @Length(4, 2000)
  evidence!: string;
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  role?: string;
  @IsBoolean() allowBrandAttribution!: boolean;
  @IsBoolean() allowPlatformConsultation!: boolean;
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class CreateTenantDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 160)
  name!: string;

  @IsEnum(TenantCustomerType)
  customerType!: TenantCustomerType;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

export class CreateIndustryDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 100)
  name!: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(6000)
  generationGuidance?: string;
}

export class UpdateIndustryGuidanceDto {
  @Transform(trimString)
  @IsString()
  @MaxLength(6000)
  generationGuidance!: string;

  @IsDateString()
  expectedUpdatedAt!: string;
}

export class CreateEnterpriseDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 160)
  name!: string;

  // Kept only for old clients; the server always allocates the enterprise code.
  @ApiHideProperty()
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  code?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(160)
  brandName?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  industry?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiHideProperty()
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Matches(/^1[3-9]\d{9}$/u)
  administratorPhone?: string;
}

export class UpdateEnterpriseDto {
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 160)
  name?: string;

  @Transform(optionalTrimString)
  @IsOptional()
  @IsString()
  @MaxLength(160)
  brandName?: string;

  @Transform(optionalTrimString)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  industry?: string;

  @Transform(optionalTrimString)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;
}

export class SetEnterpriseStatusDto {
  @IsEnum(EnterpriseStatus)
  status!: EnterpriseStatus;

  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}

function optionalTrimString({ value }: { value: unknown }): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
