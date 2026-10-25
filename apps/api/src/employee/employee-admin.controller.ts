import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { EnterpriseMembershipDto } from "../organization/organization-response.dto";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  BulkMembershipActionDto,
  ChangeMembershipPhoneDto,
  CreateDepartmentDto,
  DepartmentStatusActionDto,
  ImportMembershipsDto,
  MembershipActionDto,
  UpdateDepartmentDto,
  UpdateMembershipDto,
} from "./employee-admin.dto";
import { EmployeeAdminService } from "./employee-admin.service";
import {
  BulkMembershipActionResponseDto,
  DepartmentImpactResponseDto,
  DepartmentResponseDto,
  MembershipImportBatchResponseDto,
  MembershipImportPreviewDto,
  MembershipImportResponseDto,
} from "./employee-admin-response.dto";

@Controller("console/tenants/:tenantId/enterprises/:enterpriseId")
@UseGuards(AdminAccessGuard)
export class EmployeeAdminController {
  constructor(@Inject(EmployeeAdminService) private readonly employees: EmployeeAdminService) {}

  @Get("departments")
  @ApiOkResponse({ type: [DepartmentResponseDto] })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.read")
  listDepartments(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.employees.listDepartments(tenantId, enterpriseId);
  }

  @Post("departments")
  @ApiCreatedResponse({ type: DepartmentResponseDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  createDepartment(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateDepartmentDto,
  ) {
    return this.employees.createDepartment(tenantId, enterpriseId, input);
  }

  @Post("departments/:departmentId")
  @ApiCreatedResponse({ type: DepartmentResponseDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  updateDepartment(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("departmentId") departmentId: string,
    @Body() input: UpdateDepartmentDto,
  ) {
    return this.employees.updateDepartment(tenantId, enterpriseId, departmentId, input);
  }

  @Get("departments/:departmentId/impact")
  @ApiOkResponse({ type: DepartmentImpactResponseDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.read")
  departmentImpact(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("departmentId") departmentId: string,
  ) {
    return this.employees.departmentImpact(tenantId, enterpriseId, departmentId);
  }

  @Post("departments/:departmentId/disable")
  @ApiCreatedResponse({ type: DepartmentResponseDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  disableDepartment(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("departmentId") departmentId: string,
    @Body() input: DepartmentStatusActionDto,
  ) {
    return this.employees.disableDepartment(tenantId, enterpriseId, departmentId, input);
  }

  @Post("memberships/import")
  @ApiCreatedResponse({ type: MembershipImportResponseDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  importMemberships(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: ImportMembershipsDto,
  ) {
    return this.employees.importMemberships(tenantId, enterpriseId, input);
  }

  @Post("memberships/import/preview")
  @ApiCreatedResponse({ type: MembershipImportPreviewDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  previewMembershipImport(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: ImportMembershipsDto,
  ) {
    return this.employees.previewMembershipImport(tenantId, enterpriseId, input);
  }

  @Get("memberships/import-batches")
  @ApiOkResponse({ type: [MembershipImportBatchResponseDto] })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.read")
  listMembershipImportBatches(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.employees.listMembershipImportBatches(tenantId, enterpriseId);
  }

  @Post("memberships/bulk")
  @ApiCreatedResponse({ type: BulkMembershipActionResponseDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  bulkMembershipAction(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: BulkMembershipActionDto,
  ) {
    return this.employees.bulkMembershipAction(tenantId, enterpriseId, input);
  }

  @Post("memberships/:membershipId/profile")
  @ApiCreatedResponse({ type: EnterpriseMembershipDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  updateMembership(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("membershipId") membershipId: string,
    @Body() input: UpdateMembershipDto,
  ) {
    return this.employees.updateMembership(tenantId, enterpriseId, membershipId, input);
  }

  @Post("memberships/:membershipId/phone")
  @ApiCreatedResponse({ type: EnterpriseMembershipDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  changeMembershipPhone(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("membershipId") membershipId: string,
    @Body() input: ChangeMembershipPhoneDto,
  ) {
    return this.employees.changeMembershipPhone(tenantId, enterpriseId, membershipId, input);
  }

  @Post("memberships/:membershipId/enable")
  @ApiCreatedResponse({ type: EnterpriseMembershipDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  enableMembership(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("membershipId") membershipId: string,
    @Body() input: MembershipActionDto,
  ) {
    return this.employees.enableMembership(tenantId, enterpriseId, membershipId, input);
  }

  @Post("memberships/:membershipId/disable")
  @ApiCreatedResponse({ type: EnterpriseMembershipDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  disableMembership(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("membershipId") membershipId: string,
    @Body() input: MembershipActionDto,
  ) {
    return this.employees.disableMembership(tenantId, enterpriseId, membershipId, input);
  }

  @Post("memberships/:membershipId/leave")
  @ApiCreatedResponse({ type: EnterpriseMembershipDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  markMembershipLeft(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("membershipId") membershipId: string,
    @Body() input: MembershipActionDto,
  ) {
    return this.employees.markMembershipLeft(tenantId, enterpriseId, membershipId, input);
  }
}
