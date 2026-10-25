import { Transform } from "class-transformer";
import { ArrayMaxSize, IsArray, IsOptional, IsString, Length } from "class-validator";
import { ProtectedSmsRequestDto } from "./sms-security.dto";

export class RequestEmployeeCodeDto extends ProtectedSmsRequestDto {
  @Transform(trimString)
  @IsString()
  @Length(11, 32)
  phone!: string;
}

export class BindEmployeeDto {
  @Transform(trimString)
  @IsString()
  @Length(11, 32)
  phone!: string;

  @Transform(trimString)
  @IsString()
  @Length(6, 6)
  code!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  enterpriseIds?: string[];
}

export class VerifyEmployeeCodeDto {
  @Transform(trimString)
  @IsString()
  @Length(11, 32)
  phone!: string;

  @Transform(trimString)
  @IsString()
  @Length(6, 6)
  code!: string;
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}
