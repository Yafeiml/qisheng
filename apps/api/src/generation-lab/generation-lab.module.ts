import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { CampaignModule } from "../campaign/campaign.module";
import { ContentModule } from "../content/content.module";
import { PrismaModule } from "../database/prisma.module";
import { ModelConfigurationModule } from "../model-configuration/model-configuration.module";
import { PlatformSettingsModule } from "../platform-settings/platform-settings.module";
import { GenerationLabController } from "./generation-lab.controller";
import { GenerationLabService } from "./generation-lab.service";

@Module({
  imports: [
    PrismaModule,
    AccessModule,
    CampaignModule,
    ContentModule,
    ModelConfigurationModule,
    PlatformSettingsModule,
  ],
  controllers: [GenerationLabController],
  providers: [GenerationLabService],
})
export class GenerationLabModule {}
