import { ApiProperty } from "@nestjs/swagger";

export class PromptTemplateResponseDto {
  @ApiProperty({ nullable: true, type: String })
  contentDirection!: string | null;

  @ApiProperty({ nullable: true, type: String })
  contentDirectionPresetId!: string | null;

  content!: string;
  createdAt!: string;
  createdBy!: string;
  enterpriseId!: string;
  id!: string;
  name!: string;
  status!: "ACTIVE" | "DISABLED";
  tenantId!: string;
  updatedAt!: string;
}

export class CampaignTemplateResponseDto {
  @ApiProperty({ additionalProperties: true, nullable: true, type: "object" })
  selectionSnapshot!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: String })
  contentDirection!: string | null;

  @ApiProperty({ nullable: true, type: String })
  contentDirectionPresetId!: string | null;

  createdAt!: string;
  createdBy!: string;
  enterpriseId!: string;
  id!: string;
  imageCount!: number;

  @ApiProperty({ nullable: true, type: String })
  imageStyle!: string | null;

  @ApiProperty({ nullable: true, type: String })
  imageStylePresetId!: string | null;

  name!: string;
  prompt!: string;

  @ApiProperty({ nullable: true, type: String })
  promptTemplateId!: string | null;

  reminderOffsetsHours!: number[];
  status!: "ACTIVE" | "DISABLED";
  tenantId!: string;
  title!: string;
  updatedAt!: string;
}

export class CampaignDraftResponseDto {
  createdAt!: string;
  createdBy!: string;
  enterpriseId!: string;
  id!: string;
  payload!: Record<string, unknown>;
  step!: number;
  tenantId!: string;
  updatedAt!: string;
}

export class CampaignDraftEnvelopeDto {
  @ApiProperty({ nullable: true, type: CampaignDraftResponseDto })
  draft!: CampaignDraftResponseDto | null;
}

export class ClearCampaignDraftResponseDto {
  cleared!: boolean;
}
