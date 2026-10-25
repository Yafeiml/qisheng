import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { Idempotent } from "../http/idempotent.decorator";
import { IndustryService } from "./industry.service";
import { IndustryDto, IndustryManagementDto } from "./industry-response.dto";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime for ValidationPipe metadata.
import { CreateIndustryDto, UpdateIndustryGuidanceDto } from "./organization.dto";

@Controller()
@UseGuards(AdminAccessGuard)
export class IndustryController {
  constructor(@Inject(IndustryService) private readonly industries: IndustryService) {}

  @Get("platform/industries")
  @ApiOkResponse({ type: [IndustryManagementDto] })
  @RequireAdminAccess("PLATFORM", "platform.tenant.read")
  listPlatformIndustries() {
    return this.industries.listManagement();
  }

  @Post("platform/industries")
  @ApiCreatedResponse({ type: IndustryManagementDto })
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.tenant.manage")
  createIndustry(@Body() input: CreateIndustryDto) {
    return this.industries.create(input);
  }

  @Patch("platform/industries/:industryId/generation-guidance")
  @ApiOkResponse({ type: IndustryManagementDto })
  @Idempotent()
  @RequireAdminAccess("PLATFORM", "platform.tenant.manage")
  updateIndustryGuidance(
    @Param("industryId") industryId: string,
    @Body() input: UpdateIndustryGuidanceDto,
  ) {
    return this.industries.updateGuidance(industryId, input);
  }

  @Get("console/tenants/:tenantId/industries")
  @ApiOkResponse({ type: [IndustryDto] })
  @RequireAdminAccess("TENANT", "tenant.enterprise.read")
  listTenantIndustries(@Param("tenantId") _tenantId: string) {
    return this.industries.list();
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/industries")
  @ApiOkResponse({ type: [IndustryDto] })
  @RequireAdminAccess("ENTERPRISE", "enterprise.settings.manage")
  listEnterpriseIndustries(
    @Param("tenantId") _tenantId: string,
    @Param("enterpriseId") _enterpriseId: string,
  ) {
    return this.industries.list();
  }
}
