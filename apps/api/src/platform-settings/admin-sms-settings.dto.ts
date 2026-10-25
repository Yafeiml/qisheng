import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsOptional, IsString, Length, Matches } from "class-validator";

export class SaveAdminSmsSettingsDto {
  @ApiPropertyOptional({ writeOnly: true, description: "已保存时可省略，保留原值" })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @Length(1, 256)
  @Matches(/^\S+$/u)
  accessKeyId?: string;

  @ApiPropertyOptional({ writeOnly: true, description: "已保存时可省略，保留原值" })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @Length(1, 256)
  @Matches(/^\S+$/u)
  accessKeySecret?: string;

  @Transform(trim)
  @IsString()
  @Length(1, 80)
  signName!: string;

  @Transform(trim)
  @IsString()
  @Length(5, 64)
  @Matches(/^SMS_\d+$/u)
  templateCode!: string;
}

export class TestAdminSmsDto {
  @Transform(trim)
  @IsString()
  @Matches(/^1[3-9]\d{9}$/u)
  phone!: string;
}

export class AdminSmsSettingsResponseDto {
  accessKeyIdConfigured!: boolean;
  accessKeySecretConfigured!: boolean;
  @ApiProperty({ nullable: true, type: String })
  accessKeyIdHint!: string | null;
  signName!: string;
  templateCode!: string;
  configured!: boolean;
  enabled!: boolean;
}

export class AdminSmsTestResponseDto {
  status!: "ACCEPTED";
  provider!: "ALIYUN";
  phoneMasked!: string;
  requestId!: string;
  messageId!: string;
}

function trim({ value }: { value: unknown }) {
  return typeof value === "string" ? value.trim() : value;
}
