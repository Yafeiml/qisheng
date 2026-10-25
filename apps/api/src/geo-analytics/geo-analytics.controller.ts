import { Controller, Get, Inject, Param, Query, UseGuards } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { GeoAnalyticsService } from "./geo-analytics.service";
import {
  GeoCampaignCoverageDto,
  GeoCoverageGapDto,
  GeoCoverageSummaryDto,
  GeoCoverageTrendPointDto,
  GeoTenantComparisonDto,
} from "./geo-analytics-response.dto";

@Controller()
@UseGuards(AdminAccessGuard)
export class GeoAnalyticsController {
  constructor(@Inject(GeoAnalyticsService) private readonly analytics: GeoAnalyticsService) {}

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/geo-analytics/summary")
  @ApiOkResponse({ type: GeoCoverageSummaryDto })
  @RequireAdminAccess("ENTERPRISE", "geo.read")
  enterpriseSummary(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Query("days") days?: string,
  ) {
    return this.analytics.getEnterpriseSummary({ enterpriseId, tenantId }, days);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/geo-analytics/campaigns")
  @ApiOkResponse({ type: [GeoCampaignCoverageDto] })
  @RequireAdminAccess("ENTERPRISE", "geo.read")
  enterpriseCampaigns(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Query("days") days?: string,
  ) {
    return this.analytics.getEnterpriseCampaigns({ enterpriseId, tenantId }, days);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/geo-analytics/trends")
  @ApiOkResponse({ type: [GeoCoverageTrendPointDto] })
  @RequireAdminAccess("ENTERPRISE", "geo.read")
  enterpriseTrends(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Query("days") days?: string,
  ) {
    return this.analytics.getEnterpriseTrends({ enterpriseId, tenantId }, days);
  }

  @Get("console/tenants/:tenantId/enterprises/:enterpriseId/geo-analytics/gaps")
  @ApiOkResponse({ type: [GeoCoverageGapDto] })
  @RequireAdminAccess("ENTERPRISE", "geo.read")
  enterpriseGaps(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Query("days") days?: string,
  ) {
    return this.analytics.getEnterpriseGaps({ enterpriseId, tenantId }, days);
  }

  @Get("console/tenants/:tenantId/geo-analytics/comparison")
  @ApiOkResponse({ type: GeoTenantComparisonDto })
  @RequireAdminAccess("TENANT", "tenant.dashboard.read", "geo.read")
  tenantComparison(@Param("tenantId") tenantId: string, @Query("days") days?: string) {
    return this.analytics.getTenantComparison(tenantId, days);
  }
}
