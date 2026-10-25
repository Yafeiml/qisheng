import { ApiProperty } from "@nestjs/swagger";
import { IdentityNamedResourceDto } from "./identity-response.dto";

export class AdminAccountRoleDto {
  code!: string;
  name!: string;
}

export class AdminAccountScopeDto {
  @ApiProperty({ nullable: true, type: String })
  department!: string | null;

  @ApiProperty({ nullable: true, type: IdentityNamedResourceDto })
  enterprise!: IdentityNamedResourceDto | null;

  @ApiProperty({ nullable: true, type: String })
  jobTitle!: string | null;

  roles!: AdminAccountRoleDto[];
  scopeId!: string;
  scopeType!: "ENTERPRISE" | "PLATFORM" | "TENANT";

  @ApiProperty({ nullable: true, type: IdentityNamedResourceDto })
  tenant!: IdentityNamedResourceDto | null;
}

export class AdminAccountDto {
  activeSessionCount!: number;
  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  email!: string | null;

  @ApiProperty({ nullable: true, type: String, format: "date-time" })
  emailVerifiedAt!: string | null;

  id!: string;

  @ApiProperty({ nullable: true, type: String })
  lastLoginAt!: string | null;

  loginMethod!: "PASSWORD" | "SMS_CODE";

  @ApiProperty({ nullable: true, type: String })
  name!: string | null;

  @ApiProperty({ nullable: true, type: String })
  phone!: string | null;

  @ApiProperty({ nullable: true, type: String })
  username!: string | null;
  scopes!: AdminAccountScopeDto[];
  status!: "ACTIVE" | "DISABLED";
  updatedAt!: string;
}

export class AdminEmailSendDto {
  sent!: boolean;
  retryAfterSeconds!: number;
  expiresInSeconds!: number;
}

export class AdminEmailStatusDto {
  retryAfterSeconds!: number;
}

export class AdminEmailConfirmedDto {
  verified!: boolean;
}
