import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  Enterprise,
  EnterpriseMembership,
  GlobalUser,
  Prisma,
  Tenant,
  TenantCustomerType,
} from "@xhs-agentic/database";
import {
  type AccessScope,
  enterpriseWhere,
  membershipWhere,
  tenantWhere,
} from "../access/access-scope";
import { PrismaService } from "../database/prisma.service";
import { withGeneratedEnterpriseCode } from "./enterprise-code";

export type CreateTenantInput = Readonly<{
  name: string;
  customerType: TenantCustomerType;
  timezone?: string;
}>;

export type CreateEnterpriseInput = Readonly<{
  tenantId: string;
  name: string;
  brandName?: string;
  industry?: string;
  city?: string;
}>;

export type CreateGlobalUserInput = Readonly<{
  phone: string;
  phoneVerifiedAt?: Date;
  wechatOpenId?: string;
  wechatUnionId?: string;
}>;

export type CreateMembershipInput = Readonly<{
  enterpriseId: string;
  globalUserId?: string;
  name: string;
  phone: string;
  employeeNo?: string;
}>;

@Injectable()
export class OrganizationRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createTenant(scope: AccessScope, input: CreateTenantInput): Promise<Tenant> {
    this.assertPlatform(scope);
    return this.prisma.tenant.create({
      data: {
        customerType: input.customerType,
        name: input.name.trim(),
        timezone: input.timezone?.trim(),
      },
    });
  }

  async listTenants(scope: AccessScope): Promise<Tenant[]> {
    return this.prisma.tenant.findMany({
      orderBy: { createdAt: "asc" },
      where: tenantWhere(scope),
    });
  }

  async findTenantById(scope: AccessScope, tenantId: string): Promise<Tenant | null> {
    return this.prisma.tenant.findFirst({
      where: { AND: [tenantWhere(scope), { id: tenantId }] },
    });
  }

  async createEnterprise(scope: AccessScope, input: CreateEnterpriseInput): Promise<Enterprise> {
    if (
      scope.type === "ENTERPRISE" ||
      (scope.type === "TENANT" && scope.tenantId !== input.tenantId)
    ) {
      throw new ForbiddenException("Cannot create an enterprise outside the active tenant");
    }

    const tenant = await this.findTenantById(scope, input.tenantId);
    if (!tenant) {
      throw new NotFoundException("Tenant was not found in the active scope");
    }

    const create = (code: string) =>
      this.prisma.enterprise.create({
        data: {
          brandName: input.brandName?.trim(),
          city: input.city?.trim(),
          code,
          industry: input.industry?.trim(),
          name: input.name.trim(),
          tenantId: tenant.id,
        },
      });
    return withGeneratedEnterpriseCode(this.prisma, create);
  }

  async listEnterprises(scope: AccessScope): Promise<Enterprise[]> {
    return this.prisma.enterprise.findMany({
      orderBy: { createdAt: "asc" },
      where: enterpriseWhere(scope),
    });
  }

  async findEnterpriseById(scope: AccessScope, enterpriseId: string): Promise<Enterprise | null> {
    return this.prisma.enterprise.findFirst({
      where: { AND: [enterpriseWhere(scope), { id: enterpriseId }] },
    });
  }

  async createGlobalUser(scope: AccessScope, input: CreateGlobalUserInput): Promise<GlobalUser> {
    this.assertPlatform(scope);
    return this.prisma.globalUser.create({
      data: {
        phone: input.phone.trim(),
        phoneVerifiedAt: input.phoneVerifiedAt,
        wechatOpenId: input.wechatOpenId?.trim(),
        wechatUnionId: input.wechatUnionId?.trim(),
      },
    });
  }

  async createMembership(
    scope: AccessScope,
    input: CreateMembershipInput,
  ): Promise<EnterpriseMembership> {
    const enterprise = await this.findEnterpriseById(scope, input.enterpriseId);
    if (!enterprise) {
      throw new NotFoundException("Enterprise was not found in the active scope");
    }

    return this.prisma.enterpriseMembership.create({
      data: {
        employeeNo: input.employeeNo?.trim(),
        enterpriseId: enterprise.id,
        globalUserId: input.globalUserId,
        name: input.name.trim(),
        phone: input.phone.trim(),
        tenantId: enterprise.tenantId,
      },
    });
  }

  async listMemberships(
    scope: AccessScope,
    enterpriseId?: string,
  ): Promise<EnterpriseMembership[]> {
    const requestedEnterprise: Prisma.EnterpriseMembershipWhereInput = enterpriseId
      ? { enterpriseId }
      : {};
    return this.prisma.enterpriseMembership.findMany({
      orderBy: { createdAt: "asc" },
      where: { AND: [membershipWhere(scope), requestedEnterprise] },
    });
  }

  async findMembershipById(
    scope: AccessScope,
    membershipId: string,
  ): Promise<EnterpriseMembership | null> {
    return this.prisma.enterpriseMembership.findFirst({
      where: { AND: [membershipWhere(scope), { id: membershipId }] },
    });
  }

  private assertPlatform(scope: AccessScope): void {
    if (scope.type !== "PLATFORM") {
      throw new ForbiddenException("This operation requires platform scope");
    }
  }
}
