import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class IdentityNamedResourceDto {
  id!: string;
  name!: string;
}

export class AdminSessionRoleDto {
  code!: string;
  name!: string;
}

export class AdminSessionTenantDto extends IdentityNamedResourceDto {
  customerType!: "GROUP" | "SINGLE_ENTERPRISE";
}

export class AdminSessionScopeDto {
  @ApiProperty({ nullable: true, type: IdentityNamedResourceDto })
  enterprise!: IdentityNamedResourceDto | null;

  inheritedEnterprises!: IdentityNamedResourceDto[];
  permissions!: string[];
  role!: AdminSessionRoleDto;
  scopeId!: string;
  scopeType!: "ENTERPRISE" | "PLATFORM" | "TENANT";

  @ApiProperty({ nullable: true, type: AdminSessionTenantDto })
  tenant!: AdminSessionTenantDto | null;
}

export class AdminSessionProfileDto {
  audience!: "xhs-saas-admin";

  @ApiProperty({ nullable: true, type: String })
  name!: string | null;

  @ApiProperty({ nullable: true, type: String })
  phone!: string | null;

  @ApiProperty({ nullable: true, type: String })
  username!: string | null;

  @ApiProperty({ nullable: true, type: String })
  sessionId!: string | null;

  scopes!: AdminSessionScopeDto[];
  userId!: string;
}

export class DevelopmentAdminTokenResponseDto {
  accessToken!: string;
  audience!: "xhs-saas-admin";
  expiresInSeconds!: number;
  tokenType!: "Bearer";
  userId!: string;
}

export class EmployeeBoundMembershipDto {
  enterpriseId!: string;
  enterpriseName!: string;
  membershipId!: string;
  tenantId!: string;
}

export class EmployeeTokenResponseDto {
  accessToken!: string;
  audience!: "xhs-employee-miniapp";
  memberships!: EmployeeBoundMembershipDto[];
  tokenType!: "Bearer";
  userId!: string;
}

export class EmployeeCodeResponseDto {
  retryAfterSeconds!: number;
  delivery!: string;
  @ApiPropertyOptional({
    description: "仅开发认证或限时员工调试接口返回；正式短信验证码不在响应中返回。",
  })
  developmentCode?: string;
  expiresInSeconds!: number;
  phoneMasked!: string;
}

export class EmployeeBindingCandidateDto {
  alreadyBound!: boolean;

  @ApiProperty({ nullable: true, type: String })
  departmentName!: string | null;

  employeeName!: string;
  enterpriseId!: string;
  enterpriseName!: string;
  membershipId!: string;
  tenantId!: string;
  tenantName!: string;
}

export class EmployeeCandidatesResponseDto {
  candidates!: EmployeeBindingCandidateDto[];
  phoneMasked!: string;
}
