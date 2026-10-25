import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../database/prisma.module";
import { CampaignEffectController } from "./campaign-effect.controller";
import { CampaignEffectService } from "./campaign-effect.service";

@Module({
  imports: [AccessModule, PrismaModule],
  controllers: [CampaignEffectController],
  providers: [CampaignEffectService],
})
export class CampaignEffectModule {}
