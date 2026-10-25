import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuditController } from "./audit.controller";
import { AuditService } from "./audit.service";

@Module({
  controllers: [AuditController],
  imports: [AccessModule],
  providers: [AuditService],
})
export class AuditModule {}
