import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AliyunSmsClient } from "../identity/aliyun-sms.client";
import { RuntimePolicyService } from "../model-configuration/runtime-policy.service";
import { AdminSmsSettingsService } from "./admin-sms-settings.service";
import { AssetDeliveryController } from "./asset-delivery.controller";
import { GenerationStyleController } from "./generation-style.controller";
import { GenerationStyleService } from "./generation-style.service";
import { LocalObjectStorageController } from "./local-object-storage.controller";
import { PlatformAssetDeliveryService } from "./platform-asset-delivery.service";
import { PlatformBrandingController } from "./platform-branding.controller";
import { PlatformContentSafetyService } from "./platform-content-safety.service";
import { PlatformObjectStorageService } from "./platform-object-storage.service";
import { PlatformPublicationVerificationService } from "./platform-publication-verification.service";
import { PlatformSettingCrypto } from "./platform-setting-crypto";
import { PlatformSettingsController } from "./platform-settings.controller";
import { PlatformSettingsReader } from "./platform-settings.reader";
import { PlatformSettingsService } from "./platform-settings.service";
import { PublicationPolicyEvidenceService } from "./publication-policy-evidence.service";
import { PublicationReadbackConfigurationService } from "./publication-readback.configuration";

@Module({
  controllers: [
    GenerationStyleController,
    AssetDeliveryController,
    LocalObjectStorageController,
    PlatformSettingsController,
    PlatformBrandingController,
  ],
  exports: [
    GenerationStyleService,
    AliyunSmsClient,
    PlatformAssetDeliveryService,
    PlatformContentSafetyService,
    PlatformObjectStorageService,
    PlatformPublicationVerificationService,
    PublicationPolicyEvidenceService,
    PublicationReadbackConfigurationService,
    PlatformSettingsReader,
    RuntimePolicyService,
  ],
  imports: [AccessModule],
  providers: [
    GenerationStyleService,
    AliyunSmsClient,
    AdminSmsSettingsService,
    PlatformAssetDeliveryService,
    PlatformContentSafetyService,
    PlatformObjectStorageService,
    PlatformPublicationVerificationService,
    PublicationPolicyEvidenceService,
    PublicationReadbackConfigurationService,
    PlatformSettingCrypto,
    PlatformSettingsReader,
    PlatformSettingsService,
    RuntimePolicyService,
  ],
})
export class PlatformSettingsModule {}
