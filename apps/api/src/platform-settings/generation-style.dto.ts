import { ApiProperty } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from "class-validator";

export class GenerationStylePresetDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,64}$/u)
  id!: string;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 60)
  name!: string;

  @IsString()
  @Length(0, 240)
  description!: string;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(4, 3000)
  prompt!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsBoolean()
  isDefault!: boolean;
}

export class SaveGenerationStylesDto {
  @IsInt()
  @Min(0)
  version!: number;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(4, 4000)
  copyBasePrompt!: string;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(4, 4000)
  imageBasePrompt!: string;

  @ApiProperty({ type: [GenerationStylePresetDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => GenerationStylePresetDto)
  contentDirections!: GenerationStylePresetDto[];

  @ApiProperty({ type: [GenerationStylePresetDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => GenerationStylePresetDto)
  imageStyles!: GenerationStylePresetDto[];
}

export class GenerationStylesResponseDto extends SaveGenerationStylesDto {}

export class GenerationStyleOptionDto {
  id!: string;
  name!: string;
  description!: string;
  isDefault!: boolean;
}

export class GenerationStyleOptionsResponseDto {
  @ApiProperty({ type: [GenerationStyleOptionDto] })
  contentDirections!: GenerationStyleOptionDto[];

  @ApiProperty({ type: [GenerationStyleOptionDto] })
  imageStyles!: GenerationStyleOptionDto[];
}
