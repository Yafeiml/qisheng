import { Controller, Get, Inject, Param, UseGuards } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { GenerationStatusResponseDto } from "./generation-status.dto";
import { GenerationStatusService } from "./generation-status.service";

@Controller("console/tenants/:tenantId")
@UseGuards(AdminAccessGuard)
export class GenerationStatusController {
  constructor(@Inject(GenerationStatusService) private readonly status: GenerationStatusService) {}

  @Get("generation-status")
  @ApiOkResponse({ type: GenerationStatusResponseDto })
  @RequireAdminAccess("TENANT", "tenant.dashboard.read")
  tenant(@Param("tenantId") tenantId: string) {
    return this.status.current(tenantId);
  }

  @Get("enterprises/:enterpriseId/generation-status")
  @ApiOkResponse({ type: GenerationStatusResponseDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  enterprise(@Param("tenantId") tenantId: string, @Param("enterpriseId") enterpriseId: string) {
    return this.status.current(tenantId, enterpriseId);
  }
}
