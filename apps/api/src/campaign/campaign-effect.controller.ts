import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ApiCreatedResponse, ApiExtraModels, ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { Idempotent } from "../http/idempotent.decorator";
// biome-ignore lint/style/useImportType: Nest validation and Swagger require runtime DTO classes.
import {
  CampaignEffectObservationDto,
  CampaignEffectObservationListDto,
  CreateCampaignEffectDto,
  GeoEffectPayloadDto,
  TransactionEffectPayloadDto,
} from "./campaign-effect.dto";
import { CampaignEffectService } from "./campaign-effect.service";

@Controller(
  "console/tenants/:tenantId/enterprises/:enterpriseId/campaigns/:campaignId/effect-observations",
)
@UseGuards(AdminAccessGuard)
@ApiExtraModels(GeoEffectPayloadDto, TransactionEffectPayloadDto)
export class CampaignEffectController {
  constructor(@Inject(CampaignEffectService) private readonly effects: CampaignEffectService) {}
  @Get()
  @ApiOkResponse({ type: CampaignEffectObservationListDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.read")
  list(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
  ) {
    return this.effects.list({ tenantId, enterpriseId }, campaignId);
  }
  @Post()
  @ApiCreatedResponse({ type: CampaignEffectObservationDto })
  @RequireAdminAccess("ENTERPRISE", "campaign.manage")
  @Idempotent()
  create(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("campaignId") campaignId: string,
    @Body() input: CreateCampaignEffectDto,
  ) {
    return this.effects.create({ tenantId, enterpriseId }, campaignId, input);
  }
}
