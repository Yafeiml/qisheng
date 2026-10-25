import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AdminUser,
  Enterprise,
  EnterpriseMembership,
  GlobalUser,
  Role,
  RoleBinding,
  Tenant,
} from "@xhs-agentic/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  enterpriseAccessScope,
  platformAccessScope,
  tenantAccessScope,
} from "../access/access-scope";
import { AuthorizationRepository } from "../access/authorization.repository";
import { PrismaService } from "../database/prisma.service";
import { OrganizationRepository } from "./organization.repository";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

describe("organization tenant isolation", { concurrent: false }, () => {
  const marker = `isolation-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const platformScope = platformAccessScope();
  const createdTenantIds: string[] = [];
  const createdEnterpriseIds: string[] = [];
  const createdRoleIds: string[] = [];
  const createdAdminUserIds: string[] = [];
  const createdEmployeeUserIds: string[] = [];

  let prisma: PrismaService;
  let organizations: OrganizationRepository;
  let authorization: AuthorizationRepository;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let enterpriseA: Enterprise;
  let enterpriseB: Enterprise;
  let administrator: AdminUser;
  let sharedUser: GlobalUser;
  let membershipA: EnterpriseMembership;
  let membershipB: EnterpriseMembership;
  let tenantRole: Role;
  let bindingA: RoleBinding;
  let bindingB: RoleBinding;

  beforeAll(async () => {
    assertDevelopmentDatabase();
    prisma = new PrismaService();
    await prisma.onModuleInit();
    organizations = new OrganizationRepository(prisma);
    authorization = new AuthorizationRepository(prisma);

    tenantA = await organizations.createTenant(platformScope, {
      customerType: "GROUP",
      name: `${marker}-tenant-a`,
    });
    tenantB = await organizations.createTenant(platformScope, {
      customerType: "GROUP",
      name: `${marker}-tenant-b`,
    });
    createdTenantIds.push(tenantA.id, tenantB.id);

    enterpriseA = await organizations.createEnterprise(platformScope, {
      name: `${marker}-enterprise-a`,
      tenantId: tenantA.id,
    });
    enterpriseB = await organizations.createEnterprise(platformScope, {
      name: `${marker}-enterprise-b`,
      tenantId: tenantB.id,
    });
    expect(enterpriseA.code).toMatch(/^ENT_[A-F0-9]{32}$/u);
    expect(enterpriseB.code).not.toBe(enterpriseA.code);
    createdEnterpriseIds.push(enterpriseA.id, enterpriseB.id);

    sharedUser = await organizations.createGlobalUser(platformScope, {
      phone: testPhone(marker),
      phoneVerifiedAt: new Date(),
    });
    createdEmployeeUserIds.push(sharedUser.id);
    administrator = await prisma.adminUser.create({
      data: {
        name: "隔离测试管理员",
        phone: sharedUser.phone,
        phoneVerifiedAt: new Date(),
      },
    });
    createdAdminUserIds.push(administrator.id);

    if (!sharedUser.phone) throw new Error("Expected a phone in the employee test fixture");
    membershipA = await organizations.createMembership(tenantAccessScope(tenantA.id), {
      enterpriseId: enterpriseA.id,
      globalUserId: sharedUser.id,
      name: "隔离测试员工",
      phone: sharedUser.phone,
    });
    membershipB = await organizations.createMembership(tenantAccessScope(tenantB.id), {
      enterpriseId: enterpriseB.id,
      globalUserId: sharedUser.id,
      name: "隔离测试员工",
      phone: sharedUser.phone,
    });

    tenantRole = await prisma.role.create({
      data: {
        code: `${marker}.tenant-admin`,
        isSystem: false,
        name: `${marker} Tenant Admin`,
        scopeType: "TENANT",
      },
    });
    createdRoleIds.push(tenantRole.id);

    bindingA = await authorization.createRoleBinding(platformScope, {
      roleId: tenantRole.id,
      targetScope: tenantAccessScope(tenantA.id),
      userId: administrator.id,
    });
    bindingB = await authorization.createRoleBinding(platformScope, {
      roleId: tenantRole.id,
      targetScope: tenantAccessScope(tenantB.id),
      userId: administrator.id,
    });
  });

  afterAll(async () => {
    if (!prisma) {
      return;
    }
    await prisma.roleBinding.deleteMany({
      where: {
        OR: [
          { roleId: { in: createdRoleIds } },
          { tenantId: { in: createdTenantIds } },
          { userId: { in: createdAdminUserIds } },
        ],
      },
    });
    await prisma.enterpriseMembership.deleteMany({
      where: { tenantId: { in: createdTenantIds } },
    });
    await prisma.enterprise.deleteMany({ where: { id: { in: createdEnterpriseIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
    await prisma.role.deleteMany({ where: { id: { in: createdRoleIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: createdAdminUserIds } } });
    await prisma.globalUser.deleteMany({ where: { id: { in: createdEmployeeUserIds } } });
    await prisma.onApplicationShutdown();
  });

  it("returns only enterprises inside the active tenant", async () => {
    const visibleToA = await organizations.listEnterprises(tenantAccessScope(tenantA.id));
    const visibleToB = await organizations.listEnterprises(tenantAccessScope(tenantB.id));

    expect(visibleToA.map(({ id }) => id)).toEqual([enterpriseA.id]);
    expect(visibleToB.map(({ id }) => id)).toEqual([enterpriseB.id]);
    await expect(
      organizations.findEnterpriseById(tenantAccessScope(tenantA.id), enterpriseB.id),
    ).resolves.toBeNull();
  });

  it("limits enterprise scope to its own memberships", async () => {
    const visibleMemberships = await organizations.listMemberships(
      enterpriseAccessScope(tenantA.id, enterpriseA.id),
    );

    expect(visibleMemberships.map(({ id }) => id)).toEqual([membershipA.id]);
    expect(membershipA.globalUserId).toBe(sharedUser.id);
    expect(membershipB.globalUserId).toBe(sharedUser.id);
    expect(membershipA.id).not.toBe(membershipB.id);
    await expect(
      organizations.findMembershipById(
        enterpriseAccessScope(tenantA.id, enterpriseA.id),
        membershipB.id,
      ),
    ).resolves.toBeNull();
  });

  it("does not expose role bindings from another tenant", async () => {
    const visibleToA = await authorization.listRoleBindings(
      tenantAccessScope(tenantA.id),
      administrator.id,
    );

    expect(visibleToA.map(({ id }) => id)).toEqual([bindingA.id]);
    expect(visibleToA.map(({ id }) => id)).not.toContain(bindingB.id);
  });

  it("rejects a cross-tenant role grant before it reaches the database", async () => {
    await expect(
      authorization.createRoleBinding(tenantAccessScope(tenantA.id), {
        roleId: tenantRole.id,
        targetScope: tenantAccessScope(tenantB.id),
        userId: administrator.id,
      }),
    ).rejects.toThrow("Cannot grant a role outside the active scope");
  });

  it("rejects a membership whose tenant and enterprise do not match", async () => {
    await expect(
      prisma.enterpriseMembership.create({
        data: {
          enterpriseId: enterpriseB.id,
          name: "非法跨租户员工",
          phone: `${sharedUser.phone}9`,
          tenantId: tenantA.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects a malformed role binding even when Prisma is called directly", async () => {
    await expect(
      prisma.roleBinding.create({
        data: {
          roleId: tenantRole.id,
          scopeId: tenantB.id,
          scopeType: "TENANT",
          tenantId: tenantA.id,
          userId: administrator.id,
        },
      }),
    ).rejects.toThrow();
  });
});

function assertDevelopmentDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for tenant isolation integration tests");
  }
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (databaseName !== "dev_xhs_agentic") {
    throw new Error(`Refusing to run integration tests against database: ${databaseName}`);
  }
}

function testPhone(marker: string): string {
  const digits = marker.replace(/\D/g, "").slice(-8).padStart(8, "0");
  return `199${digits}`;
}
