import { ApiProperty } from "@nestjs/swagger";

export class RuntimePolicyResponseDto {
  @ApiProperty({ nullable: true, type: String })
  materialAnalysisModelId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  embeddingModelId!: string | null;

  id!: string;
  providerHealthMaxAgeSeconds!: number;
  @ApiProperty({ deprecated: true, description: "历史兼容字段，功能验证不再按时间过期" })
  routeQualificationMaxAgeSeconds!: number;
  minimumGenerationWorkers!: number;
  maxQueueBacklog!: number;
  maxActiveGenerationJobs!: number;
  maxProviderConcurrentInvocations!: number;
  retrievalTopK!: number;
  retrievalMaxContextCharacters!: number;
  materialChunkSizeCharacters!: number;
  materialChunkOverlapCharacters!: number;
  retrievalStrategyVersion!: string;

  @ApiProperty({ type: Number })
  costWarningThreshold!: number;

  costCurrency!: string;
  updatedBy!: string;
  createdAt!: string;
  updatedAt!: string;
}
