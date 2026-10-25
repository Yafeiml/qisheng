import "reflect-metadata";

import { createHash, randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { AdminUser } from "@xhs-agentic/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthTokenService } from "../access/auth-token.service";
import { seedAuthorizationCatalog } from "../access/authorization.seed";
import { AppModule } from "../app.module";
import { configureApplication } from "../configure-application";
import { PrismaService } from "../database/prisma.service";
import { hashPassword } from "../identity/password";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

type ApiResponse = Readonly<{ body: unknown; headers: Headers; status: number }>;

describe("Sprint 9 administrator control plane", { concurrent: false }, () => {
  const marker = `sprint9-access-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const createdPhones: string[] = [];
  const createdUsernames: string[] = [];
  const extraTenantIds: string[] = [];
  const testRoleIds: string[] = [];
  const tenantAdminPhone = uniquePhone();
  const tenantViewerPhone = uniquePhone();
  const enterpriseAdminPhone = uniquePhone();
  const enterpriseViewerPhone = uniquePhone();
  const employeeOnlyPhone = uniquePhone();
  const platformTargetPhone = uniquePhone();
  let app: INestApplication;
  let baseUrl: string;
  let enterpriseAId: string;
  let foreignEnterpriseId: string;
  let foreignTenantId: string;
  let platformActor: AdminUser;
  let platformTargetBindingId: string;
  let platformTargetUserId: string;
  let platformToken: string;
  let prisma: PrismaService;
  let tenantAdminToken: string;
  let tenantId: string;
  let tenantViewerBindingId: string;
  let tokens: AuthTokenService;

  beforeAll(async () => {
    assertDevelopmentDatabase();
    app = await NestFactory.create(AppModule, {
      abortOnError: false,
      bodyParser: false,
      logger: false,
    });
    configureApplication(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);
    await seedAuthorizationCatalog(prisma);

    platformActor = await prisma.adminUser.findUniqueOrThrow({
      where: { phone: process.env.DEV_PLATFORM_ADMIN_PHONE },
    });
    platformToken = tokens.issueAdminAccessToken(platformActor.id);

    const [tenant, foreignTenant] = await Promise.all([
      prisma.tenant.create({ data: { customerType: "GROUP", name: `${marker}-tenant` } }),
      prisma.tenant.create({ data: { customerType: "GROUP", name: `${marker}-foreign` } }),
    ]);
    tenantId = tenant.id;
    foreignTenantId = foreignTenant.id;
    const [enterprise, foreignEnterprise] = await Promise.all([
      prisma.enterprise.create({
        data: { code: `${marker}-A`.toUpperCase(), name: "权限测试企业", tenantId },
      }),
      prisma.enterprise.create({
        data: {
          code: `${marker}-B`.toUpperCase(),
          name: "跨租户企业",
          tenantId: foreignTenantId,
        },
      }),
    ]);
    enterpriseAId = enterprise.id;
    foreignEnterpriseId = foreignEnterprise.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    const tenantIds = [tenantId, foreignTenantId, ...extraTenantIds].filter(Boolean);
    const administrators = await prisma.adminUser.findMany({
      select: { id: true },
      where: { OR: [{ phone: { in: createdPhones } }, { username: { in: createdUsernames } }] },
    });
    const employees = await prisma.globalUser.findMany({
      select: { id: true },
      where: { phone: { in: createdPhones } },
    });
    const adminUserIds = administrators.map(({ id }) => id);
    const employeeUserIds = employees.map(({ id }) => id);
    const userIds = [...adminUserIds, ...employeeUserIds];
    await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { actorUserId: platformActor?.id },
          { actorUserId: { in: userIds } },
          { tenantId: { in: tenantIds } },
        ],
      },
    });
    await prisma.adminSession.deleteMany({ where: { userId: { in: adminUserIds } } });
    await prisma.enterpriseMembership.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await prisma.roleBinding.deleteMany({
      where: {
        OR: [{ tenantId: { in: tenantIds } }, { userId: { in: adminUserIds } }],
      },
    });
    await prisma.adminOrganizationProfile.deleteMany({
      where: {
        OR: [{ tenantId: { in: tenantIds } }, { userId: { in: adminUserIds } }],
      },
    });
    await prisma.enterprise.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: testRoleIds } } });
    await prisma.role.deleteMany({ where: { id: { in: testRoleIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: adminUserIds } } });
    await prisma.globalUser.deleteMany({ where: { id: { in: employeeUserIds } } });
    await app.close();
  });

  it("grants a second platform administrator idempotently and audits the reason once", async () => {
    createdPhones.push(platformTargetPhone);
    const key = randomUUID();
    const first = await request("/platform/access/admins", {
      body: { phone: platformTargetPhone, reason: "扩充平台值班管理员" },
      idempotencyKey: key,
      method: "POST",
      token: platformToken,
    });
    const replay = await request("/platform/access/admins", {
      body: { phone: platformTargetPhone, reason: "扩充平台值班管理员" },
      idempotencyKey: key,
      method: "POST",
      token: platformToken,
    });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    platformTargetBindingId = stringField(first.body, "bindingId");
    platformTargetUserId = stringField(first.body, "userId");
    await expect(
      prisma.auditLog.count({
        where: {
          action: "role-binding.grant",
          actorUserId: platformActor.id,
          reason: "扩充平台值班管理员",
          resourceId: platformTargetBindingId,
        },
      }),
    ).resolves.toBe(1);
  });

  it("forces all sessions to expire on the target administrator's next request", async () => {
    const targetToken = await createFormalToken(platformTargetUserId);
    const response = await request(`/platform/access/users/${platformTargetUserId}/logout-all`, {
      body: { reason: "轮换管理设备" },
      method: "POST",
      token: platformToken,
    });

    expect(response.status).toBe(201);
    expect(numberField(response.body, "activeSessionCount")).toBe(0);
    expect((await request("/auth/admin/session", { token: targetToken })).status).toBe(401);
  });

  it("disables and restores one of two platform administrators with immediate token invalidation", async () => {
    const targetToken = await createFormalToken(platformTargetUserId);
    const disabled = await request(`/platform/access/users/${platformTargetUserId}/status`, {
      body: { reason: "平台账号临时停用", status: "DISABLED" },
      method: "POST",
      token: platformToken,
    });
    expect(disabled.status).toBe(201);
    expect(stringField(disabled.body, "status")).toBe("DISABLED");
    expect((await request("/auth/admin/session", { token: targetToken })).status).toBe(401);

    const restored = await request(`/platform/access/users/${platformTargetUserId}/status`, {
      body: { reason: "平台账号恢复值班", status: "ACTIVE" },
      method: "POST",
      token: platformToken,
    });
    expect(restored.status).toBe(201);
    expect(stringField(restored.body, "status")).toBe("ACTIVE");
  });

  it("revokes the second platform binding and protects the final active administrator", async () => {
    const targetToken = await createFormalToken(platformTargetUserId);
    const revoked = await request(`/platform/access/admins/${platformTargetBindingId}`, {
      body: { reason: "值班职责已结束" },
      method: "DELETE",
      token: platformToken,
    });
    expect(revoked.status).toBe(200);
    expect((await request("/auth/admin/session", { token: targetToken })).status).toBe(401);

    const actorBinding = await prisma.roleBinding.findFirstOrThrow({
      where: {
        role: { code: "PLATFORM_ADMIN" },
        scopeId: "platform",
        scopeType: "PLATFORM",
        userId: platformActor.id,
      },
    });
    const otherActive = await prisma.roleBinding.findMany({
      select: { user: { select: { id: true, status: true } } },
      where: {
        role: { code: "PLATFORM_ADMIN" },
        scopeId: "platform",
        scopeType: "PLATFORM",
        user: { status: "ACTIVE" },
        userId: { not: platformActor.id },
      },
    });
    await prisma.adminUser.updateMany({
      data: { status: "DISABLED" },
      where: { id: { in: otherActive.map(({ user }) => user.id) } },
    });
    try {
      const revokeFinal = await request(`/platform/access/admins/${actorBinding.id}`, {
        body: { reason: "不允许移除最后管理员" },
        method: "DELETE",
        token: platformToken,
      });
      const disableFinal = await request(`/platform/access/users/${platformActor.id}/status`, {
        body: { reason: "不允许停用最后管理员", status: "DISABLED" },
        method: "POST",
        token: platformToken,
      });
      expect(revokeFinal.status).toBe(409);
      expect(JSON.stringify(revokeFinal.body)).toContain("LAST_PLATFORM_ADMIN_PROTECTED");
      expect(disableFinal.status).toBe(409);
      expect(JSON.stringify(disableFinal.body)).toContain("LAST_PLATFORM_ADMIN_PROTECTED");
    } finally {
      await prisma.adminUser.updateMany({
        data: { status: "ACTIVE" },
        where: { id: { in: otherActive.map(({ user }) => user.id) } },
      });
    }
  });

  it("lets a tenant administrator govern tenant and child-enterprise roles only", async () => {
    const secondTenantAdminPhone = uniquePhone();
    createdPhones.push(
      tenantAdminPhone,
      tenantViewerPhone,
      enterpriseAdminPhone,
      secondTenantAdminPhone,
    );
    const tenantGrant = await request(`/platform/tenants/${tenantId}/admins`, {
      body: { phone: tenantAdminPhone, reason: "建立集团管理员" },
      method: "POST",
      token: platformToken,
    });
    expect(tenantGrant.status).toBe(201);
    const repeatedTenantGrant = await request(`/platform/tenants/${tenantId}/admins`, {
      body: { phone: tenantAdminPhone, reason: "同一主管理员幂等确认" },
      method: "POST",
      token: platformToken,
    });
    expect(repeatedTenantGrant.status).toBe(201);
    expect(stringField(repeatedTenantGrant.body, "id")).toBe(stringField(tenantGrant.body, "id"));
    const secondTenantGrant = await request(`/platform/tenants/${tenantId}/admins`, {
      body: { phone: secondTenantAdminPhone, reason: "不得创建第二名集团主管理员" },
      method: "POST",
      token: platformToken,
    });
    expect(secondTenantGrant.status).toBe(409);
    expect(JSON.stringify(secondTenantGrant.body)).toContain(
      "TENANT_PRIMARY_ADMIN_ALREADY_ASSIGNED",
    );
    const tenantAdmin = await prisma.adminUser.findUniqueOrThrow({
      where: { phone: tenantAdminPhone },
    });
    tenantAdminToken = tokens.issueAdminAccessToken(tenantAdmin.id);

    const tenantRoles = await request(`/console/tenants/${tenantId}/roles`, {
      token: tenantAdminToken,
    });
    expect(tenantRoles.status).toBe(200);
    expect(
      arrayField(tenantRoles.body).some((row) => stringField(row, "code") === "TENANT_ADMIN"),
    ).toBe(false);
    const deniedTenantPeer = await request(`/console/tenants/${tenantId}/admin-users`, {
      body: {
        name: "第二名集团主管理员",
        phone: secondTenantAdminPhone,
        roleCodes: ["TENANT_ADMIN"],
        scopeType: "TENANT",
      },
      method: "POST",
      token: tenantAdminToken,
    });
    expect(deniedTenantPeer.status).toBe(403);

    const tenantManagedEnterpriseRoles = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/roles`,
      { token: tenantAdminToken },
    );
    expect(tenantManagedEnterpriseRoles.status).toBe(200);
    expect(
      arrayField(tenantManagedEnterpriseRoles.body).some(
        (row) => stringField(row, "code") === "ENTERPRISE_ADMIN",
      ),
    ).toBe(true);

    const tenantViewer = await request(`/console/tenants/${tenantId}/role-bindings`, {
      body: {
        phone: tenantViewerPhone,
        reason: "允许集团数据只读访问",
        roleCode: "DATA_VIEWER_TENANT",
        scopeType: "TENANT",
      },
      method: "POST",
      token: tenantAdminToken,
    });
    const enterpriseAdmin = await request(`/console/tenants/${tenantId}/role-bindings`, {
      body: {
        enterpriseId: enterpriseAId,
        phone: enterpriseAdminPhone,
        reason: "建立企业管理员",
        roleCode: "ENTERPRISE_ADMIN",
        scopeType: "ENTERPRISE",
      },
      method: "POST",
      token: tenantAdminToken,
    });
    expect(tenantViewer.status).toBe(201);
    expect(enterpriseAdmin.status).toBe(201);
    tenantViewerBindingId = stringField(tenantViewer.body, "id");

    const tenantBindings = await request(`/console/tenants/${tenantId}/role-bindings`, {
      token: tenantAdminToken,
    });
    const enterpriseBindings = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/role-bindings`,
      { token: tenantAdminToken },
    );
    expect(
      arrayField(tenantBindings.body).every((row) => stringField(row, "scopeType") === "TENANT"),
    ).toBe(true);
    expect(
      arrayField(enterpriseBindings.body).some(
        (row) => stringField(asRecord(row).role, "code") === "ENTERPRISE_ADMIN",
      ),
    ).toBe(true);

    const crossTenant = await request(`/console/tenants/${tenantId}/role-bindings`, {
      body: {
        enterpriseId: foreignEnterpriseId,
        phone: uniquePhone(),
        reason: "跨租户授权必须拒绝",
        roleCode: "ENTERPRISE_ADMIN",
        scopeType: "ENTERPRISE",
      },
      method: "POST",
      token: tenantAdminToken,
    });
    expect(crossTenant.status).toBe(404);
  });

  it("keeps enterprise administrators inside their exact enterprise", async () => {
    createdPhones.push(enterpriseViewerPhone);
    const enterpriseAdmin = await prisma.adminUser.findUniqueOrThrow({
      where: { phone: enterpriseAdminPhone },
    });
    const enterpriseToken = tokens.issueAdminAccessToken(enterpriseAdmin.id);
    const enterpriseRoles = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/roles`,
      { token: enterpriseToken },
    );
    expect(enterpriseRoles.status).toBe(200);
    expect(
      arrayField(enterpriseRoles.body).some(
        (row) => stringField(row, "code") === "ENTERPRISE_ADMIN",
      ),
    ).toBe(false);
    const deniedEnterprisePeer = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/admin-users`,
      {
        body: {
          enterpriseId: enterpriseAId,
          name: "同级企业管理员",
          phone: uniquePhone(),
          roleCodes: ["ENTERPRISE_ADMIN"],
          scopeType: "ENTERPRISE",
        },
        method: "POST",
        token: enterpriseToken,
      },
    );
    expect(deniedEnterprisePeer.status).toBe(403);
    const allowed = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/role-bindings`,
      {
        body: {
          enterpriseId: enterpriseAId,
          phone: enterpriseViewerPhone,
          reason: "允许企业数据查看",
          roleCode: "DATA_VIEWER_ENTERPRISE",
          scopeType: "ENTERPRISE",
        },
        method: "POST",
        token: enterpriseToken,
      },
    );
    const denied = await request(
      `/console/tenants/${foreignTenantId}/enterprises/${foreignEnterpriseId}/role-bindings`,
      {
        body: {
          enterpriseId: foreignEnterpriseId,
          phone: uniquePhone(),
          reason: "不得跨企业授权",
          roleCode: "DATA_VIEWER_ENTERPRISE",
          scopeType: "ENTERPRISE",
        },
        method: "POST",
        token: enterpriseToken,
      },
    );
    expect(allowed.status).toBe(201);
    expect(denied.status).toBe(403);
  });

  it("protects the unique tenant primary administrator and final single-enterprise administrator", async () => {
    const protectedTenantAdminPhone = uniquePhone();
    const protectedEnterpriseAdminPhone = uniquePhone();
    const singleTenantAdminPhone = uniquePhone();
    const tenantAccessManagerPhone = uniquePhone();
    createdPhones.push(
      protectedTenantAdminPhone,
      protectedEnterpriseAdminPhone,
      singleTenantAdminPhone,
      tenantAccessManagerPhone,
    );

    const [protectedTenant, singleTenant] = await Promise.all([
      prisma.tenant.create({ data: { customerType: "GROUP", name: `${marker}-protected-group` } }),
      prisma.tenant.create({
        data: { customerType: "SINGLE_ENTERPRISE", name: `${marker}-protected-single` },
      }),
    ]);
    extraTenantIds.push(protectedTenant.id, singleTenant.id);
    const singleEnterprise = await prisma.enterprise.create({
      data: { code: `${marker}-SINGLE`.toUpperCase(), name: "单体企业", tenantId: singleTenant.id },
    });

    const [protectedTenantGrant, singleTenantGrant] = await Promise.all([
      request(`/platform/tenants/${protectedTenant.id}/admins`, {
        body: { phone: protectedTenantAdminPhone, reason: "建立受保护集团管理员" },
        method: "POST",
        token: platformToken,
      }),
      request(`/platform/tenants/${singleTenant.id}/admins`, {
        body: { phone: singleTenantAdminPhone, reason: "建立单体企业集团范围管理员" },
        method: "POST",
        token: platformToken,
      }),
    ]);
    expect(protectedTenantGrant.status).toBe(201);
    expect(singleTenantGrant.status).toBe(201);

    const tenantAdministratorRole = await prisma.role.findUniqueOrThrow({
      include: { permissions: true },
      where: { code: "TENANT_ADMIN" },
    });
    const accessManagerRole = await prisma.role.create({
      data: {
        code: `TEST_TENANT_ACCESS_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        name: "测试权限治理员",
        permissions: {
          create: tenantAdministratorRole.permissions.map(({ permissionId }) => ({ permissionId })),
        },
        scopeType: "TENANT",
      },
    });
    testRoleIds.push(accessManagerRole.id);
    const accessManager = await prisma.adminUser.create({
      data: { name: "测试权限治理员", phone: tenantAccessManagerPhone },
    });
    await prisma.roleBinding.create({
      data: {
        roleId: accessManagerRole.id,
        scopeId: protectedTenant.id,
        scopeType: "TENANT",
        tenantId: protectedTenant.id,
        userId: accessManager.id,
      },
    });
    const protectedTenantBindingId = stringField(protectedTenantGrant.body, "id");
    const protectedTenantResult = await request(
      `/console/tenants/${protectedTenant.id}/role-bindings/${protectedTenantBindingId}`,
      {
        body: { reason: "不得移除最后集团管理员" },
        method: "DELETE",
        token: tokens.issueAdminAccessToken(accessManager.id),
      },
    );
    expect(protectedTenantResult.status).toBe(403);
    expect(JSON.stringify(protectedTenantResult.body)).toContain(
      "集团主管理员不能从客户后台新增或移除",
    );

    const singleTenantAdminId = stringField(singleTenantGrant.body, "userId");
    const singleTenantToken = tokens.issueAdminAccessToken(singleTenantAdminId);
    const singleEnterpriseAdmin = await request(
      `/console/tenants/${singleTenant.id}/role-bindings`,
      {
        body: {
          enterpriseId: singleEnterprise.id,
          phone: protectedEnterpriseAdminPhone,
          reason: "建立单体企业管理员",
          roleCode: "ENTERPRISE_ADMIN",
          scopeType: "ENTERPRISE",
        },
        method: "POST",
        token: singleTenantToken,
      },
    );
    expect(singleEnterpriseAdmin.status).toBe(201);
    const protectedEnterpriseResult = await request(
      `/console/tenants/${singleTenant.id}/role-bindings/${stringField(singleEnterpriseAdmin.body, "id")}`,
      {
        body: { reason: "不得移除单体企业最后管理员" },
        method: "DELETE",
        token: singleTenantToken,
      },
    );
    expect(protectedEnterpriseResult.status).toBe(409);
    expect(JSON.stringify(protectedEnterpriseResult.body)).toContain(
      "LAST_SINGLE_ENTERPRISE_ADMIN_PROTECTED",
    );
  });

  it("returns a business conflict when a backend email is reused", async () => {
    const firstPhone = uniquePhone();
    const secondPhone = uniquePhone();
    const email = `duplicate-${randomUUID()}@example.test`;
    createdPhones.push(firstPhone, secondPhone);

    const first = await request(`/console/tenants/${tenantId}/admin-users`, {
      body: {
        email,
        name: "邮箱占用用户",
        phone: firstPhone,
        roleCodes: ["HR_ADMIN_TENANT"],
        scopeType: "TENANT",
      },
      method: "POST",
      token: tenantAdminToken,
    });
    const duplicateCreate = await request(`/console/tenants/${tenantId}/admin-users`, {
      body: {
        email: email.toUpperCase(),
        name: "重复邮箱用户",
        phone: secondPhone,
        roleCodes: ["HR_ADMIN_TENANT"],
        scopeType: "TENANT",
      },
      method: "POST",
      token: tenantAdminToken,
    });
    expect(first.status).toBe(201);
    expect(duplicateCreate.status).toBe(409);
    expect(JSON.stringify(duplicateCreate.body)).toContain("ADMIN_EMAIL_ALREADY_EXISTS");

    const viewer = await prisma.adminUser.findUniqueOrThrow({
      where: { phone: tenantViewerPhone },
    });
    const duplicateUpdate = await request(
      `/console/tenants/${tenantId}/admin-users/${viewer.id}?scopeType=TENANT`,
      {
        body: { email, name: "集团查看员" },
        method: "PATCH",
        token: tenantAdminToken,
      },
    );
    expect(duplicateUpdate.status).toBe(409);
    expect(JSON.stringify(duplicateUpdate.body)).toContain("ADMIN_EMAIL_ALREADY_EXISTS");
  });

  it("adds an enterprise HR backend user without reusing the employee identity", async () => {
    const sharedPhone = uniquePhone();
    createdPhones.push(sharedPhone);
    const employee = await prisma.globalUser.create({ data: { phone: sharedPhone } });
    await prisma.enterpriseMembership.create({
      data: {
        enterpriseId: enterpriseAId,
        globalUserId: employee.id,
        name: "同手机号员工档案",
        phone: sharedPhone,
        tenantId,
      },
    });

    const created = await request(`/console/tenants/${tenantId}/admin-users`, {
      body: {
        department: "人力资源部",
        email: `hr-${Date.now()}@example.test`,
        enterpriseId: enterpriseAId,
        jobTitle: "人资主管",
        name: "后台人资管理员",
        phone: sharedPhone,
        roleCodes: ["HR_ADMIN_ENTERPRISE"],
        scopeType: "ENTERPRISE",
      },
      method: "POST",
      token: tenantAdminToken,
    });
    expect(created.status).toBe(201);
    const adminUserId = stringField(created.body, "id");
    expect(adminUserId).not.toBe(employee.id);

    const [administrator, persistedEmployee] = await Promise.all([
      prisma.adminUser.findUniqueOrThrow({ where: { phone: sharedPhone } }),
      prisma.globalUser.findUniqueOrThrow({ where: { phone: sharedPhone } }),
    ]);
    expect(administrator.id).toBe(adminUserId);
    expect(persistedEmployee.id).toBe(employee.id);
    await prisma.adminUser.update({
      where: { id: adminUserId },
      data: {
        emailVerifiedAt: new Date(),
        emailVerificationTokenHash: "a".repeat(64),
        emailVerificationExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    const listed = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/admin-users`,
      { token: tenantAdminToken },
    );
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain("企业人资管理员");
    expect(JSON.stringify(listed.body)).toContain("人资主管");

    const updated = await request(
      `/console/tenants/${tenantId}/admin-users/${adminUserId}?scopeType=ENTERPRISE&enterpriseId=${enterpriseAId}`,
      {
        body: {
          department: "组织与人才部",
          email: `changed-${adminUserId}@example.test`,
          jobTitle: "人资负责人",
          name: "后台人资负责人",
        },
        method: "PATCH",
        token: tenantAdminToken,
      },
    );
    expect(updated.status).toBe(200);
    expect(JSON.stringify(updated.body)).toContain("组织与人才部");
    expect(JSON.stringify(updated.body)).toContain("人资负责人");
    expect(await prisma.adminUser.findUniqueOrThrow({ where: { id: adminUserId } })).toMatchObject({
      emailVerifiedAt: null,
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null,
    });
  });

  it("does not convert an EnterpriseMembership into SaaS access and revokes bindings immediately", async () => {
    createdPhones.push(employeeOnlyPhone);
    const employee = await prisma.globalUser.create({ data: { phone: employeeOnlyPhone } });
    await prisma.enterpriseMembership.create({
      data: {
        enterpriseId: enterpriseAId,
        globalUserId: employee.id,
        name: "只有员工身份",
        phone: employeeOnlyPhone,
        tenantId,
      },
    });
    const employeeAdminToken = tokens.issueAdminAccessToken(employee.id);
    expect((await request("/auth/admin/session", { token: employeeAdminToken })).status).toBe(401);

    const viewer = await prisma.adminUser.findUniqueOrThrow({
      where: { phone: tenantViewerPhone },
    });
    const viewerToken = tokens.issueAdminAccessToken(viewer.id);
    expect((await request("/auth/admin/session", { token: viewerToken })).status).toBe(200);
    const revoked = await request(
      `/console/tenants/${tenantId}/role-bindings/${tenantViewerBindingId}`,
      {
        body: { reason: "撤销集团数据查看权限" },
        method: "DELETE",
        token: tenantAdminToken,
      },
    );
    expect(revoked.status).toBe(200);
    expect((await request("/auth/admin/session", { token: viewerToken })).status).toBe(401);
  });

  it("assigns roles to a registered password account without a phone and rejects unknown or disabled accounts", async () => {
    const username = `role-${randomUUID().slice(0, 12)}`;
    createdUsernames.push(username);
    const user = await prisma.adminUser.create({
      data: {
        username,
        passwordHash: await hashPassword("Example-password123"),
        name: "密码运营账户",
      },
    });
    const endpoint = `/console/tenants/${tenantId}/role-bindings`;
    const body = {
      username,
      roleCode: "HR_ADMIN_TENANT",
      scopeType: "TENANT",
      reason: "绑定已注册账号",
    };
    const granted = await request(endpoint, { body, method: "POST", token: tenantAdminToken });
    expect(granted.status).toBe(201);
    expect(asRecord(asRecord(granted.body).user)).toMatchObject({
      id: user.id,
      username,
      phone: null,
    });
    const unknown = await request(endpoint, {
      body: { ...body, username: `unknown-${randomUUID().slice(0, 10)}` },
      method: "POST",
      token: tenantAdminToken,
    });
    expect(unknown.status).toBe(404);
    await prisma.adminUser.update({ where: { id: user.id }, data: { status: "DISABLED" } });
    const disabled = await request(endpoint, { body, method: "POST", token: tenantAdminToken });
    expect(disabled.status).toBe(409);
  });

  async function createFormalToken(userId: string): Promise<string> {
    const sessionId = randomUUID();
    await prisma.adminSession.create({
      data: {
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        id: sessionId,
        refreshTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        userId,
      },
    });
    return tokens.issueAdminAccessToken(userId, sessionId);
  }

  async function request(
    path: string,
    options: Readonly<{
      body?: unknown;
      idempotencyKey?: string;
      method?: "DELETE" | "GET" | "PATCH" | "POST";
      token?: string;
    }> = {},
  ): Promise<ApiResponse> {
    const headers = new Headers();
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const method = options.method ?? "GET";
    if (method !== "GET") {
      headers.set("idempotency-key", options.idempotencyKey ?? randomUUID());
    }
    const response = await fetch(`${baseUrl}${path}`, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method,
    });
    const text = await response.text();
    return {
      body: text ? (JSON.parse(text) as unknown) : null,
      headers: response.headers,
      status: response.status,
    };
  }
});

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object response");
  }
  return value as Record<string, unknown>;
}

function arrayField(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array response");
  return value;
}

function stringField(value: unknown, field: string): string {
  const result = asRecord(value)[field];
  if (typeof result !== "string") throw new Error(`Expected string field: ${field}`);
  return result;
}

function numberField(value: unknown, field: string): number {
  const result = asRecord(value)[field];
  if (typeof result !== "number") throw new Error(`Expected number field: ${field}`);
  return result;
}

function uniquePhone(): string {
  return `137${randomInt(10_000_000, 100_000_000)}`;
}

function assertDevelopmentDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || new URL(databaseUrl).pathname.slice(1) !== "dev_xhs_agentic") {
    throw new Error("Administrator control plane test requires dev_xhs_agentic");
  }
}
