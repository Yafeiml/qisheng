import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsInt, IsString, Length, Matches, Min } from "class-validator";

export class LinkEmployeeWechatIdentityDto {
  @IsString()
  @Length(1, 256)
  code!: string;
}

export class RecordEmployeeSubscriptionDto {
  @IsInt()
  @Min(1)
  identityVersion!: number;

  @IsInt()
  @Min(1)
  authorizationGeneration!: number;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,128}$/u)
  templateId!: string;

  @IsIn(["accept", "reject", "ban"])
  status!: "accept" | "reject" | "ban";
}

export class EmployeeNotificationConfigurationDto {
  enabled!: boolean;

  @ApiProperty({ nullable: true, type: String })
  appId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  templateId!: string | null;

  identityLinked!: boolean;

  @ApiProperty({ nullable: true, type: Number })
  identityVersion!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  authorizationGeneration!: number | null;

  remainingSubscriptions!: number;

  @ApiProperty({ enum: ["NONE", "ACCEPT", "REJECT", "BAN"] })
  subscriptionStatus!: "NONE" | "ACCEPT" | "REJECT" | "BAN";
}
