import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export enum SmsPurpose {
  ADMIN_LOGIN = "ADMIN_LOGIN",
  EMPLOYEE_BIND = "EMPLOYEE_BIND",
  PASSWORD_LOGIN = "PASSWORD_LOGIN",
  PASSWORD_REGISTER = "PASSWORD_REGISTER",
}

export class CaptchaProofDto {
  @ApiProperty({ maxLength: 8192 })
  @IsString()
  @Length(1, 8192)
  token!: string;

  @ApiProperty({ type: [Number], maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(4294967295, { each: true })
  solutions!: number[];
}

export class ProtectedSmsRequestDto {
  @ApiPropertyOptional({
    type: CaptchaProofDto,
    description: "开启 Cap 验证时提供一次性验证结果",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CaptchaProofDto)
  captcha?: CaptchaProofDto;
}

export class SmsChallengeRequestDto {
  @ApiProperty({ pattern: "^1[3-9]\\d{9}$" })
  @IsString()
  @Matches(/^1[3-9]\d{9}$/u)
  phone!: string;

  @ApiProperty({ enum: SmsPurpose })
  @IsEnum(SmsPurpose)
  purpose!: SmsPurpose;
}

export class PasswordChallengeRequestDto {
  @ApiProperty({ minLength: 3, maxLength: 64 })
  @IsString()
  @Length(3, 64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u)
  username!: string;

  @ApiProperty({ enum: [SmsPurpose.PASSWORD_LOGIN, SmsPurpose.PASSWORD_REGISTER] })
  @IsEnum({
    PASSWORD_LOGIN: SmsPurpose.PASSWORD_LOGIN,
    PASSWORD_REGISTER: SmsPurpose.PASSWORD_REGISTER,
  })
  purpose!: SmsPurpose.PASSWORD_LOGIN | SmsPurpose.PASSWORD_REGISTER;
}

export class CapChallengeParametersDto {
  c!: number;
  s!: number;
  d!: number;
}

export class SmsChallengeResponseDto {
  required!: boolean;
  @ApiPropertyOptional({ type: CapChallengeParametersDto })
  challenge?: CapChallengeParametersDto;
  @ApiPropertyOptional()
  token?: string;
  @ApiPropertyOptional()
  expires?: number;
}
