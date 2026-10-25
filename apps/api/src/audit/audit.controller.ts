import { Controller, Get, Inject, Param, Query, UseGuards } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import { CursorPaginationQueryDto } from "../http/cursor-pagination";
import { AuditService } from "./audit.service";
import { AuditLogPageDto } from "./audit-response.dto";

@Controller("console/tenants/:tenantId")
@UseGuards(AdminAccessGuard)
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get("audit-logs")
  @ApiOkResponse({ type: AuditLogPageDto })
  @RequireAdminAccess("TENANT", "audit.read")
  tenantLogs(@Param("tenantId") tenantId: string, @Query() query: CursorPaginationQueryDto) {
    return this.audit.list({ tenantId }, query);
  }

  @Get("enterprises/:enterpriseId/audit-logs")
  @ApiOkResponse({ type: AuditLogPageDto })
  @RequireAdminAccess("ENTERPRISE", "audit.read")
  enterpriseLogs(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Query() query: CursorPaginationQueryDto,
  ) {
    return this.audit.list({ enterpriseId, tenantId }, query);
  }
}
