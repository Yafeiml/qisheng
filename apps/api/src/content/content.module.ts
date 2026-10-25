import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../database/prisma.module";
import { PlatformSettingsModule } from "../platform-settings/platform-settings.module";
import { ResourcePolicyModule } from "../resource-policy/resource-policy.module";
import { ContentController } from "./content.controller";
import { ContentService } from "./content.service";
import { MaterialIngestionService } from "./material-ingestion.service";
import { MaterialIngestionQueueService } from "./material-ingestion-queue.service";
import { MaterialRetrievalService } from "./material-retrieval.service";
import { MaterialStorageService } from "./material-storage.service";

@Module({
  controllers: [ContentController],
  exports: [
    ContentService,
    MaterialIngestionQueueService,
    MaterialIngestionService,
    MaterialRetrievalService,
  ],
  imports: [AccessModule, ResourcePolicyModule, PlatformSettingsModule, PrismaModule],
  providers: [
    ContentService,
    MaterialIngestionQueueService,
    MaterialIngestionService,
    MaterialRetrievalService,
    MaterialStorageService,
  ],
})
export class ContentModule {}
