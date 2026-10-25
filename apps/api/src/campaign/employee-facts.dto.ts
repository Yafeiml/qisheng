import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsInt, IsOptional, Min, ValidateIf } from "class-validator";

export class EmployeeFactsDto {
  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  revision!: number;

  @IsBoolean()
  confirmed!: boolean;

  @ApiPropertyOptional({ enum: ["FACTS_MISMATCH", "MATERIAL_PRIVACY", "PUBLISHING_CHANGED"] })
  @ValidateIf((input: EmployeeFactsDto) => !input.confirmed || input.reason !== undefined)
  @IsIn(["FACTS_MISMATCH", "MATERIAL_PRIVACY", "PUBLISHING_CHANGED"])
  reason?: "FACTS_MISMATCH" | "MATERIAL_PRIVACY" | "PUBLISHING_CHANGED";
}

export class EmployeeTaskPermissionDto {
  @IsIn(["COPY", "DOWNLOAD"])
  type!: "COPY" | "DOWNLOAD";

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  revision?: number;
}
