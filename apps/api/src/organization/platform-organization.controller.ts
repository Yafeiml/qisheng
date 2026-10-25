import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
} from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { Idempotent } from "../http/idempotent.decorator";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime for ValidationPipe metadata.
import {
  CreateEnterpriseDto,
  CreateTenantDto,
  SetEnterpriseStatusDto,
  UpdateEnterpriseDto,
} from "./organization.dto";
import { OrganizationApplicationService } from "./organization-application.service";
import { EnterpriseDto, TenantDto } from "./organization-response.dto";

@Controller("platform")
@UseGuards(AdminAccessGuard)
export class PlatformOrganizationController {
  constructor(
    @Inject(OrganizationApplicationService)
    private readonly organizations: OrganizationApplicationService,
  ) {}

  @Get("tenants")
  @ApiOkResponse({ type: [TenantDto] })
  @RequireAdminAccess("PLATFORM", "platform.tenant.read")
  listTenants() {
    return this.organizations.listPlatformTenants();
  }

  @Post("tenants")
  @HttpCode(403)
  @ApiOperation({ summary: "已停用：当前安装只管理一个企业或集团", deprecated: true })
  @ApiForbiddenResponse({ description: "请在现有集团下新增企业" })
  @RequireAdminAccess("PLATFORM", "platform.tenant.manage")
  createTenant(@Body() input: CreateTenantDto) {
    return this.organizations.createTenant(input);
  }

  @Get("tenants/:tenantId/enterprises")
  @ApiOkResponse({ type: [EnterpriseDto] })
  @RequireAdminAccess("PLATFORM", "platform.tenant.read")
  listEnterprises(@Param("tenantId") tenantId: string) {
    return this.organizations.listPlatformEnterprises(tenantId);
  }

  @Post("tenants/:tenantId/enterprises")
  @ApiCreatedResponse({ type: EnterpriseDto })
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.tenant.manage")
  createEnterprise(@Param("tenantId") tenantId: string, @Body() input: CreateEnterpriseDto) {
    return this.organizations.createEnterprise(tenantId, input);
  }

  @Post("tenants/:tenantId/enterprises/:enterpriseId/profile")
  @ApiCreatedResponse({ type: EnterpriseDto })
  @RequireAdminAccess("PLATFORM", "platform.tenant.manage")
  updateEnterprise(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: UpdateEnterpriseDto,
  ) {
    return this.organizations.updateEnterprise(tenantId, enterpriseId, input);
  }

  @Post("tenants/:tenantId/enterprises/:enterpriseId/status")
  @ApiCreatedResponse({ type: EnterpriseDto })
  @RequireAdminAccess("PLATFORM", "platform.tenant.manage")
  setEnterpriseStatus(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: SetEnterpriseStatusDto,
  ) {
    return this.organizations.setEnterpriseStatus(tenantId, enterpriseId, input);
  }
}
