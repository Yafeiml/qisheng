import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { CampaignModule } from "../campaign/campaign.module";
import { ContentModule } from "../content/content.module";
import { HealthModule } from "../health/health.module";
import { ModelConfigurationModule } from "../model-configuration/model-configuration.module";
import { OrganizationModule } from "../organization/organization.module";
import { PlatformSettingsModule } from "../platform-settings/platform-settings.module";
import { PlatformOperationsController } from "./platform-operations.controller";
import { PlatformOperationsService } from "./platform-operations.service";
import { ProductionReadinessService } from "./production-readiness.service";

@Module({
  controllers: [PlatformOperationsController],
  exports: [ProductionReadinessService],
  imports: [
    AccessModule,
    CampaignModule,
    ContentModule,
    HealthModule,
    ModelConfigurationModule,
    OrganizationModule,
    PlatformSettingsModule,
  ],
  providers: [PlatformOperationsService, ProductionReadinessService],
})
export class PlatformOperationsModule {}
