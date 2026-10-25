import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../database/prisma.module";
import { ResourcePolicyModule } from "../resource-policy/resource-policy.module";
import { EmployeeAdminController } from "./employee-admin.controller";
import { EmployeeAdminService } from "./employee-admin.service";
import {
  EnterprisePersonnelGovernanceController,
  TenantPersonnelGovernanceController,
} from "./personnel-governance.controller";
import { PersonnelGovernanceService } from "./personnel-governance.service";

@Module({
  controllers: [
    EmployeeAdminController,
    TenantPersonnelGovernanceController,
    EnterprisePersonnelGovernanceController,
  ],
  exports: [EmployeeAdminService],
  imports: [AccessModule, ResourcePolicyModule, PrismaModule],
  providers: [EmployeeAdminService, PersonnelGovernanceService],
})
export class EmployeeModule {}
