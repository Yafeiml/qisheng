import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from "class-validator";
export class SaveContentSafetySettingsDto {
  @IsEnum({ MODEL: "MODEL", HTTP: "HTTP", DISABLED: "DISABLED" }) mode!:
    | "MODEL"
    | "HTTP"
    | "DISABLED";
  @IsOptional() @IsString() @MaxLength(100) modelProviderId?: string;
  @IsOptional() @IsString() @MaxLength(200) model?: string;
  @IsOptional() @IsString() @MaxLength(1000) endpoint?: string;
  @IsOptional() @IsString() @MaxLength(80) provider?: string;
  @IsOptional() @IsString() @Length(4, 4096) apiKey?: string;
  @IsInt() @Min(1000) @Max(120000) timeoutMs!: number;
}
export class ContentSafetyProviderDto {
  id!: string;
  name!: string;
}
export class ContentSafetySettingsResponseDto {
  mode!: string;
  modelProviderId!: string;
  model!: string;
  provider!: string;
  endpoint!: string;
  apiKeyConfigured!: boolean;
  timeoutMs!: number;
  verified!: boolean;
  @ApiProperty({ nullable: true, type: String }) checkedAt!: string | null;
  @ApiProperty({ type: [ContentSafetyProviderDto] }) providers!: ContentSafetyProviderDto[];
}
