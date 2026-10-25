import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { Idempotent } from "../http/idempotent.decorator";
import { EnterpriseWorkspaceService } from "./enterprise-workspace.service";
import { GroupOverviewService } from "./group-overview.service";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime for ValidationPipe metadata.
import {
  CreateEnterpriseDto,
  EnterpriseMembershipQueryDto,
  SetEnterpriseStatusDto,
  UpdateEnterpriseDto,
  UpdatePublisherContextDto,
} from "./organization.dto";
import { OrganizationApplicationService } from "./organization-application.service";
import {
  EnterpriseDto,
  EnterpriseMembershipPageDto,
  EnterpriseOverviewDto,
  EnterpriseWorkspaceSummaryDto,
  GroupOverviewDto,
} from "./organization-response.dto";

@Controller("console/tenants/:tenantId")
@UseGuards(AdminAccessGuard)
export class TenantOrganizationController {
  constructor(
    @Inject(OrganizationApplicationService)
    private readonly organizations: OrganizationApplicationService,
    @Inject(EnterpriseWorkspaceService)
    private readonly workspace: EnterpriseWorkspaceService,
    @Inject(GroupOverviewService)
    private readonly groupOverview: GroupOverviewService,
  ) {}

  @Get("group-overview")
  @ApiOkResponse({ type: GroupOverviewDto })
  @RequireAdminAccess("TENANT", "tenant.dashboard.read")
  overview(@Param("tenantId") tenantId: string) {
    return this.groupOverview.overview(tenantId);
  }

  @Get("enterprises")
  @ApiOkResponse({ type: [EnterpriseOverviewDto] })
  @RequireAdminAccess("TENANT", "tenant.enterprise.read")
  listEnterprises(@Param("tenantId") tenantId: string) {
    return this.organizations.listTenantEnterprises(tenantId);
  }

  @Post("enterprises")
  @ApiCreatedResponse({ type: EnterpriseDto })
  @Idempotent()
  @RequireAdminAccess("TENANT", "tenant.enterprise.manage")
  createEnterprise(@Param("tenantId") tenantId: string, @Body() input: CreateEnterpriseDto) {
    return this.organizations.createEnterprise(tenantId, input);
  }

  @Get("enterprises/:enterpriseId")
  @ApiOkResponse({ type: EnterpriseOverviewDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.settings.manage")
  getEnterprise(@Param("tenantId") tenantId: string, @Param("enterpriseId") enterpriseId: string) {
    return this.organizations.getEnterprise(tenantId, enterpriseId);
  }

  @Get("enterprises/:enterpriseId/workspace")
  @ApiOkResponse({ type: EnterpriseWorkspaceSummaryDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  enterpriseWorkspace(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.workspace.summary(tenantId, enterpriseId);
  }

  @Post("enterprises/:enterpriseId/profile")
  @ApiCreatedResponse({ type: EnterpriseDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.settings.manage")
  updateEnterprise(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: UpdateEnterpriseDto,
  ) {
    return this.organizations.updateEnterprise(tenantId, enterpriseId, input);
  }

  @Post("enterprises/:enterpriseId/status")
  @ApiCreatedResponse({ type: EnterpriseDto })
  @RequireAdminAccess("TENANT", "tenant.enterprise.manage")
  setEnterpriseStatus(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: SetEnterpriseStatusDto,
  ) {
    return this.organizations.setEnterpriseStatus(tenantId, enterpriseId, input);
  }

  @Get("enterprises/:enterpriseId/memberships")
  @ApiOkResponse({ type: EnterpriseMembershipPageDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.read")
  listMemberships(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Query() query: EnterpriseMembershipQueryDto,
  ) {
    return this.organizations.listEnterpriseMemberships(tenantId, enterpriseId, query);
  }

  @Post("enterprises/:enterpriseId/memberships/:membershipId/publisher-context")
  @ApiCreatedResponse({ schema: { type: "object", additionalProperties: true } })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.manage")
  updatePublisherContext(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("membershipId") membershipId: string,
    @Body() input: UpdatePublisherContextDto,
  ) {
    return this.organizations.updatePublisherContext(tenantId, enterpriseId, membershipId, input);
  }
}
