import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../database/prisma.module";
import { RoleManagementController } from "./role-management.controller";
import { RoleManagementService } from "./role-management.service";

@Module({
  controllers: [RoleManagementController],
  imports: [AccessModule, PrismaModule],
  providers: [RoleManagementService],
})
export class RoleManagementModule {}
