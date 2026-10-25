import { GlobalUserStatus } from "@xhs-agentic/database";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from "class-validator";

export enum GrantScopeType {
  TENANT = "TENANT",
  ENTERPRISE = "ENTERPRISE",
}

export class AdminIdentifierDto {
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(3, 64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u)
  username?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(5, 32)
  phone?: string;
}

export class GrantTenantAdminDto extends AdminIdentifierDto {
  @IsOptional()
  @IsString()
  @Length(12, 128)
  password?: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsString()
  @Length(2, 500)
  reason?: string;
}

export class GrantPlatformAdminDto extends GrantTenantAdminDto {}

export class CreateAdminUserDto extends AdminIdentifierDto {
  @IsOptional()
  @IsString()
  @Length(12, 128)
  password?: string;

  @Transform(trimString)
  @IsString()
  @Length(1, 100)
  name!: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string;

  @IsEnum(GrantScopeType)
  scopeType!: GrantScopeType;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsString()
  enterpriseId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsString({ each: true })
  roleCodes!: string[];
}

export class UpdateAdminUserProfileDto {
  @Transform(trimString)
  @IsString()
  @Length(1, 100)
  name!: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string;
}

export class AdminUserScopeQueryDto {
  @IsEnum(GrantScopeType)
  scopeType!: GrantScopeType;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsString()
  enterpriseId?: string;
}

export class GrantRoleBindingDto extends AdminIdentifierDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 80)
  roleCode!: string;

  @IsEnum(GrantScopeType)
  scopeType!: GrantScopeType;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  enterpriseId?: string;

  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class RevokeRoleBindingDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class SetPlatformAdminStatusDto extends RevokeRoleBindingDto {
  @IsEnum(GlobalUserStatus)
  status!: GlobalUserStatus;
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}

function emptyStringToUndefined({ value }: { value: unknown }): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
