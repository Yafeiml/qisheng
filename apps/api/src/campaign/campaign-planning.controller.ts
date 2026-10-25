import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { GenerationStyleOptionsResponseDto } from "../platform-settings/generation-style.dto";
// biome-ignore lint/style/useImportType: Swagger requires DTO constructors at runtime for request schemas.
import {
  CreateCampaignTemplateDto,
  CreatePromptTemplateDto,
  DisablePlanningTemplateDto,
  SaveCampaignDraftDto,
} from "./campaign-planning.dto";
import { CampaignPlanningService } from "./campaign-planning.service";
import {
  CampaignDraftEnvelopeDto,
  CampaignDraftResponseDto,
  CampaignTemplateResponseDto,
  ClearCampaignDraftResponseDto,
  PromptTemplateResponseDto,
} from "./campaign-planning-response.dto";

@Controller("console/tenants/:tenantId/enterprises/:enterpriseId/campaign-planning")
@UseGuards(AdminAccessGuard)
export class CampaignPlanningController {
  constructor(
    @Inject(CampaignPlanningService) private readonly planning: CampaignPlanningService,
  ) {}

  @Get("medical-options")
  @ApiOkResponse({ schema: { type: "object", additionalProperties: true } })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  medicalOptions(@Param("tenantId") tenantId: string, @Param("enterpriseId") enterpriseId: string) {
    return this.planning.medicalOptions(tenantId, enterpriseId);
  }

  @Get("generation-styles")
  @ApiOkResponse({ type: GenerationStyleOptionsResponseDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  generationStyles(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.planning.generationStyles(tenantId, enterpriseId);
  }

  @Get("prompt-templates")
  @ApiOkResponse({ type: [PromptTemplateResponseDto] })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  listPromptTemplates(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.planning.listPromptTemplates(tenantId, enterpriseId);
  }

  @Post("prompt-templates")
  @ApiCreatedResponse({ type: PromptTemplateResponseDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  createPromptTemplate(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreatePromptTemplateDto,
  ) {
    return this.planning.createPromptTemplate(tenantId, enterpriseId, input);
  }

  @Post("prompt-templates/:templateId/disable")
  @ApiCreatedResponse({ type: PromptTemplateResponseDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  disablePromptTemplate(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("templateId") templateId: string,
    @Body() input: DisablePlanningTemplateDto,
  ) {
    return this.planning.disablePromptTemplate(tenantId, enterpriseId, templateId, input);
  }

  @Get("campaign-templates")
  @ApiOkResponse({ type: [CampaignTemplateResponseDto] })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  listCampaignTemplates(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
  ) {
    return this.planning.listCampaignTemplates(tenantId, enterpriseId);
  }

  @Post("campaign-templates")
  @ApiCreatedResponse({ type: CampaignTemplateResponseDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  createCampaignTemplate(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: CreateCampaignTemplateDto,
  ) {
    return this.planning.createCampaignTemplate(tenantId, enterpriseId, input);
  }

  @Post("campaign-templates/:templateId/disable")
  @ApiCreatedResponse({ type: CampaignTemplateResponseDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  disableCampaignTemplate(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("templateId") templateId: string,
    @Body() input: DisablePlanningTemplateDto,
  ) {
    return this.planning.disableCampaignTemplate(tenantId, enterpriseId, templateId, input);
  }

  @Get("draft")
  @ApiOkResponse({ type: CampaignDraftEnvelopeDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  getDraft(@Param("tenantId") tenantId: string, @Param("enterpriseId") enterpriseId: string) {
    return this.planning.getDraft(tenantId, enterpriseId);
  }

  @Post("draft")
  @ApiCreatedResponse({ type: CampaignDraftResponseDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  saveDraft(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: SaveCampaignDraftDto,
  ) {
    return this.planning.saveDraft(tenantId, enterpriseId, input);
  }

  @Post("draft/clear")
  @ApiCreatedResponse({ type: ClearCampaignDraftResponseDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  clearDraft(@Param("tenantId") tenantId: string, @Param("enterpriseId") enterpriseId: string) {
    return this.planning.clearDraft(tenantId, enterpriseId);
  }
}
