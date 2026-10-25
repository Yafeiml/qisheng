import { ApiProperty } from "@nestjs/swagger";

export class PlatformSettingOptionDto {
  label!: string;
  value!: string;
}

export class PlatformSettingItemDto {
  configured!: boolean;
  description!: string;
  group!: string;
  key!: string;
  label!: string;

  @ApiProperty({ nullable: true, type: Number })
  max!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  maxLength!: number | null;

  @ApiProperty({ nullable: true, type: String })
  maskedValue!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  min!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  minLength!: number | null;

  nullable!: boolean;

  @ApiProperty({ type: [PlatformSettingOptionDto] })
  options!: PlatformSettingOptionDto[];

  restartRequired!: boolean;
  secret!: boolean;
  source!: "DATABASE" | "DEFAULT" | "ENVIRONMENT" | "UNCONFIGURED";
  step!: number;
  store!: "PLATFORM_SETTING" | "RUNTIME_POLICY";

  @ApiProperty({ nullable: true, type: String })
  unit!: string | null;

  @ApiProperty({ nullable: true, type: String })
  updatedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  updatedBy!: string | null;

  @ApiProperty({
    oneOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { nullable: true, type: "string" },
    ],
  })
  value!: boolean | number | string | null;

  valueType!: string;

  @ApiProperty({ nullable: true, type: Number })
  version!: number | null;
}

export class PlatformSettingGroupDto {
  configuredCount!: number;
  description!: string;
  group!: string;
  label!: string;
  mark!: string;

  @ApiProperty({ type: [PlatformSettingItemDto] })
  settings!: PlatformSettingItemDto[];

  slug!: string;
  totalCount!: number;
}

export class PlatformSettingsResponseDto {
  @ApiProperty({ type: [PlatformSettingGroupDto] })
  groups!: PlatformSettingGroupDto[];
}

export class PlatformStorageTestResponseDto {
  bucket!: string;
  byteSize!: number;
  checkedAt!: string;
  signedReadVerified!: boolean;
}

export class PlatformContentSafetyTestResponseDto {
  imageRiskDetected!: boolean;
  categoryCount!: number;
  checkedAt!: string;
  decision!: "BLOCK" | "PASS" | "REVIEW";
  latencyMs!: number;
  provider!: string;
}

export class PlatformPublicationVerificationTestResponseDto {
  available!: boolean;
  checkedAt!: string;
  imageCount!: number;
  latencyMs!: number;
  policyVersion!: string;
  provider!: string;
}

export class PublicationPolicyEvidenceResponseDto {
  acceptanceReportSha256!: string;
  benchmarkId!: string;
  createdAt!: string;
  id!: string;
  policyVersion!: string;
  providerCode!: string;
  reportCheckedAt!: string;
  reviewer!: string;
  sampleCount!: number;
  scoringProfileVersion!: string;
}

export class PlatformStorageLifecycleResponseDto {
  abortIncompleteMultipartUploadDays!: number | null;
  enabled!: boolean;
  noncurrentVersionExpirationDays!: number | null;
  versioning!: "DISABLED" | "ENABLED" | "SUSPENDED";
}
