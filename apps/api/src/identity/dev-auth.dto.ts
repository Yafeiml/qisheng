import { Transform } from "class-transformer";
import { ArrayMaxSize, IsArray, IsOptional, IsString, Length } from "class-validator";

export class DevelopmentAdminTokenDto {
  @Transform(trimString)
  @IsString()
  @Length(5, 32)
  phone!: string;
}

export class DevelopmentEmployeeBindDto {
  @Transform(trimString)
  @IsString()
  @Length(5, 32)
  phone!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  enterpriseIds?: string[];
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}
