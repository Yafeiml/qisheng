import { Module } from "@nestjs/common";
import { CampaignModule } from "../campaign/campaign.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  controllers: [HealthController],
  exports: [HealthService],
  imports: [CampaignModule],
  providers: [HealthService],
})
export class HealthModule {}
