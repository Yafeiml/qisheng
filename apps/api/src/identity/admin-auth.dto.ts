import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Length, Matches } from "class-validator";
import { ProtectedSmsRequestDto } from "./sms-security.dto";

export class RequestAdminCodeDto extends ProtectedSmsRequestDto {
  @ApiProperty({ example: "13800000000", pattern: "^1[3-9]\\d{9}$" })
  @Transform(trimString)
  @IsString()
  @Matches(/^1[3-9]\d{9}$/u)
  phone!: string;
}

export class LoginAdminDto {
  @ApiProperty({ example: "13800000000", pattern: "^1[3-9]\\d{9}$" })
  @Transform(trimString)
  @IsString()
  @Matches(/^1[3-9]\d{9}$/u)
  phone!: string;

  @ApiProperty({ example: "000000", maxLength: 6, minLength: 6 })
  @Transform(trimString)
  @IsString()
  @Length(6, 6)
  code!: string;
}

export class PasswordLoginDto extends ProtectedSmsRequestDto {
  @ApiProperty({ minLength: 3, maxLength: 64 })
  @Transform(trimString)
  @IsString()
  @Length(3, 64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u)
  username!: string;

  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @Length(12, 128)
  password!: string;
}

export class PasswordRegisterDto extends PasswordLoginDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @Length(1, 100)
  name!: string;

  @ApiProperty({ minLength: 1, maxLength: 160, required: false })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(1, 160)
  workspaceName?: string;

  @ApiProperty({ pattern: "^[A-Za-z0-9_-]{43}$", required: false })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/u)
  invitationToken?: string;
}

export class InitializeInstallationDto {
  @ApiProperty({ minLength: 3, maxLength: 64 })
  @Transform(trimString)
  @IsString()
  @Length(3, 64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u)
  username!: string;

  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @Length(12, 128)
  password!: string;

  @ApiProperty({ minLength: 1, maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @Length(1, 100)
  name!: string;

  @ApiProperty({ minLength: 2, maxLength: 160 })
  @Transform(trimString)
  @IsString()
  @Length(2, 160)
  organizationName!: string;

  @ApiProperty({ enum: ["SINGLE_ENTERPRISE", "GROUP"] })
  @IsIn(["SINGLE_ENTERPRISE", "GROUP"])
  organizationType!: "SINGLE_ENTERPRISE" | "GROUP";

  @ApiProperty({ minLength: 32, maxLength: 256 })
  @Transform(trimString)
  @IsString()
  @Length(32, 256)
  installationToken!: string;
}

export class InstallationStatusDto {
  @ApiProperty()
  initialized!: boolean;
}

export class AdminCodeResponseDto {
  @ApiProperty({ example: 60, description: "服务器规定的重发等待秒数" })
  retryAfterSeconds!: number;

  @ApiProperty({ example: "DEVELOPMENT_ADAPTER" })
  delivery!: string;

  @ApiProperty({ example: "000000", required: false })
  developmentCode?: string;

  @ApiProperty({ example: 300 })
  expiresInSeconds!: number;

  @ApiProperty({ example: "138****0000" })
  phoneMasked!: string;
}

export class AdminTokenResponseDto {
  @ApiProperty({ description: "Short-lived JWT access token" })
  accessToken!: string;

  @ApiProperty({ enum: ["xhs-saas-admin"] })
  audience!: "xhs-saas-admin";

  @ApiProperty({ example: 900 })
  expiresInSeconds!: number;

  @ApiProperty({ format: "date-time" })
  refreshExpiresAt!: Date;

  @ApiProperty({ format: "uuid" })
  sessionId!: string;

  @ApiProperty({ enum: ["Bearer"] })
  tokenType!: "Bearer";
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}
