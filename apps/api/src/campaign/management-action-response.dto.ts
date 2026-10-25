import { ApiProperty } from "@nestjs/swagger";

export class ManagementActionCampaignDto {
  id!: string;
  title!: string;
}

export class ManagementActionResponseDto {
  @ApiProperty({ nullable: true, type: String })
  assignee!: string | null;

  @ApiProperty({ nullable: true, type: ManagementActionCampaignDto })
  campaign!: ManagementActionCampaignDto | null;

  @ApiProperty({ nullable: true, type: String })
  campaignId!: string | null;

  createdAt!: string;
  createdBy!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ nullable: true, type: String })
  dueAt!: string | null;

  enterpriseId!: string;
  id!: string;

  @ApiProperty({ nullable: true, type: String })
  note!: string | null;

  @ApiProperty({ nullable: true, type: String })
  resolvedAt!: string | null;

  status!: "IN_PROGRESS" | "OPEN" | "RESOLVED";
  tenantId!: string;
  title!: string;
  updatedAt!: string;
}
