import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../database/prisma.module";
import { PlatformSettingsModule } from "../platform-settings/platform-settings.module";
import { StorageQuotaService } from "./storage-quota.service";
import { TenantCapabilityService } from "./tenant-capability.service";
@Module({
  exports: [StorageQuotaService, TenantCapabilityService],
  imports: [AccessModule, PlatformSettingsModule, PrismaModule],
  providers: [StorageQuotaService, TenantCapabilityService],
})
export class ResourcePolicyModule {}
