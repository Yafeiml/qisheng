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
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiProduces } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { EmployeeAccessGuard } from "../access/employee-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { MaterialRetrievalService } from "../content/material-retrieval.service";
import { Idempotent } from "../http/idempotent.decorator";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  AcceptCampaignContentReviewDto,
  ApproveCampaignDto,
  CampaignArchiveDto,
  CampaignListQueryDto,
  CampaignWorkItemQueryDto,
  CancelCampaignDto,
  CreateCampaignDto,
  DashboardQueryDto,
  RegenerateCampaignContentDto,
  ReopenCampaignReviewDto,
  RescheduleCampaignDto,
} from "./campaign.dto";
import { CampaignService } from "./campaign.service";
import {
  CampaignCancellationPreviewDto,
  CampaignCopyInputDto,
  CampaignDashboardDto,
  CampaignDetailDto,
  CampaignListPageDto,
  CampaignTimelineDto,
  CampaignWorkItemPageDto,
  EmployeeTaskDto,
  MaterialRetrievalResponseDto,
} from "./campaign-response.dto";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import { EmployeeFactsDto, EmployeeTaskPermissionDto } from "./employee-facts.dto";
import { GenerationPreflightService } from "./generation-preflight.service";
import { GenerationPreflightResponseDto } from "./generation-preflight-response.dto";
import { MedicalPlanningService, medicalRetrievalQuery } from "./medical-planning.service";

@Controller()
@UseGuards(AdminAccessGuard)
export class CampaignAdminController {
  constructor(
    @Inject(CampaignService) private readonly campaigns: CampaignService,
    @Inject(GenerationPreflightService) private readonly preflight: GenerationPreflightService,
    @Inject(MaterialRetrievalService)
    private readonly materialRetrieval: MaterialRetrievalService,
    @Inject(MedicalPlanningService) private readonly medicalPlanning: MedicalPlanningService,
  ) {}

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/preflight")
  @ApiOkResponse({ type: GenerationPreflightResponseDto })
  @HttpCode(HttpStatus.OK)
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  checkPreflight(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateCampaignDto,
  ) {
    return this.preflight.customerPreflight({ enterpriseId, tenantId }, input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/retrieval-preview")
  @ApiOkResponse({ type: MaterialRetrievalResponseDto })
  @HttpCode(HttpStatus.OK)
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  async retrievalPreview(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateCampaignDto,
  ) {
    const plan = await this.medicalPlanning.resolve(
      { enterpriseId, tenantId },
      input,
      new Date(),
      false,
    );
    return this.materialRetrieval.retrieve(
      { enterpriseId, tenantId },
      plan ? medicalRetrievalQuery(plan) : (input.prompt ?? ""),
      new Date(),
      undefined,
      input.focusEntityIds,
    );
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns")
  @ApiOkResponse({ type: CampaignListPageDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  list(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Query() query: CampaignListQueryDto,
  ) {
    return this.campaigns.listCampaigns({ enterpriseId, tenantId }, query);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns")
  @ApiCreatedResponse({ type: CampaignDetailDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  create(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateCampaignDto,
  ) {
    return this.campaigns.createCampaign({ enterpriseId, tenantId }, input);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId")
  @ApiOkResponse({ type: CampaignDetailDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  detail(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
  ) {
    return this.campaigns.getCampaign({ enterpriseId, tenantId }, campaignId);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/copy-input")
  @ApiOkResponse({ type: CampaignCopyInputDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  copyInput(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
  ) {
    return this.campaigns.getCampaignCopyInput({ enterpriseId, tenantId }, campaignId);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/timeline")
  @ApiOkResponse({ type: CampaignTimelineDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  timeline(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
  ) {
    return this.campaigns.getCampaignTimeline({ enterpriseId, tenantId }, campaignId);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/work-items")
  @ApiOkResponse({ type: CampaignWorkItemPageDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  workItems(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
    @Query() query: CampaignWorkItemQueryDto,
  ) {
    return this.campaigns.listCampaignWorkItems({ enterpriseId, tenantId }, campaignId, query);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/work-items.csv")
  @ApiProduces("text/csv")
  @ApiOkResponse({ schema: { type: "string" } })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  async exportWorkItems(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
    @Query() query: CampaignWorkItemQueryDto,
  ) {
    const stream = await this.campaigns.exportCampaignWorkItemsCsv(
      { enterpriseId, tenantId },
      campaignId,
      query,
    );
    return new StreamableFile(stream, {
      disposition: `attachment; filename="campaign-${campaignId}-work-items.csv"`,
      type: "text/csv; charset=utf-8",
    });
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/archive")
  @ApiCreatedResponse({ type: CampaignDetailDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  archive(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
    @Body() input: CampaignArchiveDto,
  ) {
    return this.campaigns.archiveCampaign({ enterpriseId, tenantId }, campaignId, input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/restore")
  @ApiCreatedResponse({ type: CampaignDetailDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  restore(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
    @Body() input: CampaignArchiveDto,
  ) {
    return this.campaigns.restoreCampaign({ enterpriseId, tenantId }, campaignId, input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/approve")
  @ApiCreatedResponse({ type: CampaignDetailDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "campaign.approve")
  approve(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
    @Body() input: ApproveCampaignDto,
  ) {
    return this.campaigns.approveCampaign({ enterpriseId, tenantId }, campaignId, input);
  }

  @Post(
    "console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/contents/:contentId/accept-review",
  )
  @ApiCreatedResponse({ type: CampaignDetailDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "campaign.approve")
  acceptContentReview(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
    @Param("contentId") contentId: string,
    @Body() input: AcceptCampaignContentReviewDto,
  ) {
    return this.campaigns.acceptContentReview(
      { enterpriseId, tenantId },
      campaignId,
      contentId,
      input,
    );
  }

  @Post(
    "console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/contents/:contentId/regenerate",
  )
  @ApiCreatedResponse({ type: CampaignDetailDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "campaign.approve")
  regenerateContent(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
    @Param("contentId") contentId: string,
    @Body() input: RegenerateCampaignContentDto,
  ) {
    return this.campaigns.regenerateContent(
      { enterpriseId, tenantId },
      campaignId,
      contentId,
      input,
    );
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/reschedule")
  @ApiCreatedResponse({ type: CampaignDetailDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "campaign.approve")
  reschedule(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
    @Body() input: RescheduleCampaignDto,
  ) {
    return this.campaigns.rescheduleCampaign({ enterpriseId, tenantId }, campaignId, input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/reopen-review")
  @ApiCreatedResponse({ type: CampaignDetailDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "campaign.approve")
  reopenReview(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
    @Body() input: ReopenCampaignReviewDto,
  ) {
    return this.campaigns.reopenCampaignReview({ enterpriseId, tenantId }, campaignId, input);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/cancel-preview")
  @ApiOkResponse({ type: CampaignCancellationPreviewDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  cancellationPreview(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
  ) {
    return this.campaigns.getCancellationPreview({ enterpriseId, tenantId }, campaignId);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/cancel")
  @ApiCreatedResponse({ type: CampaignDetailDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  cancel(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
    @Body() input: CancelCampaignDto,
  ) {
    return this.campaigns.cancelCampaign({ enterpriseId, tenantId }, campaignId, input);
  }

  @Post("console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/retry-failed")
  @ApiCreatedResponse({ type: CampaignDetailDto })
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  retryFailed(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
  ) {
    return this.campaigns.retryFailedGeneration({ enterpriseId, tenantId }, campaignId);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/dashboard")
  @ApiOkResponse({ type: CampaignDashboardDto })
  @RequireAdminAccess("ENTERPRISE", "dashboard.read")
  enterpriseDashboard(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Query() query: DashboardQueryDto,
  ) {
    return this.campaigns.getEnterpriseDashboard({ enterpriseId, tenantId }, query);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/dashboard.csv")
  @ApiProduces("text/csv")
  @ApiOkResponse({ schema: { type: "string" } })
  @RequireAdminAccess("ENTERPRISE", "dashboard.read")
  async exportEnterpriseDashboard(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Query() query: DashboardQueryDto,
  ) {
    const stream = await this.campaigns.exportEnterpriseDashboardCsv(
      { enterpriseId, tenantId },
      query,
    );
    return new StreamableFile(stream, {
      disposition: 'attachment; filename="management-summary.csv"',
      type: "text/csv; charset=utf-8",
    });
  }

  @Get("console/tenants/:tenantId/dashboard")
  @ApiOkResponse({ type: CampaignDashboardDto })
  @RequireAdminAccess("TENANT", "tenant.dashboard.read")
  tenantDashboard(@Param("tenantId") tenantId: string, @Query() query: DashboardQueryDto) {
    return this.campaigns.getTenantDashboard(tenantId, query);
  }

  @Get("console/tenants/:tenantId/dashboard.csv")
  @ApiProduces("text/csv")
  @ApiOkResponse({ schema: { type: "string" } })
  @RequireAdminAccess("TENANT", "tenant.dashboard.read")
  async exportTenantDashboard(
    @Param("tenantId") tenantId: string,
    @Query() query: DashboardQueryDto,
  ) {
    const stream = await this.campaigns.exportTenantDashboardCsv(tenantId, query);
    return new StreamableFile(stream, {
      disposition: 'attachment; filename="group-management-summary.csv"',
      type: "text/csv; charset=utf-8",
    });
  }
}

@Controller("employee/tasks")
@UseGuards(EmployeeAccessGuard)
export class EmployeeTaskController {
  constructor(@Inject(CampaignService) private readonly campaigns: CampaignService) {}

  @Get()
  @ApiOkResponse({ type: [EmployeeTaskDto] })
  list() {
    return this.campaigns.listEmployeeTasks();
  }

  @Get(":taskId")
  @ApiOkResponse({ type: EmployeeTaskDto })
  detail(@Param("taskId") taskId: string) {
    return this.campaigns.getEmployeeTask(taskId);
  }

  @Post(":taskId/view")
  @ApiCreatedResponse({ type: EmployeeTaskDto })
  view(@Param("taskId") taskId: string) {
    return this.campaigns.viewEmployeeTask(taskId);
  }

  @Post(":taskId/events")
  @ApiCreatedResponse({ type: EmployeeTaskDto })
  event(@Param("taskId") taskId: string, @Body() input: EmployeeTaskPermissionDto) {
    return this.campaigns.recordEmployeeTaskEvent(taskId, input);
  }

  @Post(":taskId/facts")
  @ApiCreatedResponse({ type: EmployeeTaskDto })
  facts(@Param("taskId") taskId: string, @Body() input: EmployeeFactsDto) {
    return this.campaigns.confirmEmployeeFacts(taskId, input);
  }
}
