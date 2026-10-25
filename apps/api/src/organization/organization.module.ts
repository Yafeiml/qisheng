import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../database/prisma.module";
import { ResourcePolicyModule } from "../resource-policy/resource-policy.module";
import { EnterpriseWorkspaceService } from "./enterprise-workspace.service";
import { GroupOverviewService } from "./group-overview.service";
import { IndustryController } from "./industry.controller";
import { IndustryService } from "./industry.service";
import { OrganizationRepository } from "./organization.repository";
import { OrganizationApplicationService } from "./organization-application.service";
import { PlatformOrganizationController } from "./platform-organization.controller";
import { TenantOrganizationController } from "./tenant-organization.controller";

@Module({
  controllers: [PlatformOrganizationController, TenantOrganizationController, IndustryController],
  exports: [
    EnterpriseWorkspaceService,
    IndustryService,
    OrganizationApplicationService,
    OrganizationRepository,
  ],
  imports: [PrismaModule, AccessModule, ResourcePolicyModule],
  providers: [
    EnterpriseWorkspaceService,
    GroupOverviewService,
    IndustryService,
    OrganizationApplicationService,
    OrganizationRepository,
  ],
})
export class OrganizationModule {}
