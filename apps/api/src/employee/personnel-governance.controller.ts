import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import { AdminAccessGuard } from "../access/admin-access.guard";
import { RequireAdminAccess } from "../access/require-admin-access.decorator";
import { Idempotent } from "../http/idempotent.decorator";
// biome-ignore lint/style/useImportType: NestJS needs DTO classes at runtime.
import {
  BulkUpdateMembershipParticipationDto,
  UpdateEnterprisePersonnelPolicyDto,
  UpdateMembershipParticipationDto,
} from "./personnel-governance.dto";
import { PersonnelGovernanceService } from "./personnel-governance.service";
import {
  BulkMembershipParticipationResponseDto,
  EnterprisePersonnelPolicyResponseDto,
  MembershipParticipationResponseDto,
} from "./personnel-governance-response.dto";

@Controller("console/tenants/:tenantId")
@UseGuards(AdminAccessGuard)
export class TenantPersonnelGovernanceController {
  constructor(
    @Inject(PersonnelGovernanceService) private readonly personnel: PersonnelGovernanceService,
  ) {}
  @Get("personnel-policies")
  @ApiOkResponse({ type: [EnterprisePersonnelPolicyResponseDto] })
  @RequireAdminAccess("TENANT", "tenant.membership.policy.manage")
  policies(@Param("tenantId") tenantId: string) {
    return this.personnel.listPolicies(tenantId);
  }

  @Post("personnel-policies/:enterpriseId")
  @ApiOkResponse({ type: EnterprisePersonnelPolicyResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("TENANT", "tenant.membership.policy.manage")
  updatePolicy(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: UpdateEnterprisePersonnelPolicyDto,
  ) {
    return this.personnel.updatePolicy(tenantId, enterpriseId, input);
  }
}

@Controller("console/tenants/:tenantId/enterprises/:enterpriseId")
@UseGuards(AdminAccessGuard)
export class EnterprisePersonnelGovernanceController {
  constructor(
    @Inject(PersonnelGovernanceService) private readonly personnel: PersonnelGovernanceService,
  ) {}
  @Get("personnel-policy")
  @ApiOkResponse({ type: EnterprisePersonnelPolicyResponseDto })
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.read")
  policy(@Param("tenantId") tenantId: string, @Param("enterpriseId") enterpriseId: string) {
    return this.personnel.enterprisePolicy(tenantId, enterpriseId);
  }

  @Post("memberships/participation/bulk")
  @ApiOkResponse({ type: BulkMembershipParticipationResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.participation.manage")
  bulkUpdateParticipation(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Body() input: BulkUpdateMembershipParticipationDto,
  ) {
    return this.personnel.bulkUpdateParticipation(tenantId, enterpriseId, input);
  }

  @Post("memberships/:membershipId/participation")
  @ApiOkResponse({ type: MembershipParticipationResponseDto })
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @RequireAdminAccess("ENTERPRISE", "enterprise.membership.participation.manage")
  updateParticipation(
    @Param("tenantId") tenantId: string,
    @Param("enterpriseId") enterpriseId: string,
    @Param("membershipId") membershipId: string,
    @Body() input: UpdateMembershipParticipationDto,
  ) {
    return this.personnel.updateParticipation(tenantId, enterpriseId, membershipId, input);
  }
}
