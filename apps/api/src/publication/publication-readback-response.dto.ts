import { ApiProperty } from "@nestjs/swagger";

export class ReadbackJobResponseDto {
  id!: string;
  noteId!: string;
  dueAt!: string;
  leaseToken!: string;
  leaseExpiresAt!: string;
}

export class ReadbackStatusResponseDto {
  paused!: boolean;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;
}

export class ReadbackClaimResponseDto extends ReadbackStatusResponseDto {
  @ApiProperty({ nullable: true, type: ReadbackJobResponseDto })
  job!: ReadbackJobResponseDto | null;
}

export class ReadbackManagedProviderDto {
  @ApiProperty()
  endpoint!: string;
  @ApiProperty({ description: "仅签名同机节点的已领取工作单可获得供应商凭据" })
  token!: string;
}

export class ReadbackManagedClaimResponseDto extends ReadbackClaimResponseDto {
  @ApiProperty({ nullable: true, type: ReadbackManagedProviderDto })
  provider!: ReadbackManagedProviderDto | null;
}

export class ReadbackConfigurationResponseDto {
  @ApiProperty()
  enabled!: boolean;
  @ApiProperty()
  endpoint!: string;
  @ApiProperty()
  tokenConfigured!: boolean;
  @ApiProperty()
  verified!: boolean;
  @ApiProperty()
  managedNodeConfigured!: boolean;
  @ApiProperty()
  externalMode!: boolean;
}

export class ReadbackConfigurationTestResponseDto {
  @ApiProperty()
  success!: boolean;
  @ApiProperty()
  checkedAt!: string;
  @ApiProperty()
  message!: string;
}

export class ReadbackHealthResponseDto extends ReadbackStatusResponseDto {
  overdueJobs!: number;
  dueRecent!: number;
  completedRecent!: number;

  @ApiProperty({ nullable: true, type: String })
  alert!: string | null;
}

export class ReadbackResultResponseDto {
  status!: string;

  @ApiProperty({ required: false, type: Boolean })
  alreadyAccepted?: boolean;
}

export class ReadbackOperationsJobDto {
  id!: string;
  status!: string;
  attempts!: number;
  createdAt!: string;
  dueAt!: string;
  updatedAt!: string;

  @ApiProperty({ nullable: true, type: String })
  completedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  errorCode!: string | null;

  @ApiProperty({ nullable: true, type: String })
  leaseOwner!: string | null;
}

export class ReadbackBudgetDayDto {
  day!: string;
  used!: number;
}

export class ReadbackOperationsResponseDto extends ReadbackStatusResponseDto {
  today!: string;
  dailyLimit!: number;
  total!: number;
  queued!: number;
  retrying!: number;
  leased!: number;
  completed!: number;
  needsReview!: number;

  @ApiProperty({ type: [ReadbackBudgetDayDto] })
  budget!: ReadbackBudgetDayDto[];

  @ApiProperty({ type: [ReadbackOperationsJobDto] })
  jobs!: ReadbackOperationsJobDto[];
}

export class ReadbackNodeResponseDto {
  id!: string;
  online!: boolean;

  @ApiProperty({ nullable: true, type: String })
  lastSeenAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  panelHost!: string | null;

  @ApiProperty({ nullable: true, type: String })
  panelUrl!: string | null;
}

export class ReadbackAdminOperationsResponseDto extends ReadbackOperationsResponseDto {
  onlineNodes!: number;

  @ApiProperty({ type: [ReadbackNodeResponseDto] })
  nodes!: ReadbackNodeResponseDto[];
}
