import { Transform } from "class-transformer";
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from "class-validator";

export class UpdateAdminAccountDto {
  @Transform(trimString)
  @IsString()
  @Length(1, 100)
  name!: string;

  @Transform(trimString)
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

export class ConfirmAdminEmailDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/u)
  token!: string;
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}
