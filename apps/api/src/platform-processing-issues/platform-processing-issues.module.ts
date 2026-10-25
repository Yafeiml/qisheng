import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { ContentModule } from "../content/content.module";
import { PrismaModule } from "../database/prisma.module";
import { PlatformProcessingIssuesController } from "./platform-processing-issues.controller";
import { PlatformProcessingIssuesService } from "./platform-processing-issues.service";

@Module({
  imports: [AccessModule, PrismaModule, ContentModule],
  controllers: [PlatformProcessingIssuesController],
  providers: [PlatformProcessingIssuesService],
})
export class PlatformProcessingIssuesModule {}
