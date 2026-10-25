import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsDefined, IsString, IsUrl, Length, MaxLength } from "class-validator";

export class SaveMiniappDebugSettingsDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  @MaxLength(59)
  phones!: string;

  @IsString()
  @MaxLength(199)
  ips!: string;

  @IsString()
  @MaxLength(20)
  until!: string;

  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class UpdatePlatformSettingDto {
  @ApiProperty({
    oneOf: [
      { type: "string" },
      { type: "number" },
      { type: "integer" },
      { type: "boolean" },
      { nullable: true, type: "string" },
    ],
  })
  @IsDefined()
  value!: unknown;

  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class TestPlatformStorageDto {
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class TestPlatformContentSafetyDto {
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class TestPlatformPublicationVerificationDto {
  @IsString()
  @Length(2, 500)
  reason!: string;

  @IsString()
  @IsUrl({ require_protocol: true })
  @Length(8, 2000)
  url!: string;
}

export class ApplyPlatformStorageLifecycleDto {
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class RegisterPublicationPolicyEvidenceDto {
  @IsString()
  @MaxLength(131072)
  acceptanceReportJson!: string;

  @IsString()
  @Length(2, 500)
  reason!: string;
}
