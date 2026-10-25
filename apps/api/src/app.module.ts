import { Module } from "@nestjs/common";
import { AccessModule } from "./access/access.module";
import { AuditModule } from "./audit/audit.module";
import { CampaignModule } from "./campaign/campaign.module";
import { ContentModule } from "./content/content.module";
import { PrismaModule } from "./database/prisma.module";
import { EmployeeModule } from "./employee/employee.module";
import { EmployeeNotificationsModule } from "./employee-notifications/employee-notifications.module";
import { GenerationLabModule } from "./generation-lab/generation-lab.module";
import { GeoAnalyticsModule } from "./geo-analytics/geo-analytics.module";
import { HealthModule } from "./health/health.module";
import { HttpInfrastructureModule } from "./http/http-infrastructure.module";
import { IdentityModule } from "./identity/identity.module";
import { ModelConfigurationModule } from "./model-configuration/model-configuration.module";
import { OrganizationModule } from "./organization/organization.module";
import { PlatformOperationsModule } from "./platform-operations/platform-operations.module";
import { PlatformProcessingIssuesModule } from "./platform-processing-issues/platform-processing-issues.module";
import { PlatformSettingsModule } from "./platform-settings/platform-settings.module";
import { PublicationModule } from "./publication/publication.module";
import { ResourcePolicyModule } from "./resource-policy/resource-policy.module";
import { RoleManagementModule } from "./role-management/role-management.module";

@Module({
  imports: [
    PrismaModule,
    AccessModule,
    HttpInfrastructureModule,
    AuditModule,
    OrganizationModule,
    ResourcePolicyModule,
    EmployeeModule,
    EmployeeNotificationsModule,
    IdentityModule,
    RoleManagementModule,
    ContentModule,
    GeoAnalyticsModule,
    CampaignModule,
    HealthModule,
    PublicationModule,
    PlatformSettingsModule,
    ModelConfigurationModule,
    GenerationLabModule,
    PlatformOperationsModule,
    PlatformProcessingIssuesModule,
  ],
})
export class AppModule {}
