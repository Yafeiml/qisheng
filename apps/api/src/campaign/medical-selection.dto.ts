import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";

export const MEDICAL_PRIORITIES = ["GEO_ACCUMULATION", "TRANSACTION", "BALANCED"] as const;
export const MEDICAL_READER_SITUATIONS = [
  "FIRST_UNDERSTANDING",
  "LONG_CONSIDERATION",
  "TIME_PLANNING",
  "BUDGET_QUESTIONS",
  "WORK_OBSERVATION",
  "LIFE_INCONVENIENCE",
] as const;
export const MEDICAL_NOTE_FORMS = [
  "QUESTION_LIST",
  "PREPARATION",
  "WORK_RECORD",
  "PERSONAL_RECORD",
  "SERVICE_INFO",
] as const;
export const MEDICAL_IMAGE_MODES = ["ORIGINAL_EDIT", "QUESTION_CARD", "ILLUSTRATION"] as const;
export const MEDICAL_CONVERSION_PATHS = [
  "NONE",
  "OFFICIAL_PROFILE",
  "PLATFORM_CONSULTATION",
] as const;

export class MedicalSelectionDto {
  @ApiProperty({ enum: ["medical-selection-v1"] })
  @IsIn(["medical-selection-v1"])
  schemaVersion!: "medical-selection-v1";
  @ApiProperty({ enum: ["GEO_AND_TRANSACTION"] })
  @IsIn(["GEO_AND_TRANSACTION"])
  objective!: "GEO_AND_TRANSACTION";
  @ApiProperty({ enum: MEDICAL_PRIORITIES })
  @IsIn(MEDICAL_PRIORITIES)
  priority!: (typeof MEDICAL_PRIORITIES)[number];
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  topicIds!: string[];
  @ApiProperty({ enum: MEDICAL_READER_SITUATIONS })
  @IsIn(MEDICAL_READER_SITUATIONS)
  readerSituation!: (typeof MEDICAL_READER_SITUATIONS)[number];
  @ApiProperty({ enum: MEDICAL_NOTE_FORMS })
  @IsIn(MEDICAL_NOTE_FORMS)
  noteForm!: (typeof MEDICAL_NOTE_FORMS)[number];
  @ApiProperty({ enum: MEDICAL_IMAGE_MODES })
  @IsIn(MEDICAL_IMAGE_MODES)
  imageMode!: (typeof MEDICAL_IMAGE_MODES)[number];
  @ApiProperty({ enum: MEDICAL_CONVERSION_PATHS })
  @IsIn(MEDICAL_CONVERSION_PATHS)
  conversionPath!: (typeof MEDICAL_CONVERSION_PATHS)[number];
  @ApiPropertyOptional({ description: "企业确认所选原图具备使用授权且隐私已处理" })
  @IsOptional()
  @IsBoolean()
  originalImageConfirmed?: boolean;
}

export class MedicalSelectionInputDto {
  @ApiPropertyOptional({ type: MedicalSelectionDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MedicalSelectionDto)
  selection?: MedicalSelectionDto;
}
