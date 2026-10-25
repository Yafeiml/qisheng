import { Module } from "@nestjs/common";
import { WechatMiniappClient } from "@xhs-agentic/wechat-miniapp";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../database/prisma.module";
import { PlatformSettingsModule } from "../platform-settings/platform-settings.module";
import { EmployeeNotificationsController } from "./employee-notifications.controller";
import { EmployeeNotificationsService } from "./employee-notifications.service";

@Module({
  imports: [AccessModule, PrismaModule, PlatformSettingsModule],
  controllers: [EmployeeNotificationsController],
  providers: [
    EmployeeNotificationsService,
    { provide: WechatMiniappClient, useFactory: () => new WechatMiniappClient() },
  ],
})
export class EmployeeNotificationsModule {}
