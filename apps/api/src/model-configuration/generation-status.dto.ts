import { ApiProperty } from "@nestjs/swagger";

export class GenerationStatusNoticeDto {
  affectedEnterpriseCount!: number;
  message!: string;
  notificationStatus!: string;
}

export class GenerationStatusResponseDto {
  checkedAt!: string;
  affectedEnterpriseCount!: number;
  @ApiProperty({ type: [GenerationStatusNoticeDto] })
  notices!: GenerationStatusNoticeDto[];
}

export class ModelIncidentRetryResponseDto {
  queued!: boolean;
}
