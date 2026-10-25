import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class GeoEffectPayloadDto {
  @Transform(trim) @IsString() @Length(1, 100) product!: string;
  @IsIn(["SEARCH", "AI"]) surface!: "SEARCH" | "AI";
  @Transform(trim) @IsString() @Length(1, 500) query!: string;
  @ApiProperty({ type: Boolean, nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsBoolean()
  brandSeen!: boolean | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 2048) citationUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 2048) evidenceUrl?: string;
  @Transform(trim) @IsString() @Length(2, 1000) source!: string;
}

export class TransactionEffectPayloadDto {
  @Transform(trim) @IsString() @Length(1, 100) channel!: string;
  @IsDateString({ strict: true }) cohortStart!: string;
  @IsDateString({ strict: true }) cohortEnd!: string;
  @IsDateString({ strict: true }) conversionWindowEnd!: string;
  @IsIn(["PAID_ORDER", "COMPLETED_SERVICE"]) definition!: "PAID_ORDER" | "COMPLETED_SERVICE";
  @IsIn(["VERIFIED", "UNKNOWN"]) dataStatus!: "VERIFIED" | "UNKNOWN";
  @ApiProperty({ type: Number, nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  leadCount!: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  consultationCount?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  appointmentCount?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  visitCount?: number | null;
  @ApiProperty({ type: Number, nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  transactionPeople!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  orderCount!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  receivedMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  refundMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  costMinor!: number | null;
  @IsIn(["CNY"]) currency!: "CNY";
  @Transform(trim) @IsString() @Length(2, 1000) source!: string;
}

export class CreateCampaignEffectDto {
  @ApiProperty({ enum: ["GEO", "TRANSACTION"] })
  @IsIn(["GEO", "TRANSACTION"])
  kind!: "GEO" | "TRANSACTION";
  @IsDateString({ strict: true }) observedAt!: string;
  @ApiProperty({
    oneOf: [
      { $ref: "#/components/schemas/GeoEffectPayloadDto" },
      { $ref: "#/components/schemas/TransactionEffectPayloadDto" },
    ],
  })
  @IsDefined()
  @ValidateNested()
  @Type((options) =>
    options?.object.kind === "GEO" ? GeoEffectPayloadDto : TransactionEffectPayloadDto,
  )
  payload!: GeoEffectPayloadDto | TransactionEffectPayloadDto;
}

export class CampaignEffectMetricsDto {
  @ApiProperty({ type: Number, nullable: true }) netReceivedMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true }) transactionRate!: number | null;
  @ApiProperty({ type: Number, nullable: true }) costPerTransactionMinor!: number | null;
  windowComplete!: boolean;
}
export class CampaignEffectObservationDto {
  id!: string;
  @ApiProperty({ enum: ["GEO", "TRANSACTION"] }) kind!: "GEO" | "TRANSACTION";
  observedAt!: string;
  @ApiProperty({
    oneOf: [
      { $ref: "#/components/schemas/GeoEffectPayloadDto" },
      { $ref: "#/components/schemas/TransactionEffectPayloadDto" },
    ],
  })
  payload!: GeoEffectPayloadDto | TransactionEffectPayloadDto;
  createdAt!: string;
  @ApiProperty({ type: CampaignEffectMetricsDto, nullable: true })
  metrics!: CampaignEffectMetricsDto | null;
}
export class CampaignEffectObservationListDto {
  @ApiProperty({ type: [CampaignEffectObservationDto] })
  items!: CampaignEffectObservationDto[];
}
