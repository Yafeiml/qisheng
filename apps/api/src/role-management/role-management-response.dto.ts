import { ApiProperty } from "@nestjs/swagger";

export class PermissionResponseDto {
  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  code!: string;
  id!: string;
  name!: string;
  updatedAt!: string;
}

export class RolePermissionResponseDto {
  createdAt!: string;
  permission!: PermissionResponseDto;
  permissionId!: string;
  roleId!: string;
}

export class RoleResponseDto {
  code!: string;
  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  id!: string;
  isSystem!: boolean;
  name!: string;
  permissions?: RolePermissionResponseDto[];
  scopeType!: "ENTERPRISE" | "PLATFORM" | "TENANT";
  status!: "ACTIVE" | "DISABLED";
  updatedAt!: string;
}

export class BindingUserDto {
  @ApiProperty({ nullable: true, type: String })
  email!: string | null;

  id!: string;

  @ApiProperty({ nullable: true, type: String })
  name!: string | null;

  @ApiProperty({ nullable: true, type: String })
  phone!: string | null;

  @ApiProperty({ nullable: true, type: String })
  username!: string | null;
  status!: "ACTIVE" | "DISABLED";
}

export class AdminUserRoleDto {
  bindingId!: string;
  code!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  name!: string;
}

export class IdentityNamedResourceDto {
  id!: string;
  name!: string;
}

export class AdminUserScopeDto {
  @ApiProperty({ nullable: true, type: String })
  department!: string | null;

  @ApiProperty({ nullable: true, type: IdentityNamedResourceDto })
  enterprise!: IdentityNamedResourceDto | null;

  @ApiProperty({ nullable: true, type: String })
  jobTitle!: string | null;

  roles!: AdminUserRoleDto[];
  scopeId!: string;
  scopeType!: "ENTERPRISE" | "PLATFORM" | "TENANT";

  @ApiProperty({ nullable: true, type: IdentityNamedResourceDto })
  tenant!: IdentityNamedResourceDto | null;
}

export class AdminUserDto {
  activeSessionCount!: number;
  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  email!: string | null;

  id!: string;

  @ApiProperty({ nullable: true, type: String })
  lastLoginAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  name!: string | null;

  @ApiProperty({ nullable: true, type: String })
  phone!: string | null;

  @ApiProperty({ nullable: true, type: String })
  username!: string | null;
  scopes!: AdminUserScopeDto[];
  status!: "ACTIVE" | "DISABLED";
  updatedAt!: string;
}

export class RoleBindingResponseDto {
  @ApiProperty({ nullable: true, type: String })
  createdBy!: string | null;

  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  enterpriseId!: string | null;

  id!: string;
  role!: RoleResponseDto;
  roleId!: string;
  scopeId!: string;
  scopeType!: "ENTERPRISE" | "PLATFORM" | "TENANT";

  @ApiProperty({ nullable: true, type: String })
  tenantId!: string | null;

  user!: BindingUserDto;
  userId!: string;
}

export class RevokedRoleBindingDto {
  id!: string;
  revoked!: boolean;
}

export class PlatformAdministratorDto {
  activeSessionCount!: number;
  bindingId!: string;
  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  department!: string | null;

  @ApiProperty({ nullable: true, type: String })
  email!: string | null;

  @ApiProperty({ nullable: true, type: String })
  jobTitle!: string | null;

  @ApiProperty({ nullable: true, type: String })
  lastLoginAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  name!: string | null;

  @ApiProperty({ nullable: true, type: String })
  phone!: string | null;

  @ApiProperty({ nullable: true, type: String })
  username!: string | null;
  roleCode!: string;
  status!: string;
  userId!: string;
}

export class PlatformAdministratorActionDto {
  activeSessionCount!: number;
  status!: string;
  userId!: string;
}
