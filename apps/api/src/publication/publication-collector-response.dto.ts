import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class PublicationCollectorStatusResponseDto {
  paused!: boolean;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;
}

export class PublicationCollectionJobResponseDto {
  id!: string;
  kind!: string;
  accessUrl!: string;
  submittedAt!: string;
  dueAt!: string;
  windowHours!: number;
  leaseToken!: string;
  leaseExpiresAt!: string;
}

export class PublicationCollectionClaimResponseDto {
  paused!: boolean;

  @ApiProperty({ nullable: true, type: PublicationCollectionJobResponseDto })
  job!: PublicationCollectionJobResponseDto | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  reason?: string | null;
}

export class PublicationCollectionLeaseResponseDto {
  paused!: boolean;

  @ApiProperty({ nullable: true, type: String })
  leaseExpiresAt!: string | null;
}

export class PublicationCollectionEvidenceResponseDto {
  status!: string;

  @ApiPropertyOptional({ type: Boolean })
  paused?: boolean;

  @ApiPropertyOptional({ type: Boolean })
  alreadyAccepted?: boolean;
}

export class PublicationCollectorPausedResponseDto {
  paused!: boolean;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;
}

export class PublicationCollectorResumedResponseDto {
  paused!: boolean;
}
