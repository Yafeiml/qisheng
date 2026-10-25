import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { CampaignModule } from "../campaign/campaign.module";
import { PrismaModule } from "../database/prisma.module";
import { PlatformSettingsModule } from "../platform-settings/platform-settings.module";
import { ResourcePolicyModule } from "../resource-policy/resource-policy.module";
import {
  PublicationAdminController,
  PublicationEmployeeController,
  PublicationIntegrationController,
} from "./publication.controller";
import { PublicationService } from "./publication.service";
import {
  PublicationCollectorAdminController,
  PublicationCollectorController,
} from "./publication-collector.controller";
import { PublicationCollectorGuard } from "./publication-collector.guard";
import { PublicationCollectorService } from "./publication-collector.service";
import {
  PublicationReadbackAdminController,
  PublicationReadbackController,
} from "./publication-readback.controller";
import { PublicationReadbackGuard } from "./publication-readback.guard";
import { PublicationReadbackService } from "./publication-readback.service";

@Module({
  controllers: [
    PublicationEmployeeController,
    PublicationAdminController,
    PublicationIntegrationController,
    PublicationCollectorController,
    PublicationCollectorAdminController,
    PublicationReadbackController,
    PublicationReadbackAdminController,
  ],
  imports: [
    AccessModule,
    ResourcePolicyModule,
    CampaignModule,
    PlatformSettingsModule,
    PrismaModule,
  ],
  providers: [
    PublicationService,
    PublicationCollectorService,
    PublicationCollectorGuard,
    PublicationReadbackService,
    PublicationReadbackGuard,
  ],
})
export class PublicationModule {}
