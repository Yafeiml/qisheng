import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
// biome-ignore lint/style/useImportType: Swagger requires DTO constructors at runtime for request schemas.
import { CreateManagementActionDto, UpdateManagementActionDto } from "./management-action.dto";
import { ManagementActionService } from "./management-action.service";
import { ManagementActionResponseDto } from "./management-action-response.dto";

@Controller("console/tenants/:tenantId/enterprises/:enterpriseId/management-actions")
@UseGuards(AdminAccessGuard)
export class ManagementActionController {
  constructor(@Inject(ManagementActionService) private readonly actions: ManagementActionService) {}

  @Get()
  @ApiOkResponse({ type: [ManagementActionResponseDto] })
  @RequireAdminAccess("ENTERPRISE", "dashboard.read")
  list(@Param("tenantId") tenantId: string, @Param("enterpriseId") enterpriseId: string) {
    return this.actions.list(tenantId, enterpriseId);
  }

  @Post()
  @ApiCreatedResponse({ type: ManagementActionResponseDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  create(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateManagementActionDto,
  ) {
    return this.actions.create(tenantId, enterpriseId, input);
  }

  @Post(":actionId")
  @ApiCreatedResponse({ type: ManagementActionResponseDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  update(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("actionId") actionId: string,
    @Body() input: UpdateManagementActionDto,
  ) {
    return this.actions.update(tenantId, enterpriseId, actionId, input);
  }
}
