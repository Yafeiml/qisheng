import { ApiProperty } from "@nestjs/swagger";

export class GenerationPreflightCheckDto {
  code!: string;
  description!: string;

  @ApiProperty({ enum: ["BLOCKING", "PASSED", "WARNING"] })
  status!: "BLOCKING" | "PASSED" | "WARNING";

  title!: string;
}

export class GenerationPreflightAudienceDto {
  employeeCount!: number;
  imageCountPerEmployee!: number;
  totalImageCount!: number;
}

export class GenerationPreflightCapabilitiesDto {
  imagesPerDistribution!: number;
}

export class GenerationPreflightResponseDto {
  audience!: GenerationPreflightAudienceDto;
  capabilities!: GenerationPreflightCapabilitiesDto | null;
  checkedAt!: string;
  checks!: GenerationPreflightCheckDto[];

  @ApiProperty({ enum: ["DELAYED", "IMMEDIATE", "NORMAL"] })
  estimatedWaitLevel!: "DELAYED" | "IMMEDIATE" | "NORMAL";
  ready!: boolean;

  @ApiProperty({ enum: ["AVAILABLE", "UNAVAILABLE"] })
  serviceStatus!: "AVAILABLE" | "UNAVAILABLE";
}

export class PlatformGenerationPreflightRouteDto {
  configurationFingerprint!: string;
  imageModelId!: string;
  imageProviderId!: string;

  @ApiProperty({ nullable: true, type: String })
  qualificationExpiresAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  qualificationId!: string | null;

  routeId!: string;
  scopeId!: string;
  scopeType!: string;
  synthetic!: boolean;
  textModelId!: string;
  textProviderId!: string;
}

export class PlatformGenerationPreflightQueueDto {
  active!: number;
  backlog!: number;
  delayed!: number;
  failed!: number;
  paused!: boolean;
  waiting!: number;
  workers!: number;
}

export class PlatformGenerationPreflightResponseDto extends GenerationPreflightResponseDto {
  costCurrency!: string;

  @ApiProperty({ enum: ["DEVELOPMENT", "PRODUCTION"] })
  deliveryMode!: "DEVELOPMENT" | "PRODUCTION";

  @ApiProperty({ type: Number })
  estimatedCost!: number;

  queue!: PlatformGenerationPreflightQueueDto;

  @ApiProperty({ nullable: true, type: PlatformGenerationPreflightRouteDto })
  route!: PlatformGenerationPreflightRouteDto | null;
}
