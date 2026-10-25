import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

export class CreateDepartmentDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 120)
  name!: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 64)
  code?: string;
}

export class UpdateDepartmentDto {
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 64)
  code?: string;
}

export class DepartmentStatusActionDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  transferDepartmentId?: string;
}

export class ImportMembershipItemDto {
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  name!: string;

  @Transform(trimString)
  @IsString()
  @MaxLength(64)
  phone!: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  employeeNo?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentCode?: string;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(100_000)
  rowNumber?: number;
}

export class ImportMembershipsDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @IsString({ each: true })
  headers?: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportMembershipItemDto)
  members!: ImportMembershipItemDto[];

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  sourceFileName?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  previewBatchId?: string;
}

export class MembershipActionDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class ChangeMembershipPhoneDto extends MembershipActionDto {
  @Transform(trimString)
  @IsString()
  @Length(1, 64)
  phone!: string;
}

export class UpdateMembershipDto {
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  employeeNo?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string | null;

  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

export class BulkMembershipActionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  membershipIds!: string[];

  @IsIn(["DISABLE", "ENABLE", "LEAVE", "TRANSFER"])
  action!: "DISABLE" | "ENABLE" | "LEAVE" | "TRANSFER";

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string;

  @Transform(trimString)
  @IsString()
  @Length(2, 500)
  reason!: string;
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}
