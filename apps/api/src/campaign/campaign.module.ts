import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { ContentModule } from "../content/content.module";
import { PrismaModule } from "../database/prisma.module";
import { ModelConfigurationModule } from "../model-configuration/model-configuration.module";
import { PlatformSettingsModule } from "../platform-settings/platform-settings.module";
import { ResourcePolicyModule } from "../resource-policy/resource-policy.module";
import { CampaignAdminController, EmployeeTaskController } from "./campaign.controller";
import { CampaignService } from "./campaign.service";
import { CampaignEffectModule } from "./campaign-effect.module";
import { CampaignPlanningController } from "./campaign-planning.controller";
import { CampaignPlanningService } from "./campaign-planning.service";
import { GenerationPreflightService } from "./generation-preflight.service";
import { GenerationQueueService } from "./generation-queue.service";
import { ImageDeliveryService } from "./image-delivery.service";
import { ManagementActionController } from "./management-action.controller";
import { ManagementActionService } from "./management-action.service";
import { MedicalPlanningService } from "./medical-planning.service";
import { SyntheticGenerationAdapter } from "./synthetic-generation.adapter";

@Module({
  controllers: [
    CampaignAdminController,
    CampaignPlanningController,
    EmployeeTaskController,
    ManagementActionController,
  ],
  exports: [
    CampaignService,
    CampaignPlanningService,
    GenerationPreflightService,
    GenerationQueueService,
    ImageDeliveryService,
    ManagementActionService,
    MedicalPlanningService,
  ],
  imports: [
    AccessModule,
    CampaignEffectModule,
    ResourcePolicyModule,
    ContentModule,
    PrismaModule,
    ModelConfigurationModule,
    PlatformSettingsModule,
  ],
  providers: [
    CampaignPlanningService,
    CampaignService,
    GenerationPreflightService,
    GenerationQueueService,
    ImageDeliveryService,
    ManagementActionService,
    SyntheticGenerationAdapter,
    MedicalPlanningService,
  ],
})
export class CampaignModule {}
