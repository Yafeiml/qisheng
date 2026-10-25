import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
} from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import { CreateCampaignDto } from "../campaign/campaign.dto";
import { GenerationPreflightService } from "../campaign/generation-preflight.service";
import { PlatformGenerationPreflightResponseDto } from "../campaign/generation-preflight-response.dto";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import { CursorPaginationQueryDto } from "../http/cursor-pagination";
import { Idempotent } from "../http/idempotent.decorator";
import { EnterpriseWorkspaceSummaryDto } from "../organization/organization-response.dto";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  CreatePlatformCustomerNoteDto,
  CustomerLifecycleReasonDto,
  CustomerListQueryDto,
  ProvisionCustomerDto,
} from "./platform-operations.dto";
import { PlatformOperationsService } from "./platform-operations.service";
import {
  CustomerLifecycleResponseDto,
  CustomerPageDto,
  GenerationRecoveryResponseDto,
  GenerationRunDetailDto,
  GenerationRunPageDto,
  PlatformCustomerDetailDto,
  PlatformCustomerNoteDto,
  PlatformOperationsOverviewDto,
  ProductionReadinessAuditDto,
} from "./platform-operations-response.dto";
import { ProductionReadinessService } from "./production-readiness.service";

@Controller("platform/operations")
@UseGuards(AdminAccessGuard)
export class PlatformOperationsController {
  constructor(
    @Inject(PlatformOperationsService)
    private readonly operations: PlatformOperationsService,
    @Inject(GenerationPreflightService)
    private readonly generationPreflight: GenerationPreflightService,
    @Inject(ProductionReadinessService)
    private readonly productionReadiness: ProductionReadinessService,
  ) {}

  @Get("overview")
  @ApiOkResponse({ type: PlatformOperationsOverviewDto })
  @RequireAdminAccess("PLATFORM", "platform.monitor.read")
  overview() {
    return this.operations.overview();
  }

  @Get("production-readiness")
  @ApiOkResponse({ type: ProductionReadinessAuditDto })
  @RequireAdminAccess("PLATFORM", "platform.monitor.read")
  productionReadinessAudit() {
    return this.productionReadiness.audit();
  }

  @Get("generation-runs")
  @ApiOkResponse({ type: GenerationRunPageDto })
  @RequireAdminAccess("PLATFORM", "platform.monitor.read")
  generationRuns(@Query() query: CursorPaginationQueryDto) {
    return this.operations.listGenerationRuns(query);
  }

  @Get("generation-runs/:generationRunId")
  @ApiOkResponse({ type: GenerationRunDetailDto })
  @RequireAdminAccess("PLATFORM", "platform.monitor.read")
  generationRun(@Param("generationRunId") generationRunId: string) {
    return this.operations.getGenerationRun(generationRunId);
  }

  @Post("generation-runs/:generationRunId/recover")
  @ApiOkResponse({ type: GenerationRecoveryResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.monitor.manage")
  recoverGenerationRun(@Param("generationRunId") generationRunId: string) {
    return this.operations.recoverGenerationRun(generationRunId);
  }

  @Get("customers")
  @ApiOkResponse({ type: CustomerPageDto })
  @RequireAdminAccess("PLATFORM", "platform.tenant.read")
  customers(@Query() query: CustomerListQueryDto) {
    return this.operations.listCustomers(query);
  }

  @Get("customers/:tenantId")
  @ApiOkResponse({ type: PlatformCustomerDetailDto })
  @RequireAdminAccess("PLATFORM", "platform.tenant.read")
  customer(@Param("tenantId") tenantId: string) {
    return this.operations.getCustomer(tenantId);
  }

  @Post("customers/:tenantId/suspend")
  @ApiCreatedResponse({ type: CustomerLifecycleResponseDto })
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.tenant.manage")
  suspendCustomer(@Param("tenantId") tenantId: string, @Body() input: CustomerLifecycleReasonDto) {
    return this.operations.setCustomerSuspended(tenantId, true, input.reason);
  }

  @Post("customers/:tenantId/resume")
  @ApiCreatedResponse({ type: CustomerLifecycleResponseDto })
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.tenant.manage")
  resumeCustomer(@Param("tenantId") tenantId: string, @Body() input: CustomerLifecycleReasonDto) {
    return this.operations.setCustomerSuspended(tenantId, false, input.reason);
  }

  @Post("customers/:tenantId/notes")
  @ApiCreatedResponse({ type: PlatformCustomerNoteDto })
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.tenant.manage")
  createCustomerNote(
    @Param("tenantId") tenantId: string,
    @Body() input: CreatePlatformCustomerNoteDto,
  ) {
    return this.operations.createCustomerNote(tenantId, input);
  }

  @Get("customers/:tenantId/enterprises/:enterpriseId/readiness")
  @ApiOkResponse({ type: EnterpriseWorkspaceSummaryDto })
  @RequireAdminAccess("PLATFORM", "platform.tenant.read")
  customerEnterpriseReadiness(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.operations.customerEnterpriseReadiness(tenantId, enterpriseId);
  }

  @Post("customers/:tenantId/enterprises/:enterpriseId/generation-preflight")
  @ApiOkResponse({ type: PlatformGenerationPreflightResponseDto })
  @HttpCode(HttpStatus.OK)
  @RequireAdminAccess("PLATFORM", "platform.monitor.read", "platform.tenant.read")
  customerEnterpriseGenerationPreflight(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateCampaignDto,
  ) {
    return this.generationPreflight.platformPreflight({ enterpriseId, tenantId }, input);
  }

  @Post("customers")
  @HttpCode(HttpStatus.FORBIDDEN)
  @ApiForbiddenResponse({ description: "一套安装不再新增独立工作空间" })
  @ApiOperation({ summary: "已停用：集团下属企业请在企业管理中新增", deprecated: true })
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.tenant.manage")
  provisionCustomer(@Body() input: ProvisionCustomerDto) {
    return this.operations.provisionCustomer(input);
  }
}
