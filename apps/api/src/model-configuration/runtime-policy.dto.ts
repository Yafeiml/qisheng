import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, Min } from "class-validator";

export class UpdateRuntimePolicyDto {
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsString()
  materialAnalysisModelId?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsString()
  embeddingModelId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  retrievalTopK?: number;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(100_000)
  retrievalMaxContextCharacters?: number;

  @IsOptional()
  @IsInt()
  @Min(200)
  @Max(10_000)
  materialChunkSizeCharacters?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_000)
  materialChunkOverlapCharacters?: number;

  @IsOptional()
  @IsString()
  @Length(2, 120)
  retrievalStrategyVersion?: string;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(86_400)
  providerHealthMaxAgeSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(604_800)
  routeQualificationMaxAgeSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000)
  minimumGenerationWorkers?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxQueueBacklog?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxActiveGenerationJobs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxProviderConcurrentInvocations?: number;

  @IsOptional()
  @ApiPropertyOptional({ type: Number })
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 6 })
  @Min(0)
  costWarningThreshold?: number;

  @IsOptional()
  @Matches(/^[A-Z]{3,8}$/u)
  costCurrency?: string;

  @IsString()
  @Length(2, 500)
  reason!: string;
}
