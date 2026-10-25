import { Transform } from "class-transformer";
import { IsDateString, IsIn, IsOptional, IsString, Length, MaxLength } from "class-validator";

export class CreateManagementActionDto {
  @Transform(trimString)
  @IsString()
  @Length(2, 200)
  title!: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  assignee?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  campaignId?: string;

  @IsOptional()
  @IsDateString()
  dueAt?: string;
}

export class UpdateManagementActionDto {
  @IsOptional()
  @IsIn(["OPEN", "IN_PROGRESS", "RESOLVED"])
  status?: "OPEN" | "IN_PROGRESS" | "RESOLVED";

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  assignee?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;

  @IsOptional()
  @IsDateString()
  dueAt?: string;
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}
