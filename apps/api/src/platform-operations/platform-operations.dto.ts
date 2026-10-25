import { ApiHideProperty, ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { TenantCustomerType, TenantStatus } from "@xhs-agentic/database";
import { Transform } from "class-transformer";
import { IsEnum, IsIn, IsOptional, IsString, Length, Matches } from "class-validator";
import { CursorPaginationQueryDto } from "../http/cursor-pagination";
export const customerEnterpriseStates = ["HAS_ENTERPRISE", "NO_ENTERPRISE"] as const;
export const customerReadinessStates = ["BLOCKED", "READY"] as const;

export class CustomerListQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ maxLength: 160 })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(1, 160)
  search?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @Transform(upperTrimmedString)
  @IsOptional()
  @IsString()
  @Length(1, 64)
  enterpriseCode?: string;

  @ApiPropertyOptional({ enum: TenantCustomerType })
  @IsOptional()
  @IsEnum(TenantCustomerType)
  customerType?: TenantCustomerType;

  @ApiPropertyOptional({ enum: TenantStatus })
  @IsOptional()
  @IsEnum(TenantStatus)
  lifecycle?: TenantStatus;

  @ApiPropertyOptional({ enum: customerEnterpriseStates })
  @IsOptional()
  @IsIn(customerEnterpriseStates)
  enterpriseState?: (typeof customerEnterpriseStates)[number];

  @ApiPropertyOptional({ enum: customerReadinessStates })
  @IsOptional()
  @IsIn(customerReadinessStates)
  readiness?: (typeof customerReadinessStates)[number];
}

export class CreatePlatformCustomerNoteDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 2000)
  body!: string;

  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class CustomerLifecycleReasonDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class ProvisionCustomerDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 160)
  tenantName!: string;

  @IsEnum(TenantCustomerType)
  customerType!: TenantCustomerType;

  @Transform(trimString)
  @IsOptional()
  @ApiProperty({ default: "Asia/Shanghai", type: String })
  @IsString()
  @Length(3, 64)
  timezone = "Asia/Shanghai";

  @Transform(trimString)
  @IsString()
  @Length(2, 160)
  enterpriseName!: string;

  // Accept old clients during rollout, but the value is never used to create an enterprise.
  @ApiHideProperty()
  @Transform(upperTrimmedString)
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_-]{1,63}$/u)
  enterpriseCode?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 160)
  brandName?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 100)
  industry?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 100)
  city?: string;

  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_.-]{2,63}$/u)
  adminUsername!: string;
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}

function upperTrimmedString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim().toLocaleUpperCase() : value;
}
