import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../database/prisma.module";
import { NotificationMailer } from "../notifications/notification-mailer";
import { PlatformSettingsModule } from "../platform-settings/platform-settings.module";
import { ResourcePolicyModule } from "../resource-policy/resource-policy.module";
import { GenerationStatusController } from "./generation-status.controller";
import { GenerationStatusService } from "./generation-status.service";
import { ModelConfigurationController } from "./model-configuration.controller";
import { ModelConfigurationService } from "./model-configuration.service";
import { ModelCredentialService } from "./model-credential.service";
import { ModelIncidentMonitor } from "./model-incident-monitor.service";
import { ModelProviderHealthService } from "./model-provider-health.service";
import { ModelQualificationService } from "./model-qualification.service";
import { ModelQualificationStorageService } from "./model-qualification-storage.service";
import { ModelSetupService } from "./model-setup.service";

@Module({
  controllers: [ModelConfigurationController, GenerationStatusController],
  exports: [
    ModelConfigurationService,
    ModelQualificationService,
    ModelProviderHealthService,
    PlatformSettingsModule,
  ],
  imports: [AccessModule, ResourcePolicyModule, PlatformSettingsModule, PrismaModule],
  providers: [
    NotificationMailer,
    ModelIncidentMonitor,
    GenerationStatusService,
    ModelConfigurationService,
    ModelCredentialService,
    ModelProviderHealthService,
    ModelQualificationService,
    ModelQualificationStorageService,
    ModelSetupService,
  ],
})
export class ModelConfigurationModule {}
