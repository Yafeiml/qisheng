import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { ContentModule } from "../content/content.module";
import { PrismaModule } from "../database/prisma.module";
import { ResourcePolicyModule } from "../resource-policy/resource-policy.module";
import { GeoAnalyticsController } from "./geo-analytics.controller";
import { GeoAnalyticsService } from "./geo-analytics.service";

@Module({
  controllers: [GeoAnalyticsController],
  imports: [AccessModule, ResourcePolicyModule, ContentModule, PrismaModule],
  providers: [GeoAnalyticsService],
})
export class GeoAnalyticsModule {}
