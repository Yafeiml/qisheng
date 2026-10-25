import { ApiProperty } from "@nestjs/swagger";

export class EnterprisePersonnelPolicyResponseDto {
  allowEnterpriseParticipationManagement!: boolean;
  allowEnterpriseSeatManagement!: boolean;
  defaultParticipationStatus!: "EXEMPT" | "PARTICIPATING" | "PAUSED" | "PENDING_REVIEW";
  enterpriseId!: string;
  tenantId!: string;
  updatedAt!: string;
  updatedBy!: string;
}

export class MembershipParticipationResponseDto {
  controlOwner!: "ENTERPRISE" | "TENANT";

  @ApiProperty({ nullable: true, type: String })
  effectiveFrom!: string | null;

  @ApiProperty({ nullable: true, type: String })
  effectiveUntil!: string | null;

  enterpriseId!: string;
  lockedByTenant!: boolean;
  membershipId!: string;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ nullable: true, type: String })
  reasonCode!: string | null;

  status!: "EXEMPT" | "PARTICIPATING" | "PAUSED" | "PENDING_REVIEW";
  tenantId!: string;
  updatedAt!: string;
  updatedBy!: string;
  version!: number;
}

export class BulkMembershipParticipationResponseDto {
  participations!: MembershipParticipationResponseDto[];
  updatedCount!: number;
}
