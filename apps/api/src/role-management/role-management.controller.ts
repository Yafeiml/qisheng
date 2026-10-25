import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { Idempotent } from "../http/idempotent.decorator";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  AdminUserScopeQueryDto,
  CreateAdminUserDto,
  GrantPlatformAdminDto,
  GrantRoleBindingDto,
  GrantTenantAdminDto,
  RevokeRoleBindingDto,
  SetPlatformAdminStatusDto,
  UpdateAdminUserProfileDto,
} from "./role-management.dto";
import { RoleManagementService } from "./role-management.service";
import {
  AdminUserDto,
  PlatformAdministratorActionDto,
  PlatformAdministratorDto,
  RevokedRoleBindingDto,
  RoleBindingResponseDto,
  RoleResponseDto,
} from "./role-management-response.dto";

@Controller()
@UseGuards(AdminAccessGuard)
export class RoleManagementController {
  constructor(@Inject(RoleManagementService) private readonly roles: RoleManagementService) {}

  @Get("platform/access/admins")
  @ApiOkResponse({ type: [PlatformAdministratorDto] })
  @RequireAdminAccess("PLATFORM", "platform.access.manage")
  listPlatformAdministrators() {
    return this.roles.listPlatformAdministrators();
  }

  @Post("platform/access/admins")
  @ApiCreatedResponse({ type: PlatformAdministratorDto })
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.access.manage")
  grantPlatformAdministrator(@Body() input: GrantPlatformAdminDto) {
    return this.roles.grantPlatformAdministrator(input);
  }

  @Delete("platform/access/admins/:bindingId")
  @ApiOkResponse({ type: RevokedRoleBindingDto })
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.access.manage")
  revokePlatformAdministrator(
    @Param("bindingId") bindingId: string,
    @Body() input: RevokeRoleBindingDto,
  ) {
    return this.roles.revokePlatformAdministrator(bindingId, input);
  }

  @Post("platform/access/users/:userId/status")
  @ApiCreatedResponse({ type: PlatformAdministratorActionDto })
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.access.manage")
  setPlatformAdministratorStatus(
    @Param("userId") userId: string,
    @Body() input: SetPlatformAdminStatusDto,
  ) {
    return this.roles.setPlatformAdministratorStatus(userId, input.status, input.reason);
  }

  @Post("platform/access/users/:userId/logout-all")
  @ApiCreatedResponse({ type: PlatformAdministratorActionDto })
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.access.manage")
  logoutPlatformAdministratorSessions(
    @Param("userId") userId: string,
    @Body() input: RevokeRoleBindingDto,
  ) {
    return this.roles.logoutPlatformAdministratorSessions(userId, input.reason);
  }

  @Post("platform/tenants/:tenantId/admins")
  @ApiCreatedResponse({ type: RoleBindingResponseDto })
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.tenant.manage")
  grantTenantAdmin(@Param("tenantId") tenantId: string, @Body() input: GrantTenantAdminDto) {
    return this.roles.grantTenantAdmin(tenantId, input);
  }

  @Get("console/tenants/:tenantId/roles")
  @ApiOkResponse({ type: [RoleResponseDto] })
  @RequireAdminAccess("TENANT", "tenant.role.manage")
  listTenantRoles() {
    return this.roles.listGrantableRoles("TENANT");
  }

  @Get("console/tenants/:tenantId/admin-users")
  @ApiOkResponse({ type: [AdminUserDto] })
  @RequireAdminAccess("TENANT", "tenant.role.manage")
  listTenantAdminUsers(@Param("tenantId") tenantId: string) {
    return this.roles.listTenantAdminUsers(tenantId);
  }

  @Post("console/tenants/:tenantId/admin-users")
  @ApiCreatedResponse({ type: AdminUserDto })
  @Idempotent()
  @RequireAdminAccess("TENANT", "tenant.role.manage")
  createTenantAdminUser(@Param("tenantId") tenantId: string, @Body() input: CreateAdminUserDto) {
    return this.roles.createAdminUserFromTenant(tenantId, input);
  }

  @Patch("console/tenants/:tenantId/admin-users/:userId")
  @ApiOkResponse({ type: AdminUserDto })
  @Idempotent()
  @RequireAdminAccess("TENANT", "tenant.role.manage")
  updateTenantAdminUser(
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Query() scope: AdminUserScopeQueryDto,
    @Body() input: UpdateAdminUserProfileDto,
  ) {
    return this.roles.updateTenantAdminUser(
      tenantId,
      userId,
      scope.scopeType,
      scope.enterpriseId,
      input,
    );
  }

  @Get("console/tenants/:tenantId/role-bindings")
  @ApiOkResponse({ type: [RoleBindingResponseDto] })
  @RequireAdminAccess("TENANT", "tenant.role.manage")
  listTenantBindings(@Param("tenantId") tenantId: string) {
    return this.roles.listTenantBindings(tenantId);
  }

  @Post("console/tenants/:tenantId/role-bindings")
  @ApiCreatedResponse({ type: RoleBindingResponseDto })
  @Idempotent()
  @RequireAdminAccess("TENANT", "tenant.role.manage")
  grantFromTenant(@Param("tenantId") tenantId: string, @Body() input: GrantRoleBindingDto) {
    return this.roles.grantFromTenant(tenantId, input);
  }

  @Delete("console/tenants/:tenantId/role-bindings/:bindingId")
  @ApiOkResponse({ type: RevokedRoleBindingDto })
  @Idempotent()
  @RequireAdminAccess("TENANT", "tenant.role.manage")
  revokeFromTenant(
    @Param("tenantId") tenantId: string,
    @Param("bindingId") bindingId: string,
    @Body() input: RevokeRoleBindingDto,
  ) {
    return this.roles.revokeFromTenant(tenantId, bindingId, input);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/roles")
  @ApiOkResponse({ type: [RoleResponseDto] })
  @RequireAdminAccess("ENTERPRISE", "enterprise.role.manage")
  listEnterpriseRoles() {
    return this.roles.listGrantableRoles("ENTERPRISE");
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/admin-users")
  @ApiOkResponse({ type: [AdminUserDto] })
  @RequireAdminAccess("ENTERPRISE", "enterprise.role.manage")
  listEnterpriseAdminUsers(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.roles.listEnterpriseAdminUsers(tenantId, enterpriseId);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/admin-users")
  @ApiCreatedResponse({ type: AdminUserDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "enterprise.role.manage")
  createEnterpriseAdminUser(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateAdminUserDto,
  ) {
    return this.roles.createAdminUserFromEnterprise(tenantId, enterpriseId, input);
  }

  @Patch("console/tenants/:tenantId/enterprises/:enterpriseId/admin-users/:userId")
  @ApiOkResponse({ type: AdminUserDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "enterprise.role.manage")
  updateEnterpriseAdminUser(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("userId") userId: string,
    @Body() input: UpdateAdminUserProfileDto,
  ) {
    return this.roles.updateEnterpriseAdminUser(tenantId, enterpriseId, userId, input);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/role-bindings")
  @ApiOkResponse({ type: [RoleBindingResponseDto] })
  @RequireAdminAccess("ENTERPRISE", "enterprise.role.manage")
  listEnterpriseBindings(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.roles.listEnterpriseBindings(tenantId, enterpriseId);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/role-bindings")
  @ApiCreatedResponse({ type: RoleBindingResponseDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "enterprise.role.manage")
  grantFromEnterprise(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: GrantRoleBindingDto,
  ) {
    return this.roles.grantFromEnterprise(tenantId, enterpriseId, input);
  }

  @Delete("console/tenants/:tenantId/enterprises/:enterpriseId/role-bindings/:bindingId")
  @ApiOkResponse({ type: RevokedRoleBindingDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "enterprise.role.manage")
  revokeFromEnterprise(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("bindingId") bindingId: string,
    @Body() input: RevokeRoleBindingDto,
  ) {
    return this.roles.revokeFromEnterprise(tenantId, enterpriseId, bindingId, input);
  }
}
