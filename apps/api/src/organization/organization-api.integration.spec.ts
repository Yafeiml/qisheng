import "reflect-metadata";

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { AdminUser, Enterprise, GlobalUser, Role, Tenant } from "@xhs-agentic/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  enterpriseAccessScope,
  platformAccessScope,
  tenantAccessScope,
} from "../access/access-scope";
import { AuthTokenService } from "../access/auth-token.service";
import { AuthorizationRepository } from "../access/authorization.repository";
import { seedAuthorizationCatalog } from "../access/authorization.seed";
import { permissionCatalog } from "../access/permission-catalog";
import { AppModule } from "../app.module";
import { configureApplication } from "../configure-application";
import { PrismaService } from "../database/prisma.service";
import { hashPassword } from "../identity/password";
import { ModelConfigurationService } from "../model-configuration/model-configuration.service";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

type ApiResponse = Readonly<{
  status: number;
  body: unknown;
  headers: Headers;
}>;

describe("organization management API authorization", { concurrent: false }, () => {
  const marker = `http-auth-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const createdModelProviderIds: string[] = [];
  const createdIndustryIds: string[] = [];
  const createdTenantIds: string[] = [];
  const createdAdminUserIds: string[] = [];
  const createdEmployeeUserIds: string[] = [];
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let tokens: AuthTokenService;
  let authorization: AuthorizationRepository;
  let platformAdmin: AdminUser;
  let tenantAdmin: AdminUser;
  let tenantViewer: AdminUser;
  let enterpriseViewer: AdminUser;
  let employeeUser: GlobalUser;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let enterpriseA: Enterprise;
  let enterpriseB: Enterprise;
  let platformAdminRole: Role;
  let tenantAdminRole: Role;
  let tenantViewerRole: Role;
  let enterpriseViewerRole: Role;
  let platformToken: string;
  let tenantAdminToken: string;
  let tenantViewerToken: string;
  let enterpriseViewerToken: string;
  let employeeToken: string;

  beforeAll(async () => {
    assertDevelopmentDatabase();
    app = await NestFactory.create(AppModule, {
      abortOnError: false,
      bodyParser: false,
      logger: ["error"],
    });
    configureApplication(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);
    authorization = app.get(AuthorizationRepository);
    await seedAuthorizationCatalog(prisma);

    [platformAdminRole, tenantAdminRole, tenantViewerRole, enterpriseViewerRole] =
      await Promise.all([
        requireRole(prisma, "PLATFORM_ADMIN"),
        requireRole(prisma, "TENANT_ADMIN"),
        requireRole(prisma, "DATA_VIEWER_TENANT"),
        requireRole(prisma, "DATA_VIEWER_ENTERPRISE"),
      ]);

    tenantA = await prisma.tenant.create({
      data: { customerType: "GROUP", name: `${marker}-tenant-a` },
    });
    tenantB = await prisma.tenant.create({
      data: { customerType: "GROUP", name: `${marker}-tenant-b` },
    });
    createdTenantIds.push(tenantA.id, tenantB.id);
    await Promise.all([
      prisma.tenantCapabilityPolicy.create({ data: { tenantId: tenantA.id } }),
      prisma.tenantCapabilityPolicy.create({ data: { tenantId: tenantB.id } }),
    ]);
    enterpriseA = await prisma.enterprise.create({
      data: {
        code: `${marker}-A`.toUpperCase(),
        name: `${marker}-enterprise-a`,
        tenantId: tenantA.id,
      },
    });
    enterpriseB = await prisma.enterprise.create({
      data: {
        code: `${marker}-B`.toUpperCase(),
        name: `${marker}-enterprise-b`,
        tenantId: tenantB.id,
      },
    });
    const users = await Promise.all(
      [0, 1, 2, 3].map((index) =>
        prisma.adminUser.create({
          data: {
            phone: testPhone(marker, index),
            phoneVerifiedAt: new Date(),
          },
        }),
      ),
    );
    platformAdmin = requiredAt(users, 0);
    tenantAdmin = requiredAt(users, 1);
    tenantViewer = requiredAt(users, 2);
    enterpriseViewer = requiredAt(users, 3);
    employeeUser = await prisma.globalUser.create({
      data: { phone: testPhone(marker, 4), phoneVerifiedAt: new Date() },
    });
    createdAdminUserIds.push(
      platformAdmin.id,
      tenantAdmin.id,
      tenantViewer.id,
      enterpriseViewer.id,
    );
    createdEmployeeUserIds.push(employeeUser.id);

    await Promise.all([
      authorization.createRoleBinding(platformAccessScope(), {
        roleId: platformAdminRole.id,
        targetScope: platformAccessScope(),
        userId: platformAdmin.id,
      }),
      authorization.createRoleBinding(platformAccessScope(), {
        roleId: tenantAdminRole.id,
        targetScope: tenantAccessScope(tenantA.id),
        userId: tenantAdmin.id,
      }),
      authorization.createRoleBinding(platformAccessScope(), {
        roleId: tenantViewerRole.id,
        targetScope: tenantAccessScope(tenantA.id),
        userId: tenantViewer.id,
      }),
      authorization.createRoleBinding(platformAccessScope(), {
        roleId: enterpriseViewerRole.id,
        targetScope: {
          enterpriseId: enterpriseA.id,
          tenantId: tenantA.id,
          type: "ENTERPRISE",
        },
        userId: enterpriseViewer.id,
      }),
    ]);

    if (!employeeUser.phone) throw new Error("Expected a phone in the employee test fixture");
    await prisma.enterpriseMembership.create({
      data: {
        enterpriseId: enterpriseA.id,
        globalUserId: employeeUser.id,
        name: "API 隔离测试员工",
        phone: employeeUser.phone,
        tenantId: tenantA.id,
      },
    });

    platformToken = tokens.issueAdminAccessToken(platformAdmin.id);
    tenantAdminToken = tokens.issueAdminAccessToken(tenantAdmin.id);
    tenantViewerToken = tokens.issueAdminAccessToken(tenantViewer.id);
    enterpriseViewerToken = tokens.issueAdminAccessToken(enterpriseViewer.id);
    employeeToken = tokens.issueEmployeeAccessToken(employeeUser.id);
  });

  afterAll(async () => {
    if (!prisma) {
      return;
    }
    const fixtureTenants = await prisma.tenant.findMany({
      select: { id: true },
      where: { name: { startsWith: marker } },
    });
    const cleanupTenantIds = [
      ...new Set([...createdTenantIds, ...fixtureTenants.map(({ id }) => id)]),
    ];
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { actorUserId: { in: [...createdAdminUserIds, ...createdEmployeeUserIds] } },
          { tenantId: { in: cleanupTenantIds } },
        ],
      },
    });
    await prisma.industry.deleteMany({ where: { id: { in: createdIndustryIds } } });
    await prisma.roleBinding.deleteMany({ where: { userId: { in: createdAdminUserIds } } });
    await prisma.modelRouteQualification.deleteMany({
      where: {
        route: {
          OR: [
            { tenantId: { in: cleanupTenantIds } },
            { imageModel: { providerId: { in: createdModelProviderIds } } },
            { textModel: { providerId: { in: createdModelProviderIds } } },
          ],
        },
      },
    });
    await prisma.modelRoute.deleteMany({
      where: {
        OR: [
          { tenantId: { in: cleanupTenantIds } },
          { imageModel: { providerId: { in: createdModelProviderIds } } },
          { textModel: { providerId: { in: createdModelProviderIds } } },
        ],
      },
    });
    await prisma.modelDefinition.deleteMany({
      where: { providerId: { in: createdModelProviderIds } },
    });
    await prisma.modelProviderHealthCheck.deleteMany({
      where: { providerId: { in: createdModelProviderIds } },
    });
    await prisma.modelProvider.updateMany({
      data: { activeCredentialId: null },
      where: { id: { in: createdModelProviderIds } },
    });
    await prisma.modelProviderCredential.deleteMany({
      where: { providerId: { in: createdModelProviderIds } },
    });
    await prisma.modelProviderInvocationLease.deleteMany({
      where: { providerId: { in: createdModelProviderIds } },
    });
    await prisma.modelProvider.deleteMany({ where: { id: { in: createdModelProviderIds } } });
    await prisma.modelInvocation.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.generatedImage.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.distributionTask.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.employeeContentRevision.deleteMany({
      where: { tenantId: { in: cleanupTenantIds } },
    });
    await prisma.employeeContent.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.generationWorkItem.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.generationRun.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.campaignBlueprint.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.campaignAudienceSnapshot.deleteMany({
      where: { tenantId: { in: cleanupTenantIds } },
    });
    await prisma.campaignPreflightSnapshot.deleteMany({
      where: { tenantId: { in: cleanupTenantIds } },
    });
    await prisma.campaignRetrievalEvidence.deleteMany({
      where: { tenantId: { in: cleanupTenantIds } },
    });
    await prisma.campaign.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.materialEmbedding.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.materialChunk.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.materialIngestionJob.deleteMany({
      where: { tenantId: { in: cleanupTenantIds } },
    });
    await prisma.materialArtifact.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.material.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.enterpriseMembership.deleteMany({
      where: { tenantId: { in: cleanupTenantIds } },
    });
    await prisma.platformCustomerNote.deleteMany({
      where: { tenantId: { in: cleanupTenantIds } },
    });
    await prisma.storageUsageLedger.deleteMany({
      where: { tenantId: { in: cleanupTenantIds } },
    });
    await prisma.storageReservation.deleteMany({
      where: { tenantId: { in: cleanupTenantIds } },
    });
    await prisma.tenantStorageAccount.deleteMany({
      where: { tenantId: { in: cleanupTenantIds } },
    });
    await prisma.customerContract.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.enterprise.deleteMany({ where: { tenantId: { in: cleanupTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: cleanupTenantIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: createdAdminUserIds } } });
    await prisma.globalUser.deleteMany({ where: { id: { in: createdEmployeeUserIds } } });
    await app.close();
  });

  it("requires a Bearer token", async () => {
    const response = await apiRequest("/platform/tenants");

    expect(response.status).toBe(401);
  });

  it("rejects an employee-audience token on SaaS APIs", async () => {
    const response = await apiRequest("/platform/tenants", { token: employeeToken });

    expect(response.status).toBe(401);
  });

  it("does not let a tenant role enter platform routes", async () => {
    const response = await apiRequest("/platform/tenants", { token: tenantAdminToken });

    expect(response.status).toBe(403);
  });

  it("allows a platform administrator to list tenants", async () => {
    const response = await apiRequest("/platform/tenants", { token: platformToken });

    expect(response.status).toBe(200);
    expect(arrayIds(response.body)).toEqual(expect.arrayContaining([tenantA.id, tenantB.id]));
  });

  it("discovers only the authenticated administrator's active SaaS scopes", async () => {
    const platformSession = await apiRequest("/auth/admin/session", { token: platformToken });
    expect(platformSession.status).toBe(200);
    const platformScopes = arrayField(platformSession.body, "scopes");
    expect(platformScopes).toHaveLength(1);
    expect(stringField(platformScopes[0], "scopeType")).toBe("PLATFORM");

    const tenantSession = await apiRequest("/auth/admin/session", { token: tenantAdminToken });
    expect(tenantSession.status).toBe(200);
    const tenantScope = asRecord(arrayField(tenantSession.body, "scopes")[0]);
    expect(tenantScope.scopeType).toBe("TENANT");
    expect(arrayIds(tenantScope.inheritedEnterprises)).toContain(enterpriseA.id);
    expect(JSON.stringify(tenantSession.body)).not.toContain(enterpriseB.id);

    const enterpriseSession = await apiRequest("/auth/admin/session", {
      token: enterpriseViewerToken,
    });
    expect(enterpriseSession.status).toBe(200);
    const enterpriseScope = asRecord(arrayField(enterpriseSession.body, "scopes")[0]);
    expect(enterpriseScope.scopeType).toBe("ENTERPRISE");
    expect(objectId(enterpriseScope.enterprise)).toBe(enterpriseA.id);
    expect(enterpriseScope.inheritedEnterprises).toEqual([]);

    const employeeDenied = await apiRequest("/auth/admin/session", { token: employeeToken });
    expect(employeeDenied.status).toBe(401);
  });

  it("validates and rejects unknown request properties", async () => {
    const response = await apiRequest("/platform/tenants", {
      body: {
        customerType: "GROUP",
        name: `${marker}-invalid-tenant`,
        unexpected: true,
      },
      method: "POST",
      token: platformToken,
    });

    expect(response.status).toBe(400);
  });

  it("refuses creating another root organization outside installation", async () => {
    const response = await apiRequest("/platform/tenants", {
      body: { customerType: "GROUP", name: `${marker}-created-by-api` },
      method: "POST",
      token: platformToken,
    });

    expect(response.status).toBe(403);
    await expect(
      prisma.tenant.findFirst({ where: { name: `${marker}-created-by-api` } }),
    ).resolves.toBeNull();
  });

  it("keeps a tenant administrator inside its own tenant", async () => {
    const own = await apiRequest(`/console/tenants/${tenantA.id}/enterprises`, {
      token: tenantAdminToken,
    });
    const foreign = await apiRequest(`/console/tenants/${tenantB.id}/enterprises`, {
      token: tenantAdminToken,
    });

    expect(own.status).toBe(200);
    expect(arrayIds(own.body)).toContain(enterpriseA.id);
    expect(foreign.status).toBe(403);
  });

  it("edits industry guidance only in platform scope with conflict detection and an audit", async () => {
    const created = await apiRequest("/platform/industries", {
      token: platformToken,
      method: "POST",
      body: { name: `${marker}-规则`, generationGuidance: "原始规则" },
    });
    expect(created.status).toBe(201);
    const id = objectId(created.body);
    createdIndustryIds.push(id);
    const before = await prisma.industry.findUniqueOrThrow({ where: { id } });
    const path = `/platform/industries/${id}/generation-guidance`;
    const body = {
      generationGuidance: "只使用有依据的主体身份，保留数字口径。",
      expectedUpdatedAt: before.updatedAt.toISOString(),
    };
    expect(
      (await apiRequest(path, { token: tenantAdminToken, method: "PATCH", body })).status,
    ).toBe(403);
    const saved = await apiRequest(path, { token: platformToken, method: "PATCH", body });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ generationGuidance: body.generationGuidance });
    expect((await apiRequest(path, { token: platformToken, method: "PATCH", body })).status).toBe(
      409,
    );
    const after = await prisma.industry.findUniqueOrThrow({ where: { id } });
    expect(after.generationGuidance).toBe(body.generationGuidance);
    expect(
      await prisma.auditLog.findFirst({
        where: { action: "industry.guidance.update", resourceId: id },
      }),
    ).toMatchObject({ actorUserId: platformAdmin.id });
    expect(
      (
        await apiRequest(path, {
          token: platformToken,
          method: "PATCH",
          body: {
            ...body,
            expectedUpdatedAt: after.updatedAt.toISOString(),
            generationGuidance: "a".repeat(6001),
          },
        })
      ).status,
    ).toBe(400);
    const publicList = await apiRequest(`/console/tenants/${tenantA.id}/industries`, {
      token: tenantAdminToken,
    });
    expect(
      (publicList.body as Array<Record<string, unknown>>).find((row) => row.id === id),
    ).not.toHaveProperty("generationGuidance");
    expect(
      (
        await apiRequest(path, {
          token: platformToken,
          method: "PATCH",
          body: { generationGuidance: "", expectedUpdatedAt: after.updatedAt.toISOString() },
        })
      ).status,
    ).toBe(200);
  });

  it("manages preset industries and only accepts a preset when changing enterprise profile", async () => {
    const platformList = await apiRequest("/platform/industries", { token: platformToken });
    const tenantList = await apiRequest(`/console/tenants/${tenantA.id}/industries`, {
      token: tenantAdminToken,
    });

    expect(platformList.status).toBe(200);
    expect(tenantList.status).toBe(200);
    expect(JSON.stringify(platformList.body)).toContain("医疗健康");

    const name = `${marker}-新能源`;
    const created = await apiRequest("/platform/industries", {
      body: { name },
      method: "POST",
      token: platformToken,
    });
    expect(created.status).toBe(201);
    const industryId = objectId(created.body);
    createdIndustryIds.push(industryId);
    await expect(
      prisma.auditLog.findFirst({
        where: {
          action: "industry.create",
          actorUserId: platformAdmin.id,
          resourceId: industryId,
        },
      }),
    ).resolves.not.toBeNull();

    const duplicate = await apiRequest("/platform/industries", {
      body: { name },
      method: "POST",
      token: platformToken,
    });
    expect(duplicate.status).toBe(409);

    await prisma.enterprise.update({
      data: { industry: "历史自定义行业" },
      where: { id: enterpriseA.id },
    });
    const legacyProfile = await apiRequest(
      `/console/tenants/${tenantA.id}/enterprises/${enterpriseA.id}/profile`,
      {
        body: { industry: "历史自定义行业" },
        method: "POST",
        token: tenantAdminToken,
      },
    );
    expect(legacyProfile.status).toBe(201);

    const selectedProfile = await apiRequest(
      `/console/tenants/${tenantA.id}/enterprises/${enterpriseA.id}/profile`,
      {
        body: { industry: name },
        method: "POST",
        token: tenantAdminToken,
      },
    );
    expect(selectedProfile.status).toBe(201);
    expect(stringField(selectedProfile.body, "industry")).toBe(name);

    const invalidProfile = await apiRequest(
      `/console/tenants/${tenantA.id}/enterprises/${enterpriseA.id}/profile`,
      {
        body: { industry: "未配置行业" },
        method: "POST",
        token: tenantAdminToken,
      },
    );
    expect(invalidProfile.status).toBe(409);
  });

  it("requires the write permission even when the tenant scope matches", async () => {
    const response = await apiRequest(`/console/tenants/${tenantA.id}/enterprises`, {
      body: { code: `${marker}-viewer-denied`, name: "不应创建的企业" },
      method: "POST",
      token: tenantViewerToken,
    });

    expect(response.status).toBe(403);
  });

  it("keeps enterprise codes unique across customers at the database boundary", async () => {
    await expect(
      prisma.enterprise.create({
        data: { code: enterpriseA.code, name: "跨客户重复企业代码", tenantId: tenantB.id },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("creates an enterprise without an unusable phone-only administrator and audits it", async () => {
    const administratorPhone = validPhone(`${marker}42`);
    const response = await apiRequest(`/console/tenants/${tenantA.id}/enterprises`, {
      body: { code: `${marker}-created`, name: "API 创建企业" },
      method: "POST",
      token: tenantAdminToken,
    });
    expect(response.status).toBe(201);
    const enterpriseId = objectId(response.body);
    expect(stringField(response.body, "code")).toMatch(/^ENT_[A-F0-9]{32}$/u);
    expect(stringField(response.body, "code")).not.toBe(`${marker}-created`);
    const enterpriseCount = await prisma.enterprise.count({ where: { tenantId: tenantA.id } });
    const legacyAdministrator = await apiRequest(`/console/tenants/${tenantA.id}/enterprises`, {
      body: { administratorPhone, name: "不应生成手机号管理员的企业" },
      method: "POST",
      token: tenantAdminToken,
    });
    expect(legacyAdministrator.status).toBe(409);
    expect(stringField(legacyAdministrator.body, "message")).toContain("账号管理");
    expect(await prisma.enterprise.count({ where: { tenantId: tenantA.id } })).toBe(
      enterpriseCount,
    );
    await expect(
      prisma.adminUser.findUnique({ where: { phone: administratorPhone } }),
    ).resolves.toBeNull();
    await expect(
      prisma.roleBinding.findFirst({ where: { enterpriseId, scopeType: "ENTERPRISE" } }),
    ).resolves.toBeNull();

    const refreshedTenantSession = await apiRequest("/auth/admin/session", {
      token: tenantAdminToken,
    });
    const refreshedTenantScope = asRecord(arrayField(refreshedTenantSession.body, "scopes")[0]);
    expect(arrayIds(refreshedTenantScope.inheritedEnterprises)).toContain(enterpriseId);

    const updated = await apiRequest(
      `/console/tenants/${tenantA.id}/enterprises/${enterpriseId}/profile`,
      {
        body: {
          brandName: "集团品牌中心",
          city: "杭州",
          industry: "医疗健康",
          name: "API 创建企业升级",
        },
        method: "POST",
        token: tenantAdminToken,
      },
    );
    expect(updated.status).toBe(201);
    expect(asRecord(updated.body)).toMatchObject({
      brandName: "集团品牌中心",
      city: "杭州",
      name: "API 创建企业升级",
    });
    const viewerDenied = await apiRequest(
      `/console/tenants/${tenantA.id}/enterprises/${enterpriseA.id}/profile`,
      {
        body: { name: "不应被修改" },
        method: "POST",
        token: enterpriseViewerToken,
      },
    );
    expect(viewerDenied.status).toBe(403);
    const disabled = await apiRequest(
      `/console/tenants/${tenantA.id}/enterprises/${enterpriseId}/status`,
      {
        body: { reason: "组织管理回归测试", status: "DISABLED" },
        method: "POST",
        token: tenantAdminToken,
      },
    );
    expect(disabled.status).toBe(201);
    expect(asRecord(disabled.body).status).toBe("DISABLED");
    await expect(
      prisma.auditLog.findFirst({
        where: {
          action: "enterprise.create",
          actorUserId: tenantAdmin.id,
          enterpriseId,
          tenantId: tenantA.id,
        },
      }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.auditLog.findFirst({
        where: {
          action: "enterprise.disable",
          actorUserId: tenantAdmin.id,
          enterpriseId,
          reason: "组织管理回归测试",
          tenantId: tenantA.id,
        },
      }),
    ).resolves.not.toBeNull();
  });

  it("derives an enterprise workspace without exposing platform model configuration", async () => {
    const own = await apiRequest(
      `/console/tenants/${tenantA.id}/enterprises/${enterpriseA.id}/workspace`,
      { token: enterpriseViewerToken },
    );
    const foreign = await apiRequest(
      `/console/tenants/${tenantB.id}/enterprises/${enterpriseB.id}/workspace`,
      { token: enterpriseViewerToken },
    );
    const employee = await apiRequest(
      `/console/tenants/${tenantA.id}/enterprises/${enterpriseA.id}/workspace`,
      { token: employeeToken },
    );

    expect(own.status).toBe(200);
    expect(asRecord(own.body)).toMatchObject({
      campaignReady: false,
      campaigns: {
        active: 0,
        approved: 0,
        completed: 0,
        generating: 0,
        generationFailed: 0,
        reviewPending: 0,
        total: 0,
      },
      capabilities: expect.objectContaining({ imagesPerDistribution: 1 }),
      nextAction: { code: "ADD_MATERIAL", href: "/console/materials" },
    });
    expect(JSON.stringify(own.body)).not.toMatch(/provider|endpoint|credential|apiKey|modelName/iu);
    expect(foreign.status).toBe(403);
    expect(employee.status).toBe(401);
  });

  it("keeps an enterprise viewer inside its exact enterprise", async () => {
    const own = await apiRequest(
      `/console/tenants/${tenantA.id}/enterprises/${enterpriseA.id}/memberships`,
      { token: enterpriseViewerToken },
    );
    const foreign = await apiRequest(
      `/console/tenants/${tenantB.id}/enterprises/${enterpriseB.id}/memberships`,
      { token: enterpriseViewerToken },
    );

    expect(own.status).toBe(200);
    expect(Array.isArray(arrayField(own.body, "items"))).toBe(true);
    expect(asRecord(own.body)).toHaveProperty("pageInfo");
    expect(foreign.status).toBe(403);
  });

  it("invalidates an existing token immediately when its user is disabled", async () => {
    await prisma.adminUser.update({
      data: { status: "DISABLED" },
      where: { id: tenantViewer.id },
    });
    const response = await apiRequest(`/console/tenants/${tenantA.id}/enterprises`, {
      token: tenantViewerToken,
    });

    expect(response.status).toBe(401);
  });

  it("restricts model configuration to platform scope and never exposes credential references", async () => {
    const unauthorizedCredential = "CUSTOMER_MUST_NOT_CONFIGURE_THIS_KEY";
    const denied = await Promise.all([
      apiRequest("/platform/model-catalog", { token: tenantAdminToken }),
      apiRequest("/platform/model-catalog", { token: enterpriseViewerToken }),
      apiRequest("/platform/model-catalog", { token: employeeToken }),
      apiRequest("/platform/model-providers", {
        body: { apiKey: unauthorizedCredential },
        method: "POST",
        token: tenantAdminToken,
      }),
      apiRequest("/platform/model-providers", {
        body: { apiKey: unauthorizedCredential },
        method: "POST",
        token: enterpriseViewerToken,
      }),
      apiRequest("/platform/model-providers/not-authorized/models", {
        body: {},
        method: "POST",
        token: tenantAdminToken,
      }),
      apiRequest("/platform/model-providers/not-authorized/models", {
        body: {},
        method: "POST",
        token: enterpriseViewerToken,
      }),
      apiRequest("/platform/model-routes", {
        body: {},
        method: "POST",
        token: tenantAdminToken,
      }),
      apiRequest("/platform/model-routes", {
        body: {},
        method: "POST",
        token: enterpriseViewerToken,
      }),
      apiRequest("/platform/model-providers/not-authorized/credentials/rotate", {
        body: { apiKey: unauthorizedCredential, reason: "越权测试" },
        method: "POST",
        token: tenantAdminToken,
      }),
      apiRequest("/platform/model-providers/not-authorized/credentials/revoke", {
        body: { reason: "越权测试" },
        method: "POST",
        token: enterpriseViewerToken,
      }),
      apiRequest("/platform/model-providers/not-authorized/test-connection", {
        method: "POST",
        token: tenantAdminToken,
      }),
      apiRequest("/platform/model-providers/not-authorized/settings", {
        body: { reason: "越权测试", status: "DISABLED" },
        method: "POST",
        token: tenantAdminToken,
      }),
      apiRequest("/platform/model-providers/not-authorized/circuit/reset", {
        body: { reason: "越权测试" },
        method: "POST",
        token: tenantAdminToken,
      }),
      apiRequest("/platform/model-definitions/not-authorized/settings", {
        body: { reason: "越权测试", status: "DISABLED" },
        method: "POST",
        token: enterpriseViewerToken,
      }),
    ]);
    expect(denied.map(({ status }) => status)).toEqual([
      403, 403, 401, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403,
    ]);
    expect(JSON.stringify(denied.map(({ body }) => body))).not.toContain(unauthorizedCredential);

    const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const providerResponse = await apiRequest("/platform/model-providers", {
      body: {
        baseUrl: "synthetic://local",
        code: `TEST_${suffix}`,
        name: "模型配置 API 测试 Provider",
        synthetic: true,
        timeoutMs: 10_000,
      },
      method: "POST",
      token: platformToken,
    });
    expect(providerResponse.status).toBe(201);
    const provider = asRecord(providerResponse.body);
    const providerId = stringField(provider, "id");
    createdModelProviderIds.push(providerId);
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider.credentialConfigured).toBe(true);
    expect(provider.credentialRequired).toBe(false);

    await prisma.modelProvider.update({
      data: {
        circuitOpenUntil: new Date(Date.now() + 60_000),
        circuitOpenedAt: new Date(),
        circuitProbeToken: "must-never-be-returned",
        circuitState: "OPEN",
        runtimeFailureCount: 5,
      },
      where: { id: providerId },
    });
    const circuitReset = await apiRequest(`/platform/model-providers/${providerId}/circuit/reset`, {
      body: { reason: "集成测试人工恢复" },
      method: "POST",
      token: platformToken,
    });
    expect(circuitReset.status).toBe(200);
    expect(asRecord(circuitReset.body)).toMatchObject({
      circuitState: "CLOSED",
      runtimeFailureCount: 0,
    });
    expect(asRecord(circuitReset.body)).not.toHaveProperty("circuitProbeToken");
    expect(asRecord(circuitReset.body)).not.toHaveProperty("activeCredentialId");

    const healthCheck = await apiRequest(
      `/platform/model-providers/${providerId}/test-connection`,
      { method: "POST", token: platformToken },
    );
    expect(healthCheck.status).toBe(201);
    expect(asRecord(healthCheck.body)).toMatchObject({
      healthy: true,
      providerId,
      status: "HEALTHY",
    });

    const textModelResponse = await apiRequest(`/platform/model-providers/${providerId}/models`, {
      body: {
        capabilities: ["TEXT"],
        code: `TEXT_${suffix}`,
        displayName: "Synthetic Text",
        externalModelId: `synthetic-text-${suffix.toLowerCase()}`,
        synthetic: true,
      },
      method: "POST",
      token: platformToken,
    });
    const imageModelResponse = await apiRequest(`/platform/model-providers/${providerId}/models`, {
      body: {
        capabilities: ["IMAGE"],
        code: `IMAGE_${suffix}`,
        displayName: "Synthetic Image",
        externalModelId: `synthetic-image-${suffix.toLowerCase()}`,
        synthetic: true,
      },
      method: "POST",
      token: platformToken,
    });
    expect(textModelResponse.status).toBe(201);
    expect(imageModelResponse.status).toBe(201);
    const textModelId = stringField(textModelResponse.body, "id");
    const imageModelId = stringField(imageModelResponse.body, "id");

    const invalidRoute = await apiRequest("/platform/model-routes", {
      body: {
        enterpriseId: enterpriseA.id,
        imageModelId: textModelId,
        scopeId: enterpriseA.id,
        scopeType: "ENTERPRISE",
        tenantId: tenantA.id,
        textModelId,
      },
      method: "POST",
      token: platformToken,
    });
    expect(invalidRoute.status).toBe(409);

    const route = await apiRequest("/platform/model-routes", {
      body: {
        enterpriseId: enterpriseA.id,
        imageModelId,
        scopeId: enterpriseA.id,
        scopeType: "ENTERPRISE",
        tenantId: tenantA.id,
        textModelId,
      },
      method: "POST",
      token: platformToken,
    });
    expect(route.status).toBe(201);
    expect(stringField(route.body, "scopeType")).toBe("ENTERPRISE");
    expect(JSON.stringify(route.body)).not.toContain(unauthorizedCredential);
    expect(asRecord(asRecord(asRecord(route.body).imageModel).provider)).not.toHaveProperty(
      "apiKey",
    );
    expect(asRecord(asRecord(asRecord(route.body).textModel).provider)).not.toHaveProperty(
      "apiKey",
    );

    const guardedProviderDisable = await apiRequest(
      `/platform/model-providers/${providerId}/settings`,
      {
        body: { reason: "验证路由保护", status: "DISABLED" },
        method: "POST",
        token: platformToken,
      },
    );
    expect(guardedProviderDisable.status).toBe(409);
    const emergencyProviderDisable = await apiRequest(
      `/platform/model-providers/${providerId}/settings`,
      {
        body: { emergency: true, reason: "模拟供应商紧急故障", status: "DISABLED" },
        method: "POST",
        token: platformToken,
      },
    );
    expect(emergencyProviderDisable.status).toBe(200);
    const providerEnable = await apiRequest(`/platform/model-providers/${providerId}/settings`, {
      body: { reason: "紧急故障恢复", status: "ACTIVE" },
      method: "POST",
      token: platformToken,
    });
    expect(providerEnable.status).toBe(200);

    const guardedModelDisable = await apiRequest(
      `/platform/model-definitions/${textModelId}/settings`,
      {
        body: { reason: "验证模型路由保护", status: "DISABLED" },
        method: "POST",
        token: platformToken,
      },
    );
    expect(guardedModelDisable.status).toBe(409);
    const emergencyModelDisable = await apiRequest(
      `/platform/model-definitions/${textModelId}/settings`,
      {
        body: { emergency: true, reason: "模拟模型紧急故障", status: "DISABLED" },
        method: "POST",
        token: platformToken,
      },
    );
    expect(emergencyModelDisable.status).toBe(200);
    const modelEnable = await apiRequest(`/platform/model-definitions/${textModelId}/settings`, {
      body: { reason: "模型故障恢复", status: "ACTIVE" },
      method: "POST",
      token: platformToken,
    });
    expect(modelEnable.status).toBe(200);

    const routeTenant = await prisma.tenant.create({
      data: { customerType: "GROUP", name: `${marker}-route-precedence` },
    });
    createdTenantIds.push(routeTenant.id);
    const routeEnterprise = await prisma.enterprise.create({
      data: {
        code: `ROUTE_${suffix}`,
        name: `${marker}-route-enterprise`,
        tenantId: routeTenant.id,
      },
    });
    const modelConfiguration = await app.resolve(ModelConfigurationService);

    const tenantRoute = await apiRequest("/platform/model-routes", {
      body: {
        imageModelId,
        scopeId: routeTenant.id,
        scopeType: "TENANT",
        tenantId: routeTenant.id,
        textModelId,
      },
      method: "POST",
      token: platformToken,
    });
    expect(tenantRoute.status).toBe(201);
    await expect(
      modelConfiguration.resolveRoute(routeTenant.id, routeEnterprise.id),
    ).resolves.toMatchObject({ scopeType: "TENANT" });

    const enterpriseRoute = await apiRequest("/platform/model-routes", {
      body: {
        enterpriseId: routeEnterprise.id,
        imageModelId,
        scopeId: routeEnterprise.id,
        scopeType: "ENTERPRISE",
        tenantId: routeTenant.id,
        textModelId,
      },
      method: "POST",
      token: platformToken,
    });
    expect(enterpriseRoute.status).toBe(201);
    await expect(
      modelConfiguration.resolveRoute(routeTenant.id, routeEnterprise.id),
    ).resolves.toMatchObject({ scopeType: "ENTERPRISE" });

    const catalogResponse = await apiRequest("/platform/model-catalog", {
      token: platformToken,
    });
    expect(catalogResponse.status).toBe(200);
    expect(JSON.stringify(catalogResponse.body)).not.toContain(unauthorizedCredential);
    const catalogProvider = arrayField(catalogResponse.body, "providers").find(
      (item) => stringField(item, "id") === providerId,
    );
    expect(catalogProvider).toBeDefined();
    expect(asRecord(catalogProvider).credentialConfigured).toBe(true);
    expect(asRecord(catalogProvider)).not.toHaveProperty("apiKey");
  });

  it("encrypts, rotates and revokes platform-managed provider credentials", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const firstApiKey = `sk-first-${suffix}-private`;
    const secondApiKey = `sk-second-${suffix}-private`;
    const created = await apiRequest("/platform/model-providers", {
      body: {
        apiKey: firstApiKey,
        baseUrl: "https://provider.invalid/v1",
        code: `REAL_${suffix}`,
        name: "加密凭据测试 Provider",
        synthetic: false,
      },
      method: "POST",
      token: platformToken,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain(firstApiKey);
    const providerId = stringField(created.body, "id");
    createdModelProviderIds.push(providerId);

    const firstCredential = await prisma.modelProviderCredential.findFirstOrThrow({
      where: { providerId, status: "ACTIVE" },
    });
    expect(Buffer.from(firstCredential.ciphertext).toString("utf8")).not.toContain(firstApiKey);
    expect(firstCredential.lastFour).toBe(firstApiKey.slice(-4));

    const rotated = await apiRequest(`/platform/model-providers/${providerId}/credentials/rotate`, {
      body: { apiKey: secondApiKey, reason: "供应商密钥例行轮换" },
      method: "POST",
      token: platformToken,
    });
    expect(rotated.status).toBe(201);
    expect(JSON.stringify(rotated.body)).not.toContain(secondApiKey);
    const credentialRows = await prisma.modelProviderCredential.findMany({
      orderBy: { createdAt: "asc" },
      where: { providerId },
    });
    expect(credentialRows.map(({ status }) => status)).toEqual(["REVOKED", "ACTIVE"]);
    expect(credentialRows[0]?.revokeReason).toBe("供应商密钥例行轮换");

    const revoked = await apiRequest(`/platform/model-providers/${providerId}/credentials/revoke`, {
      body: { reason: "停用测试凭据" },
      method: "POST",
      token: platformToken,
    });
    expect(revoked.status).toBe(200);
    expect(asRecord(revoked.body).credentialConfigured).toBe(false);

    const sensitiveAudit = await prisma.auditLog.findMany({
      where: { resourceId: providerId, resourceType: "ModelProvider" },
    });
    const serializedAudit = JSON.stringify(sensitiveAudit);
    expect(serializedAudit).not.toContain(firstApiKey);
    expect(serializedAudit).not.toContain(secondApiKey);
  });

  it("tests a real provider connection with the decrypted credential without exposing it", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const apiKey = `sk-probe-${suffix}-private`;
    const probe = await startModelProviderProbe(apiKey);
    try {
      const created = await apiRequest("/platform/model-providers", {
        body: {
          apiKey,
          baseUrl: `${probe.baseUrl}/v1`,
          code: `PROBE_${suffix}`,
          name: "连接探测测试 Provider",
          synthetic: false,
        },
        method: "POST",
        token: platformToken,
      });
      expect(created.status).toBe(201);
      const providerId = stringField(created.body, "id");
      createdModelProviderIds.push(providerId);

      const health = await apiRequest(`/platform/model-providers/${providerId}/test-connection`, {
        method: "POST",
        token: platformToken,
      });
      expect(health.status).toBe(201);
      expect(asRecord(health.body)).toMatchObject({
        errorCode: null,
        healthy: true,
        httpStatus: 200,
        providerId,
        status: "HEALTHY",
      });
      expect(probe.authorizationHeaders).toEqual([`Bearer ${apiKey}`]);
      expect(JSON.stringify(health.body)).not.toContain(apiKey);
      const storedProvider = await prisma.modelProvider.findUniqueOrThrow({
        where: { id: providerId },
      });
      expect(storedProvider).toMatchObject({
        consecutiveHealthFailures: 0,
        healthStatus: "HEALTHY",
        lastHealthErrorCode: null,
      });
    } finally {
      await probe.close();
    }
  });

  it("aggregates a tenant-only group overview without exposing platform diagnostics", async () => {
    const now = new Date();
    if (!employeeUser.phone) throw new Error("Expected a phone in the employee test fixture");
    const membership = await prisma.enterpriseMembership.update({
      data: {
        boundAt: now,
        seatEnabledAt: now,
        seatStatus: "ENABLED",
        status: "ACTIVE",
      },
      where: { enterpriseId_phone: { enterpriseId: enterpriseA.id, phone: employeeUser.phone } },
    });
    const sharedMaterial = await prisma.material.create({
      data: {
        authorizationStatus: "AUTHORIZED",
        content: "集团授权公共内容",
        createdBy: tenantAdmin.id,
        expiresAt: new Date(now.getTime() + 10 * 86_400_000),
        ingestionStatus: "READY",
        readyAt: now,
        scopeKey: "__tenant__",
        tenantId: tenantA.id,
        title: "集团公共素材",
        type: "TEXT",
      },
    });
    const privateMaterial = await prisma.material.create({
      data: {
        authorizationStatus: "AUTHORIZED",
        content: "企业授权内容",
        createdBy: tenantAdmin.id,
        enterpriseId: enterpriseA.id,
        ingestionStatus: "READY",
        readyAt: now,
        scopeKey: enterpriseA.id,
        tenantId: tenantA.id,
        title: "企业素材",
        type: "TEXT",
      },
    });
    const chunk = await prisma.materialChunk.create({
      data: {
        characterCount: 8,
        materialId: sharedMaterial.id,
        ordinal: 0,
        scopeKey: "__tenant__",
        tenantId: tenantA.id,
        text: "集团授权公共内容",
        textChecksum: randomUUID().replaceAll("-", "").repeat(2),
        tokenCount: 8,
      },
    });
    const campaign = await prisma.campaign.create({
      data: {
        audienceCount: 1,
        createdBy: tenantAdmin.id,
        enterpriseId: enterpriseA.id,
        expiresAt: new Date(now.getTime() + 23 * 3_600_000),
        generatedCount: 1,
        prompt: "集团总览聚合测试",
        status: "DRAFT",
        tenantId: tenantA.id,
        title: "集团总览测试活动",
        visibleAt: new Date(now.getTime() - 3_600_000),
      },
    });
    const snapshot = await prisma.campaignAudienceSnapshot.create({
      data: {
        campaignId: campaign.id,
        employeeName: membership.name,
        employeePhone: membership.phone,
        enterpriseId: enterpriseA.id,
        membershipId: membership.id,
        tenantId: tenantA.id,
      },
    });
    const run = await prisma.generationRun.create({
      data: {
        campaignId: campaign.id,
        completedCount: 1,
        imageModel: "platform-internal-image-model",
        provider: "platform-internal-provider",
        requestedCount: 1,
        finishedAt: now,
        startedAt: now,
        status: "SUCCEEDED",
        synthetic: true,
        tenantId: tenantA.id,
        textModel: "platform-internal-text-model",
      },
    });
    await prisma.generationWorkItem.create({
      data: {
        audienceSnapshotId: snapshot.id,
        campaignId: campaign.id,
        enterpriseId: enterpriseA.id,
        finishedAt: now,
        generationRunId: run.id,
        membershipId: membership.id,
        startedAt: now,
        status: "SUCCEEDED",
        tenantId: tenantA.id,
      },
    });
    await prisma.campaignRetrievalEvidence.create({
      data: {
        campaignId: campaign.id,
        chunkId: chunk.id,
        enterpriseId: enterpriseA.id,
        frozenSnippet: chunk.text,
        hitReasons: ["集团公共素材命中"],
        lexicalScore: 1,
        materialId: sharedMaterial.id,
        materialScopeKey: "__tenant__",
        materialSeriesId: sharedMaterial.seriesId,
        materialTitle: sharedMaterial.title,
        materialType: sharedMaterial.type,
        materialVersion: sharedMaterial.version,
        rank: 1,
        score: 1,
        strategyVersion: "sprint8-test",
        tagScore: 0,
        tenantId: tenantA.id,
        vectorScore: 0,
      },
    });

    try {
      const [own, foreign, platformDenied, enterpriseDenied, employeeDenied] = await Promise.all([
        apiRequest(`/console/tenants/${tenantA.id}/group-overview`, {
          token: tenantAdminToken,
        }),
        apiRequest(`/console/tenants/${tenantB.id}/group-overview`, {
          token: tenantAdminToken,
        }),
        apiRequest(`/console/tenants/${tenantA.id}/group-overview`, { token: platformToken }),
        apiRequest(`/console/tenants/${tenantA.id}/group-overview`, {
          token: enterpriseViewerToken,
        }),
        apiRequest(`/console/tenants/${tenantA.id}/group-overview`, { token: employeeToken }),
      ]);

      expect(own.status).toBe(200);
      expect(foreign.status).toBe(403);
      expect(platformDenied.status).toBe(403);
      expect(enterpriseDenied.status).toBe(403);
      expect(employeeDenied.status).toBe(401);
      const overview = asRecord(own.body);
      expect(asRecord(overview.summary)).toMatchObject({
        activeEnterprises: 1,
        enabledSeats: 1,
        totalEnterprises: 2,
      });
      const enterprise = arrayField(overview, "enterprises").find(
        (item) => objectId(item) === enterpriseA.id,
      );
      expect(asRecord(enterprise)).toMatchObject({
        campaignReady: true,
        campaigns: { DRAFT: 1 },
        effectiveMaterials: 2,
        enabledSeats: 1,
        generation: { failed: 0, running: 0, succeeded: 1, successRate: 1 },
      });
      const sharedMaterials = asRecord(overview.sharedMaterials);
      expect(sharedMaterials.effectiveCount).toBe(1);
      expect(arrayField(sharedMaterials, "expiring")).toEqual([
        expect.objectContaining({ id: sharedMaterial.id, title: sharedMaterial.title }),
      ]);
      expect(arrayField(sharedMaterials, "usage")).toEqual([
        expect.objectContaining({
          enterpriseId: enterpriseA.id,
          hitCount: 1,
          materialId: sharedMaterial.id,
        }),
      ]);
      expect(JSON.stringify(own.body)).not.toMatch(
        /provider|endpoint|credential|apiKey|modelName|textModel|imageModel|cost/iu,
      );
    } finally {
      await prisma.campaignRetrievalEvidence.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.generationWorkItem.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.generationRun.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.campaignAudienceSnapshot.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.campaign.delete({ where: { id: campaign.id } });
      await prisma.materialEmbedding.deleteMany({
        where: { materialId: { in: [sharedMaterial.id, privateMaterial.id] } },
      });
      await prisma.materialChunk.deleteMany({ where: { materialId: sharedMaterial.id } });
      await prisma.material.deleteMany({
        where: { id: { in: [sharedMaterial.id, privateMaterial.id] } },
      });
    }
  });

  it("exposes real platform operations data only to platform monitoring scope", async () => {
    const denied = await apiRequest("/platform/operations/overview", {
      token: tenantAdminToken,
    });
    expect(denied.status).toBe(403);

    const overviewResponse = await apiRequest("/platform/operations/overview", {
      token: platformToken,
    });
    expect(overviewResponse.status).toBe(200);
    const overview = asRecord(overviewResponse.body);
    const tenants = asRecord(overview.tenants);
    const generation = asRecord(overview.generation);
    const models = asRecord(overview.models);
    expect(tenants.activeTenants).toEqual(expect.any(Number));
    expect(tenants.activeEnterprises).toEqual(expect.any(Number));
    expect(generation.runsByStatus).toEqual(expect.any(Object));
    expect(generation.workItemsByStatus).toEqual(expect.any(Object));
    expect(asRecord(generation.queue)).toMatchObject({
      active: expect.any(Number),
      waiting: expect.any(Number),
      workers: expect.any(Number),
    });
    expect(models.activeProviders).toEqual(expect.any(Number));
    expect(overview.generatedAt).toEqual(expect.any(String));

    const runsResponse = await apiRequest("/platform/operations/generation-runs", {
      token: platformToken,
    });
    expect(runsResponse.status).toBe(200);
    expect(Array.isArray(arrayField(runsResponse.body, "items"))).toBe(true);
    expect(asRecord(runsResponse.body)).toHaveProperty("pageInfo");

    const [readiness, deniedReadiness] = await Promise.all([
      apiRequest(
        `/platform/operations/customers/${tenantA.id}/enterprises/${enterpriseA.id}/readiness`,
        { token: platformToken },
      ),
      apiRequest(
        `/platform/operations/customers/${tenantA.id}/enterprises/${enterpriseA.id}/readiness`,
        { token: tenantAdminToken },
      ),
    ]);
    expect(readiness.status).toBe(200);
    expect(asRecord(readiness.body)).toMatchObject({
      campaignReady: expect.any(Boolean),
      enterprise: { id: enterpriseA.id },
      nextAction: { code: expect.any(String) },
    });
    expect(JSON.stringify(readiness.body)).not.toMatch(
      /provider|endpoint|credential|apiKey|modelName/iu,
    );
    expect(deniedReadiness.status).toBe(403);

    const customerPage = await apiRequest("/platform/operations/customers", {
      token: platformToken,
    });
    const customer = arrayField(customerPage.body, "items").find(
      (item) => objectId(item) === tenantA.id,
    );
    expect(customer).toBeDefined();
    const customerRecord = asRecord(customer);
    const filterQuery = new URLSearchParams({
      customerType: String(customerRecord.customerType),
      enterpriseCode: enterpriseA.code,
      enterpriseState: "HAS_ENTERPRISE",
      lifecycle: String(customerRecord.status),
      readiness: stringField(asRecord(customerRecord.readiness), "state"),
      search: tenantA.name,
    });
    const filtered = await apiRequest(`/platform/operations/customers?${filterQuery}`, {
      token: platformToken,
    });
    expect(filtered.status).toBe(200);
    expect(arrayIds(arrayField(filtered.body, "items"))).toContain(tenantA.id);

    const noteKey = randomUUID();
    const noteBody = {
      body: "客户希望下期继续扩展集团公共素材能力。",
      reason: "记录客户成功跟进结论",
    };
    const [noteDenied, noteCreated] = await Promise.all([
      apiRequest(`/platform/operations/customers/${tenantA.id}/notes`, {
        body: noteBody,
        method: "POST",
        token: tenantAdminToken,
      }),
      apiRequest(`/platform/operations/customers/${tenantA.id}/notes`, {
        body: noteBody,
        idempotencyKey: noteKey,
        method: "POST",
        token: platformToken,
      }),
    ]);
    expect(noteDenied.status).toBe(403);
    expect(noteCreated.status).toBe(201);
    expect(asRecord(noteCreated.body)).toMatchObject({
      body: noteBody.body,
      createdBy: platformAdmin.id,
      tenantId: tenantA.id,
    });
    const replayedNote = await apiRequest(`/platform/operations/customers/${tenantA.id}/notes`, {
      body: noteBody,
      idempotencyKey: noteKey,
      method: "POST",
      token: platformToken,
    });
    expect(replayedNote.status).toBe(201);
    expect(replayedNote.headers.get("idempotency-replayed")).toBe("true");

    const [detail, detailDenied] = await Promise.all([
      apiRequest(`/platform/operations/customers/${tenantA.id}`, { token: platformToken }),
      apiRequest(`/platform/operations/customers/${tenantA.id}`, { token: tenantAdminToken }),
    ]);
    expect(detail.status).toBe(200);
    expect(detailDenied.status).toBe(403);
    expect(objectId(asRecord(detail.body).customer)).toBe(tenantA.id);
    expect(arrayField(detail.body, "enterprises")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          enterprise: expect.objectContaining({ id: enterpriseA.id }),
          workspace: expect.objectContaining({ campaignReady: expect.any(Boolean) }),
        }),
      ]),
    );
    expect(asRecord(detail.body)).toHaveProperty("generation");
    expect(arrayField(detail.body, "notes")).toEqual(
      expect.arrayContaining([expect.objectContaining({ body: noteBody.body })]),
    );
    expect(arrayField(detail.body, "audits")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "platform.customer-note.create",
          reason: noteBody.reason,
        }),
      ]),
    );
    expect(JSON.stringify(detail.body)).not.toMatch(
      /ciphertext|authenticationTag|initializationVector|apiKey|circuitProbeToken/iu,
    );
  });

  it("lists customer administrator contacts only within their tenant and enterprise", async () => {
    const enterpriseAdminRole = await requireRole(prisma, "ENTERPRISE_ADMIN");
    const emptyEnterprise = await prisma.enterprise.create({
      data: {
        code: `${marker}-EMPTY`.toUpperCase(),
        name: `${marker}-empty-enterprise`,
        status: "DISABLED",
        tenantId: tenantA.id,
      },
    });
    const administrators = await Promise.all(
      [10, 11, 12, 13].map((index) =>
        prisma.adminUser.create({
          data: {
            email: index === 10 ? `${marker}-${index}@example.test` : null,
            name: `联系管理员 ${index}`,
            phone: testPhone(marker, index),
          },
        }),
      ),
    );
    createdAdminUserIds.push(...administrators.map(({ id }) => id));
    await Promise.all(
      administrators.map((administrator, index) =>
        authorization.createRoleBinding(platformAccessScope(), {
          roleId: enterpriseAdminRole.id,
          targetScope: enterpriseAccessScope(
            index === 3 ? tenantB.id : tenantA.id,
            index === 3 ? enterpriseB.id : enterpriseA.id,
          ),
          userId: administrator.id,
        }),
      ),
    );
    await prisma.adminUser.update({
      data: { status: "DISABLED" },
      where: { id: requiredAt(administrators, 2).id },
    });
    const [detail, denied] = await Promise.all([
      apiRequest(`/platform/operations/customers/${tenantA.id}`, { token: platformToken }),
      apiRequest(`/platform/operations/customers/${tenantA.id}`, { token: tenantAdminToken }),
    ]);
    expect(detail.status).toBe(200);
    expect(denied.status).toBe(403);
    expect(arrayField(detail.body, "administrators")).toEqual([
      {
        email: tenantAdmin.email,
        id: tenantAdmin.id,
        name: tenantAdmin.name,
        phone: tenantAdmin.phone,
      },
    ]);
    const enterprises = arrayField(detail.body, "enterprises").map(asRecord);
    expect(enterprises.map((item) => objectId(item.enterprise))).toEqual(
      expect.arrayContaining([enterpriseA.id, emptyEnterprise.id]),
    );
    const contacts = arrayField(
      enterprises.find((item) => objectId(item.enterprise) === enterpriseA.id),
      "administrators",
    );
    expect(contacts).toHaveLength(2);
    expect(contacts).toEqual(
      expect.arrayContaining(
        administrators.slice(0, 2).map((administrator) => ({
          email: administrator.email,
          id: administrator.id,
          name: administrator.name,
          phone: administrator.phone,
        })),
      ),
    );
    expect(
      arrayField(
        enterprises.find((item) => objectId(item.enterprise) === emptyEnterprise.id),
        "administrators",
      ),
    ).toEqual([]);
    expect(JSON.stringify(detail.body)).not.toContain(requiredAt(administrators, 2).phone);
    expect(JSON.stringify(detail.body)).not.toContain(requiredAt(administrators, 3).phone);
    expect(JSON.stringify(contacts)).not.toContain(enterpriseViewer.phone);
  });

  it("filters customer enterprise presence independently from operational readiness", async () => {
    const orphanTenant = await prisma.tenant.create({
      data: {
        customerType: "SINGLE_ENTERPRISE",
        name: `${marker}-customer-without-enterprise`,
      },
    });
    createdTenantIds.push(orphanTenant.id);

    const [withoutEnterprise, withEnterprise, blockedReadiness] = await Promise.all([
      apiRequest(
        `/platform/operations/customers?enterpriseState=NO_ENTERPRISE&search=${encodeURIComponent(orphanTenant.name)}`,
        { token: platformToken },
      ),
      apiRequest(
        `/platform/operations/customers?enterpriseState=HAS_ENTERPRISE&search=${encodeURIComponent(orphanTenant.name)}`,
        { token: platformToken },
      ),
      apiRequest(
        `/platform/operations/customers?readiness=BLOCKED&search=${encodeURIComponent(orphanTenant.name)}`,
        { token: platformToken },
      ),
    ]);

    expect(withoutEnterprise.status).toBe(200);
    expect(arrayField(withoutEnterprise.body, "items")).toEqual([
      expect.objectContaining({
        enterpriseState: "NO_ENTERPRISE",
        enterprises: [],
        id: orphanTenant.id,
        readiness: expect.objectContaining({ state: "NOT_APPLICABLE" }),
      }),
    ]);
    expect(arrayField(withEnterprise.body, "items")).toHaveLength(0);
    expect(arrayField(blockedReadiness.body, "items")).toHaveLength(0);

    const [enterpriseNameSearch, enterpriseCodeSearch, impossibleCombination, invalidState] =
      await Promise.all([
        apiRequest(
          `/platform/operations/customers?search=${encodeURIComponent(enterpriseA.name)}`,
          { token: platformToken },
        ),
        apiRequest(
          `/platform/operations/customers?search=${encodeURIComponent(enterpriseA.code)}`,
          { token: platformToken },
        ),
        apiRequest(
          `/platform/operations/customers?enterpriseState=NO_ENTERPRISE&enterpriseCode=${encodeURIComponent(enterpriseA.code)}`,
          { token: platformToken },
        ),
        apiRequest("/platform/operations/customers?enterpriseState=UNKNOWN", {
          token: platformToken,
        }),
      ]);

    expect(arrayIds(arrayField(enterpriseNameSearch.body, "items"))).toContain(tenantA.id);
    expect(arrayIds(arrayField(enterpriseCodeSearch.body, "items"))).toContain(tenantA.id);
    expect(arrayField(impossibleCombination.body, "items")).toHaveLength(0);
    expect(invalidState.status).toBe(400);
  });

  it("diagnoses and manually redispatches a non-terminal generation run only from platform scope", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    const now = new Date();
    const campaign = await prisma.campaign.create({
      data: {
        createdBy: platformAdmin.id,
        enterpriseId: enterpriseA.id,
        expiresAt: new Date(now.getTime() + 90_000_000),
        prompt: "平台恢复测试",
        status: "GENERATING",
        tenantId: tenantA.id,
        title: `恢复测试 ${suffix}`,
        visibleAt: new Date(now.getTime() + 3_600_000),
      },
    });
    const run = await prisma.generationRun.create({
      data: {
        campaignId: campaign.id,
        imageModel: "recovery-image",
        provider: "recovery-provider",
        requestedCount: 1,
        status: "QUEUED",
        synthetic: true,
        tenantId: tenantA.id,
        textModel: "recovery-text",
      },
    });
    try {
      const denied = await apiRequest(`/platform/operations/generation-runs/${run.id}/recover`, {
        method: "POST",
        token: tenantAdminToken,
      });
      expect(denied.status).toBe(403);

      const detail = await apiRequest(`/platform/operations/generation-runs/${run.id}`, {
        token: platformToken,
      });
      expect(detail.status).toBe(200);
      expect(asRecord(detail.body)).toMatchObject({
        attemptCount: 0,
        imageModel: "recovery-image",
        provider: "recovery-provider",
        queueVersion: 1,
        recoveryCount: 0,
        status: "QUEUED",
        textModel: "recovery-text",
      });

      const recovered = await apiRequest(`/platform/operations/generation-runs/${run.id}/recover`, {
        method: "POST",
        token: platformToken,
      });
      expect(recovered.status).toBe(200);
      expect(asRecord(recovered.body)).toMatchObject({
        enqueuedRuns: 1,
        generationRunId: run.id,
        recoveredRuns: 1,
      });
      await expect(
        prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } }),
      ).resolves.toMatchObject({ queueVersion: 2, status: "QUEUED" });
      await expect(
        prisma.auditLog.findFirst({
          where: {
            action: "generation.run.manual-recovery",
            actorUserId: platformAdmin.id,
            resourceId: run.id,
          },
        }),
      ).resolves.not.toBeNull();
    } finally {
      await prisma.auditLog.deleteMany({ where: { resourceId: run.id } });
      await prisma.generationRun.deleteMany({ where: { id: run.id } });
      await prisma.campaignPreflightSnapshot.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.campaign.deleteMany({ where: { id: campaign.id } });
    }
  });

  it("atomically provisions a customer, enterprise and initial tenant administrator", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
    const idempotencyKey = randomUUID();
    const adminUsername = `workspace_${suffix.toLowerCase()}`;
    const registered = await prisma.adminUser.create({
      data: {
        username: adminUsername,
        passwordHash: await hashPassword("WorkspaceTestPassword2026"),
        phone: null,
      },
    });
    createdAdminUserIds.push(registered.id);
    const requestBody = {
      adminUsername,
      city: "上海",
      customerType: "GROUP",
      enterpriseCode: `ONBOARD_${suffix}`,
      enterpriseName: `${marker}-onboard-enterprise`,
      industry: "医疗健康",
      tenantName: `${marker}-onboard-tenant`,
    };
    const response = await apiRequest("/platform/operations/customers", {
      body: requestBody,
      idempotencyKey,
      method: "POST",
      token: platformToken,
    });

    expect(response.status).toBe(201);
    const result = asRecord(response.body);
    const tenantId = objectId(result.tenant);
    const enterpriseId = objectId(result.enterprise);
    const administratorId = stringField(result.administrator, "userId");
    expect(stringField(result.enterprise, "code")).toMatch(/^ENT_[A-F0-9]{32}$/u);
    expect(stringField(result.enterprise, "code")).not.toBe(requestBody.enterpriseCode);
    createdTenantIds.push(tenantId);
    expect(administratorId).toBe(registered.id);
    await expect(
      prisma.enterprise.findFirst({ where: { id: enterpriseId, tenantId } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.roleBinding.findFirst({
        where: {
          role: { code: "TENANT_ADMIN" },
          scopeId: tenantId,
          tenantId,
          userId: administratorId,
        },
      }),
    ).resolves.not.toBeNull();
    const customerToken = tokens.issueAdminAccessToken(administratorId);
    const workspace = await apiRequest(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/workspace`,
      { token: customerToken },
    );
    expect(workspace.status).toBe(200);

    const missingAdmin = await apiRequest("/platform/operations/customers", {
      body: {
        adminUsername: "missing_account",
        customerType: "GROUP",
        enterpriseName: "无效管理员企业",
        tenantName: `${marker}-missing-admin`,
      },
      method: "POST",
      token: platformToken,
    });
    expect(missingAdmin.status).toBe(409);
    expect(stringField(missingAdmin.body, "message")).toContain("已注册并设置密码");
    expect(await prisma.tenant.count({ where: { name: `${marker}-missing-admin` } })).toBe(0);

    const replayed = await apiRequest("/platform/operations/customers", {
      body: requestBody,
      idempotencyKey,
      method: "POST",
      token: platformToken,
    });
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get("idempotency-replayed")).toBe("true");
    expect(objectId(asRecord(replayed.body).tenant)).toBe(tenantId);

    const reusedForDifferentRequest = await apiRequest("/platform/operations/customers", {
      body: { ...requestBody, tenantName: `${marker}-different-tenant` },
      idempotencyKey,
      method: "POST",
      token: platformToken,
    });
    expect(reusedForDifferentRequest.status).toBe(409);
    expect(stringField(reusedForDifferentRequest.body, "code")).toBe("IDEMPOTENCY_KEY_REUSED");

    const customers = await apiRequest("/platform/operations/customers", {
      token: platformToken,
    });
    expect(customers.status).toBe(200);
    expect(arrayIds(arrayField(customers.body, "items"))).toContain(tenantId);
  });

  it("paginates growing platform lists with opaque, non-overlapping cursors", async () => {
    const first = await apiRequest("/platform/operations/customers?limit=1", {
      token: platformToken,
    });
    expect(first.status).toBe(200);
    const firstItems = arrayField(first.body, "items");
    expect(firstItems).toHaveLength(1);
    const pageInfo = asRecord(asRecord(first.body).pageInfo);
    expect(pageInfo.hasNextPage).toBe(true);
    const cursor = stringField(pageInfo, "nextCursor");

    const second = await apiRequest(
      `/platform/operations/customers?limit=1&cursor=${encodeURIComponent(cursor)}`,
      { token: platformToken },
    );
    expect(second.status).toBe(200);
    const secondItems = arrayField(second.body, "items");
    expect(secondItems).toHaveLength(1);
    expect(objectId(secondItems[0])).not.toBe(objectId(firstItems[0]));

    const malformed = await apiRequest("/platform/operations/customers?cursor=malformed", {
      token: platformToken,
    });
    expect(malformed.status).toBe(400);
    expect(stringField(malformed.body, "code")).toBe("PAGINATION_CURSOR_INVALID");
  });

  it("keeps authorization seeding idempotent", async () => {
    const first = await seedAuthorizationCatalog(prisma);
    const second = await seedAuthorizationCatalog(prisma);
    const [permissions, roles] = await Promise.all([
      prisma.permission.count(),
      prisma.role.count({ where: { isSystem: true } }),
    ]);

    expect(first).toEqual({ permissions: permissionCatalog.length, roles: 11 });
    expect(second).toEqual(first);
    expect(permissions).toBeGreaterThanOrEqual(permissionCatalog.length);
    expect(roles).toBe(11);
  });

  async function apiRequest(
    path: string,
    options: Readonly<{
      token?: string;
      method?: "GET" | "POST" | "PATCH";
      body?: unknown;
      idempotencyKey?: string | null;
    }> = {},
  ): Promise<ApiResponse> {
    const headers = new Headers();
    if (options.token) {
      headers.set("authorization", `Bearer ${options.token}`);
    }
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (
      (options.method === "POST" || options.method === "PATCH") &&
      options.idempotencyKey !== null
    ) {
      headers.set("idempotency-key", options.idempotencyKey ?? randomUUID());
    }
    const response = await fetch(`${baseUrl}${path}`, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method: options.method ?? "GET",
    });
    const text = await response.text();
    return {
      body: text.length > 0 ? JSON.parse(text) : null,
      headers: response.headers,
      status: response.status,
    };
  }
});

async function startModelProviderProbe(expectedApiKey: string): Promise<{
  authorizationHeaders: Array<string | undefined>;
  baseUrl: string;
  close(): Promise<void>;
}> {
  const authorizationHeaders: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    authorizationHeaders.push(request.headers.authorization);
    if (
      request.url !== "/v1/models" ||
      request.headers.authorization !== `Bearer ${expectedApiKey}`
    ) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider probe did not bind TCP");
  return {
    authorizationHeaders,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}

async function requireRole(prisma: PrismaService, code: string): Promise<Role> {
  const role = await prisma.role.findUnique({ where: { code } });
  if (!role) {
    throw new Error(`Seeded role was not found: ${code}`);
  }
  return role;
}

function arrayIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected an array response");
  }
  return value.map(objectId);
}

function objectId(value: unknown): string {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") {
    throw new Error("Expected an object with a string id");
  }
  return value.id;
}

function arrayField(value: unknown, field: string): unknown[] {
  const result = asRecord(value)[field];
  if (!Array.isArray(result)) throw new Error(`Expected array field: ${field}`);
  return result;
}

function stringField(value: unknown, field: string): string {
  const result = asRecord(value)[field];
  if (typeof result !== "string") throw new Error(`Expected string field: ${field}`);
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Expected an object response");
  return value as Record<string, unknown>;
}

function assertDevelopmentDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for organization API integration tests");
  }
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (databaseName !== "dev_xhs_agentic") {
    throw new Error(`Refusing to run integration tests against database: ${databaseName}`);
  }
}

function testPhone(marker: string, index: number): string {
  const digits = marker.replace(/\D/g, "").slice(-8).padStart(8, "0");
  return `198${digits}${index}`;
}

function validPhone(marker: string): string {
  const digits = marker.replace(/\D/g, "").slice(-8).padStart(8, "0");
  return `137${digits}`;
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (!value) {
    throw new Error(`Expected test fixture at index ${index}`);
  }
  return value;
}
