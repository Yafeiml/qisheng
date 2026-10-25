import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from "class-validator";

export class UpdateEnterprisePersonnelPolicyDto {
  @IsBoolean()
  allowEnterpriseParticipationManagement!: boolean;

  @IsBoolean()
  allowEnterpriseSeatManagement!: boolean;

  @IsOptional()
  @IsIn(["PENDING_REVIEW", "PARTICIPATING", "PAUSED", "EXEMPT"])
  defaultParticipationStatus?: "EXEMPT" | "PARTICIPATING" | "PAUSED" | "PENDING_REVIEW";

  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class UpdateMembershipParticipationDto {
  @IsIn(["PENDING_REVIEW", "PARTICIPATING", "PAUSED", "EXEMPT"])
  status!: "EXEMPT" | "PARTICIPATING" | "PAUSED" | "PENDING_REVIEW";

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reasonCode?: string;

  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  effectiveFrom?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  effectiveUntil?: string;

  @IsOptional()
  @IsBoolean()
  lockedByTenant?: boolean;
}

export class BulkUpdateMembershipParticipationDto extends UpdateMembershipParticipationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  membershipIds!: string[];
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}
