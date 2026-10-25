import { ApiProperty } from "@nestjs/swagger";

export class ModelDefinitionResponseDto {
  capabilities!: ("EMBEDDING" | "IMAGE" | "MULTIMODAL" | "TEXT" | "VISION")[];
  code!: string;
  createdAt!: string;
  displayName!: string;
  externalModelId!: string;
  id!: string;

  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  metadata!: Record<string, unknown> | null;

  providerId!: string;
  status!: "ACTIVE" | "DISABLED";
  synthetic!: boolean;
  tier!: "ADVANCED" | "BASIC" | "PREMIUM" | "STANDARD";
  updatedAt!: string;
}

export class ModelProviderResponseDto {
  baseUrl!: string;
  circuitState!: "CLOSED" | "HALF_OPEN" | "OPEN";

  @ApiProperty({ nullable: true, type: String })
  circuitOpenedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  circuitOpenUntil!: string | null;

  code!: string;
  consecutiveHealthFailures!: number;
  createdAt!: string;
  credentialConfigured!: boolean;
  credentialHint?: string;
  credentialKeyVersion?: string;
  credentialRotatedAt?: string;
  credentialRequired!: boolean;
  healthStatus!: "HEALTHY" | "UNKNOWN" | "UNHEALTHY";
  id!: string;
  lastHealthCheckedAt?: string;
  lastHealthErrorCode?: string;
  lastHealthLatencyMs?: number;

  @ApiProperty({ nullable: true, type: String })
  lastRuntimeErrorCode!: string | null;

  @ApiProperty({ nullable: true, type: String })
  lastRuntimeFailureAt!: string | null;

  models?: ModelDefinitionResponseDto[];
  name!: string;
  protocol!: "OPENAI_COMPATIBLE" | "SYNTHETIC";
  status!: "ACTIVE" | "DISABLED";
  synthetic!: boolean;
  timeoutMs!: number;
  runtimeFailureCount!: number;
  updatedAt!: string;
}

export class ModelProviderHealthCheckResponseDto {
  checkedAt!: string;
  errorCode!: string | null;
  errorMessage!: string | null;
  healthy!: boolean;
  httpStatus!: number | null;
  id!: string;
  latencyMs!: number;
  providerId!: string;
  status!: "HEALTHY" | "UNHEALTHY";
}

export class ModelRouteQualificationResponseDto {
  checkedAt!: string;
  checkedBy!: string;
  configurationFingerprint!: string;
  deliveryMode!: "DEVELOPMENT" | "PRODUCTION";

  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  diagnostics!: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, type: String })
  errorCode!: string | null;

  @ApiProperty({ nullable: true, type: String })
  errorMessage!: string | null;

  @ApiProperty({ type: Number })
  estimatedCost!: number;

  @ApiProperty({
    nullable: true,
    type: String,
    description: "保留兼容字段；动态门禁不按时间失效，始终为 null",
  })
  expiresAt!: string | null;
  id!: string;

  @ApiProperty({ nullable: true, type: Number })
  imageLatencyMs!: number | null;

  imageModelId!: string;
  imageProviderId!: string;
  routeId!: string;
  status!: "FAILED" | "PASSED";
  storageVerified!: boolean;

  @ApiProperty({ nullable: true, type: Number })
  textLatencyMs!: number | null;

  textModelId!: string;
  textProviderId!: string;
}

export class RoutedModelDefinitionDto extends ModelDefinitionResponseDto {
  provider!: ModelProviderResponseDto;
}

export class ModelRouteRuntimeHealthResponseDto {
  @ApiProperty({ nullable: true, type: String })
  notificationStatus!: string | null;
  state!:
    | "UNOBSERVED"
    | "HEALTHY"
    | "WATCHING"
    | "REVALIDATION_REQUIRED"
    | "QUALIFICATION_REQUIRED";
  failureThreshold!: number;
  textFailures!: number;
  imageFailures!: number;
  @ApiProperty({ nullable: true, type: String })
  lastFailureAt!: string | null;
  @ApiProperty({ nullable: true, type: String })
  lastSuccessAt!: string | null;
}

export class ModelRouteResponseDto {
  createdAt!: string;
  createdBy!: string;

  @ApiProperty({ nullable: true, type: String })
  enterpriseId!: string | null;

  id!: string;
  imageFallbackModelIds!: string[];
  imageModel!: RoutedModelDefinitionDto;
  imageModelId!: string;
  maxAttemptsPerModel!: number;

  @ApiProperty({ nullable: true, type: ModelRouteQualificationResponseDto })
  qualification!: ModelRouteQualificationResponseDto | null;

  @ApiProperty({ nullable: true, type: ModelRouteRuntimeHealthResponseDto })
  runtimeHealth!: ModelRouteRuntimeHealthResponseDto | null;

  scopeId!: string;
  scopeType!: "ENTERPRISE" | "PLATFORM" | "TENANT";

  @ApiProperty({ nullable: true, type: String })
  tenantId!: string | null;

  textFallbackModelIds!: string[];
  textModel!: RoutedModelDefinitionDto;
  textModelId!: string;
  updatedAt!: string;
}

export class ModelCatalogResponseDto {
  providers!: ModelProviderResponseDto[];
  routes!: ModelRouteResponseDto[];
}
