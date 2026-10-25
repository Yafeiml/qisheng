import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsDefined, IsOptional, IsString, Length, ValidateNested } from "class-validator";
import { UpdateModelProviderDto } from "./model-configuration.dto";
import type { ModelRouteResponseDto } from "./model-configuration-response.dto";
import type { RuntimePolicyResponseDto } from "./runtime-policy-response.dto";

export class SaveProviderConnectionDto extends UpdateModelProviderDto {
  @ApiPropertyOptional({ writeOnly: true })
  @IsOptional()
  @IsString()
  @Length(4, 2000)
  apiKey?: string;
}

export class ModelSelectionDto {
  @IsString()
  @Length(1, 64)
  providerId!: string;

  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 200)
  externalModelId!: string;
}

export class SaveModelSetupDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => ModelSelectionDto)
  textModel!: ModelSelectionDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => ModelSelectionDto)
  imageModel!: ModelSelectionDto;

  @ApiPropertyOptional({ type: ModelSelectionDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ModelSelectionDto)
  embeddingModel?: ModelSelectionDto | null;

  @ApiPropertyOptional({
    type: ModelSelectionDto,
    nullable: true,
    description: "null 表示资料理解跟随文案模型，所选文案模型需支持图片输入。",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ModelSelectionDto)
  materialAnalysisModel?: ModelSelectionDto | null;
}

export class AvailableModelDto {
  externalModelId!: string;
  displayName!: string;
  @ApiProperty({ type: [String] })
  suggestedCapabilities!: string[];
}

export class AvailableModelsResponseDto {
  providerId!: string;
  models!: AvailableModelDto[];
}

export class SaveModelSetupResponseDto {
  route!: ModelRouteResponseDto;
  runtimePolicy!: RuntimePolicyResponseDto;
}
