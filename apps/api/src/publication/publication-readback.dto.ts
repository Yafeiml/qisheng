import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export class SaveReadbackConfigurationDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  @Length(0, 8192)
  endpoint!: string;

  @IsOptional()
  @IsString()
  @Length(0, 4096)
  token?: string;

  @IsString()
  @Length(2, 160)
  reason!: string;
}

export class TestReadbackConfigurationDto {
  @IsString()
  @Length(6, 8192)
  noteUrl!: string;

  @IsString()
  @Length(2, 160)
  reason!: string;
}

export class ReadbackClaimDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1)
  limit?: number;
}

export class ReadbackNoteDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{6,128}$/u)
  noteId!: string;

  @IsString()
  @Length(0, 500)
  title!: string;

  @IsString()
  @Length(0, 20000)
  body!: string;

  @IsOptional()
  @IsString()
  @Length(1, 128)
  @Matches(/^[A-Za-z0-9_-]{6,100}$/u)
  authorId?: string | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  publishedAt?: string | null;

  @IsInt()
  @Min(0)
  @Max(40)
  imageCount!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  likes?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  comments?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  favorites?: number | null;

  @IsOptional()
  @IsArray()
  @Length(0, 80, { each: true })
  @IsString({ each: true })
  hashtags?: string[];
}

export class ReadbackResultDto {
  @IsUUID()
  leaseToken!: string;

  @IsIn([
    "AVAILABLE",
    "RETRYABLE",
    "AUTH_ERROR",
    "INVALID_REQUEST",
    "UNCONFIRMED",
    "PARSER_CHANGED",
  ])
  status!:
    | "AVAILABLE"
    | "RETRYABLE"
    | "AUTH_ERROR"
    | "INVALID_REQUEST"
    | "UNCONFIRMED"
    | "PARSER_CHANGED";

  @IsString()
  @Length(3, 80)
  @Matches(/^[A-Z][A-Z0-9_]*$/u)
  source!: string;

  @IsString()
  @Length(2, 80)
  @Matches(/^[A-Z][A-Z0-9_]*$/u)
  code!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ReadbackNoteDto)
  note?: ReadbackNoteDto;

  @IsOptional()
  @IsISO8601({ strict: true })
  observedAt?: string;
}

export class ReadbackResumeDto {
  @IsString()
  @Length(2, 160)
  reason!: string;
}

export class ReadbackDailyLimitDto {
  @IsInt()
  @Min(1)
  @Max(10000)
  dailyLimit!: number;

  @IsString()
  @Length(2, 160)
  reason!: string;
}
