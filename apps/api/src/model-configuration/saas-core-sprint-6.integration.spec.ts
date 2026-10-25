import "reflect-metadata";

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { ContextIdFactory, NestFactory } from "@nestjs/core";
import type {
  AdminUser,
  Enterprise,
  PlatformSetting,
  Prisma,
  Role,
  Tenant,
} from "@xhs-agentic/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { enterpriseAccessScope, platformAccessScope } from "../access/access-scope";
import { AuthTokenService } from "../access/auth-token.service";
import { AuthorizationRepository } from "../access/authorization.repository";
import { seedAuthorizationCatalog } from "../access/authorization.seed";
import { RequestAccessContext } from "../access/request-access-context";
import { AppModule } from "../app.module";
import { CampaignService } from "../campaign/campaign.service";
import { GenerationPreflightService } from "../campaign/generation-preflight.service";
import { configureApplication } from "../configure-application";
import { PrismaService } from "../database/prisma.service";
import { ModelQualificationService } from "./model-qualification.service";
import { seedRuntimePolicy } from "./runtime-policy.seed";
import { RuntimePolicyService } from "./runtime-policy.service";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

type ApiResponse = Readonly<{ body: unknown; headers: Headers; status: number }>;

describe("SaaS core Sprint 6 production gates", { concurrent: false }, () => {
  const marker = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  const providerApiKey = `sk-sprint6-${marker}-private`;
  const rotatedApiKey = `sk-sprint6-${marker}-rotated`;
  const campaignInput = {
    imageCount: 1,
    prompt: "生成全飞秒 Pro 小红书风格科普，侧重专业设备、规范评估和个体差异。",
    title: `Sprint 6 活动 ${marker}`,
    visibleAt: new Date(Date.now() + 9 * 3_600_000).toISOString(),
  };
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let platformAdmin: AdminUser;
  let enterpriseAdmin: AdminUser;
  let platformToken: string;
  let enterpriseToken: string;
  let tenant: Tenant;
  let enterprise: Enterprise;
  let foreignTenant: Tenant;
  let foreignEnterprise: Enterprise;
  let syntheticProviderId: string;
  let realProviderId: string;
  let realTextModelId: string;
  let realImageModelId: string;
  let realRouteId: string;
  let successfulSyntheticCampaignId: string;
  let protocolProvider: Awaited<ReturnType<typeof startQualificationProvider>>;

  beforeAll(async () => {
    assertDevelopmentDatabase();
    protocolProvider = await startQualificationProvider(providerApiKey);
    app = await NestFactory.create(AppModule, {
      abortOnError: false,
      bodyParser: false,
      logger: false,
    });
    configureApplication(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
    prisma = app.get(PrismaService);
    await Promise.all([seedAuthorizationCatalog(prisma), seedRuntimePolicy(prisma)]);
    await prisma.runtimePolicy.update({
      data: { embeddingModelId: null },
      where: { id: "platform" },
    });

    const [platformRole, enterpriseRole] = await Promise.all([
      requireRole(prisma, "PLATFORM_ADMIN"),
      requireRole(prisma, "ENTERPRISE_ADMIN"),
    ]);
    [tenant, foreignTenant] = await Promise.all([
      prisma.tenant.create({
        data: { customerType: "SINGLE_ENTERPRISE", name: `sprint6-${marker}` },
      }),
      prisma.tenant.create({
        data: { customerType: "SINGLE_ENTERPRISE", name: `sprint6-foreign-${marker}` },
      }),
    ]);
    await Promise.all([
      prisma.tenantCapabilityPolicy.create({ data: { tenantId: tenant.id } }),
      prisma.tenantCapabilityPolicy.create({ data: { tenantId: foreignTenant.id } }),
    ]);
    [enterprise, foreignEnterprise] = await Promise.all([
      prisma.enterprise.create({
        data: {
          code: `S6_${marker}`,
          name: `Sprint 6 企业 ${marker}`,
          tenantId: tenant.id,
        },
      }),
      prisma.enterprise.create({
        data: {
          code: `S6F_${marker}`,
          name: `Sprint 6 外部企业 ${marker}`,
          tenantId: foreignTenant.id,
        },
      }),
    ]);
    const now = new Date();
    await prisma.enterpriseMembership.create({
      data: {
        enterpriseId: enterprise.id,
        name: "Sprint 6 测试员工",
        phone: testPhone(marker, 1),
        seatEnabledAt: now,
        seatStatus: "ENABLED",
        status: "PENDING_BIND",
        tenantId: tenant.id,
      },
    });
    const materialContent = "全飞秒 Pro 的传播应基于专业设备、规范术前评估和个体差异。";
    const material = await prisma.material.create({
      data: {
        authorizationStatus: "AUTHORIZED",
        content: materialContent,
        contentChecksum: createHash("sha256").update(materialContent).digest("hex"),
        createdBy: "sprint6-test",
        enterpriseId: enterprise.id,
        ingestionStatus: "READY",
        parserVersion: "test-inline-v1",
        readyAt: now,
        scopeKey: enterprise.id,
        tags: ["全飞秒Pro", "专业设备"],
        tenantId: tenant.id,
        title: "Sprint 6 授权素材",
        type: "TEXT",
      },
    });
    await prisma.materialChunk.create({
      data: {
        characterCount: materialContent.length,
        enterpriseId: enterprise.id,
        materialId: material.id,
        ordinal: 0,
        scopeKey: enterprise.id,
        tenantId: tenant.id,
        text: materialContent,
        textChecksum: createHash("sha256").update(materialContent).digest("hex"),
        tokenCount: Math.ceil(materialContent.length / 2),
      },
    });
    [platformAdmin, enterpriseAdmin] = await Promise.all([
      prisma.adminUser.create({
        data: { phone: testPhone(marker, 2), phoneVerifiedAt: now },
      }),
      prisma.adminUser.create({
        data: { phone: testPhone(marker, 3), phoneVerifiedAt: now },
      }),
    ]);
    const authorization = app.get(AuthorizationRepository);
    await Promise.all([
      authorization.createRoleBinding(platformAccessScope(), {
        roleId: platformRole.id,
        targetScope: platformAccessScope(),
        userId: platformAdmin.id,
      }),
      authorization.createRoleBinding(platformAccessScope(), {
        roleId: enterpriseRole.id,
        targetScope: enterpriseAccessScope(tenant.id, enterprise.id),
        userId: enterpriseAdmin.id,
      }),
    ]);
    const tokens = app.get(AuthTokenService);
    platformToken = tokens.issueAdminAccessToken(platformAdmin.id);
    enterpriseToken = tokens.issueAdminAccessToken(enterpriseAdmin.id);

    const syntheticProvider = await prisma.modelProvider.create({
      data: {
        baseUrl: "synthetic://sprint6",
        code: `S6_SYNTH_${marker}`,
        healthStatus: "HEALTHY",
        lastHealthCheckedAt: now,
        name: "Sprint 6 Synthetic Provider",
        protocol: "SYNTHETIC",
        synthetic: true,
      },
    });
    syntheticProviderId = syntheticProvider.id;
    const [textModel, imageModel] = await Promise.all([
      prisma.modelDefinition.create({
        data: {
          capabilities: ["TEXT"],
          code: `S6_SYNTH_TEXT_${marker}`,
          displayName: "Sprint 6 Synthetic Text",
          externalModelId: `s6-synthetic-text-${marker.toLowerCase()}`,
          providerId: syntheticProvider.id,
          synthetic: true,
        },
      }),
      prisma.modelDefinition.create({
        data: {
          capabilities: ["IMAGE"],
          code: `S6_SYNTH_IMAGE_${marker}`,
          displayName: "Sprint 6 Synthetic Image",
          externalModelId: `s6-synthetic-image-${marker.toLowerCase()}`,
          providerId: syntheticProvider.id,
          synthetic: true,
        },
      }),
    ]);
    await prisma.modelRoute.create({
      data: {
        createdBy: platformAdmin.id,
        enterpriseId: enterprise.id,
        imageModelId: imageModel.id,
        scopeId: enterprise.id,
        scopeType: "ENTERPRISE",
        tenantId: tenant.id,
        textModelId: textModel.id,
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    const tenantIds = [tenant?.id, foreignTenant?.id].filter((value): value is string =>
      Boolean(value),
    );
    const userIds = [platformAdmin?.id, enterpriseAdmin?.id].filter((value): value is string =>
      Boolean(value),
    );
    await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.modelInvocation.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.generatedImage.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.distributionTask.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.employeeContent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.generationWorkItem.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.generationRun.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.campaignBlueprint.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.campaignAudienceSnapshot.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.campaignPreflightSnapshot.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.campaignRetrievalEvidence.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.campaign.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.modelRouteQualification.deleteMany({
      where: { route: { tenantId: { in: tenantIds } } },
    });
    await prisma.modelRoute.deleteMany({ where: { tenantId: { in: tenantIds } } });
    const providerIds = [syntheticProviderId, realProviderId].filter((value): value is string =>
      Boolean(value),
    );
    await prisma.modelProviderInvocationLease.deleteMany({
      where: { providerId: { in: providerIds } },
    });
    await prisma.runtimePolicy.updateMany({
      data: { embeddingModelId: null },
      where: { embeddingModelId: { in: [realTextModelId].filter(Boolean) } },
    });
    await prisma.materialEmbedding.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.modelDefinition.deleteMany({ where: { providerId: { in: providerIds } } });
    await prisma.modelProviderHealthCheck.deleteMany({
      where: { providerId: { in: providerIds } },
    });
    await prisma.modelProvider.updateMany({
      data: { activeCredentialId: null },
      where: { id: { in: providerIds } },
    });
    await prisma.modelProviderCredential.deleteMany({ where: { providerId: { in: providerIds } } });
    await prisma.modelProvider.deleteMany({ where: { id: { in: providerIds } } });
    await prisma.materialChunk.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.materialIngestionJob.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.materialArtifact.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.material.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorUserId: { in: userIds } }, { tenantId: { in: tenantIds } }] },
    });
    await prisma.roleBinding.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.enterpriseMembership.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.enterprise.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: userIds } } });
    await Promise.all([app.close(), protocolProvider.close()]);
  });

  it("restricts versioned runtime policy changes to platform scope with idempotency and audit", async () => {
    const denied = await apiRequest("/platform/runtime-policy", { token: enterpriseToken });
    expect(denied.status).toBe(403);
    const current = await apiRequest("/platform/runtime-policy", { token: platformToken });
    expect(current.status).toBe(200);
    const before = asRecord(current.body);
    const idempotencyKey = randomUUID();
    const body = {
      costWarningThreshold: numberField(before, "costWarningThreshold") + 1,
      reason: "Sprint 6 runtime policy integration test",
    };
    const updated = await apiRequest("/platform/runtime-policy", {
      body,
      idempotencyKey,
      method: "POST",
      token: platformToken,
    });
    const replayed = await apiRequest("/platform/runtime-policy", {
      body,
      idempotencyKey,
      method: "POST",
      token: platformToken,
    });
    expect(updated.status).toBe(200);
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get("idempotency-replayed")).toBe("true");
    await expect(
      prisma.auditLog.count({
        where: {
          action: "runtime-policy.update",
          actorUserId: platformAdmin.id,
          reason: body.reason,
        },
      }),
    ).resolves.toBe(1);
  });

  it("blocks synthetic routes in production at the customer API without leaking platform details", async () => {
    await withDeliveryMode("PRODUCTION", async () => {
      const before = await tenantGenerationCounts();
      const [customer, platform, deniedCrossTenant] = await Promise.all([
        apiRequest(
          `/console/tenants/${tenant.id}/enterprises/${enterprise.id}/campaigns/preflight`,
          { body: campaignInput, method: "POST", token: enterpriseToken },
        ),
        apiRequest(
          `/platform/operations/customers/${tenant.id}/enterprises/${enterprise.id}/generation-preflight`,
          { body: campaignInput, method: "POST", token: platformToken },
        ),
        apiRequest(
          `/console/tenants/${foreignTenant.id}/enterprises/${foreignEnterprise.id}/campaigns/preflight`,
          { body: campaignInput, method: "POST", token: enterpriseToken },
        ),
      ]);
      expect(customer.status).toBe(200);
      expect(asRecord(customer.body)).toMatchObject({
        ready: false,
        serviceStatus: "UNAVAILABLE",
      });
      const customerJson = JSON.stringify(customer.body);
      expect(customerJson).not.toMatch(
        /provider|endpoint|credential|apiKey|routeId|modelId|estimatedCost/iu,
      );
      expect(customerJson).not.toContain(`S6_SYNTH_${marker}`);
      expect(platform.status).toBe(200);
      expect(asRecord(platform.body)).toMatchObject({ deliveryMode: "PRODUCTION", ready: false });
      expect(JSON.stringify(platform.body)).toContain("SYNTHETIC_ROUTE_FORBIDDEN");
      expect(deniedCrossTenant.status).toBe(403);

      const create = await apiRequest(
        `/console/tenants/${tenant.id}/enterprises/${enterprise.id}/campaigns`,
        { body: campaignInput, method: "POST", token: enterpriseToken },
      );
      expect(create.status).toBe(409);
      expect(JSON.stringify(create.body)).toContain("GENERATION_PREFLIGHT_BLOCKED");
      await expect(tenantGenerationCounts()).resolves.toEqual(before);
    });
  });

  it("rejects a campaign when runtime policy changes between preflight and campaign creation", async () => {
    await withDeliveryMode("DEVELOPMENT", async () => {
      const contextId = ContextIdFactory.create();
      app.registerRequestByContextId({}, contextId);
      const accessContext = await app.resolve(RequestAccessContext, contextId);
      accessContext.initialize({
        audience: "SAAS_ADMIN",
        permissions: ["campaign.manage"],
        scope: enterpriseAccessScope(tenant.id, enterprise.id),
        userId: enterpriseAdmin.id,
      });
      const preflight = await app.resolve(GenerationPreflightService, contextId);
      const campaigns = await app.resolve(CampaignService, contextId);
      const original = preflight.requireCampaignReady.bind(preflight);
      const spy = vi
        .spyOn(preflight, "requireCampaignReady")
        .mockImplementation(async (...args) => {
          const result = await original(...args);
          await prisma.runtimePolicy.update({
            data: { updatedBy: `race-${marker}` },
            where: { id: "platform" },
          });
          return result;
        });
      const before = await tenantGenerationCounts();
      try {
        await expect(
          campaigns.createCampaign(
            { enterpriseId: enterprise.id, tenantId: tenant.id },
            campaignInput,
          ),
        ).rejects.toMatchObject({
          response: { code: "GENERATION_PREFLIGHT_STALE" },
        });
        await expect(tenantGenerationCounts()).resolves.toEqual(before);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("stores an immutable preflight snapshot for an accepted development campaign", async () => {
    await withDeliveryMode("DEVELOPMENT", async () => {
      const response = await apiRequest(
        `/console/tenants/${tenant.id}/enterprises/${enterprise.id}/campaigns`,
        {
          body: { ...campaignInput, title: `${campaignInput.title} Snapshot` },
          method: "POST",
          token: enterpriseToken,
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      successfulSyntheticCampaignId = stringField(response.body, "id");
      const snapshot = await prisma.campaignPreflightSnapshot.findUniqueOrThrow({
        where: { campaignId: successfulSyntheticCampaignId },
      });
      expect(snapshot).toMatchObject({
        campaignId: successfulSyntheticCampaignId,
        deliveryMode: "DEVELOPMENT",
        enterpriseId: enterprise.id,
        routeQualificationId: null,
        runtimePolicyId: "platform",
        tenantId: tenant.id,
      });
      expect(snapshot.configurationFingerprint).toHaveLength(64);
    });
  });

  it("qualifies a real route through text, image, MinIO and signed-read verification", async () => {
    const suffix = marker.slice(0, 8);
    const provider = await apiRequest("/platform/model-providers", {
      body: {
        apiKey: providerApiKey,
        baseUrl: protocolProvider.baseUrl,
        code: `S6_REAL_${suffix}`,
        name: "Sprint 6 Real Qualification Provider",
        synthetic: false,
        timeoutMs: 10_000,
      },
      method: "POST",
      token: platformToken,
    });
    expect(provider.status).toBe(201);
    realProviderId = stringField(provider.body, "id");
    const [textModel, imageModel] = await Promise.all([
      apiRequest(`/platform/model-providers/${realProviderId}/models`, {
        body: {
          capabilities: ["TEXT", "EMBEDDING"],
          code: `S6_REAL_TEXT_${suffix}`,
          displayName: "Sprint 6 Real Text",
          externalModelId: `s6-real-text-${suffix.toLowerCase()}`,
          metadata: { inputCostPerMillionUnits: 1, outputCostPerMillionUnits: 2 },
          synthetic: false,
        },
        method: "POST",
        token: platformToken,
      }),
      apiRequest(`/platform/model-providers/${realProviderId}/models`, {
        body: {
          capabilities: ["IMAGE"],
          code: `S6_REAL_IMAGE_${suffix}`,
          displayName: "Sprint 6 Real Image",
          externalModelId: `s6-real-image-${suffix.toLowerCase()}`,
          metadata: { imageCost: 0.12 },
          synthetic: false,
        },
        method: "POST",
        token: platformToken,
      }),
    ]);
    expect(textModel.status).toBe(201);
    expect(imageModel.status).toBe(201);
    realTextModelId = stringField(textModel.body, "id");
    realImageModelId = stringField(imageModel.body, "id");
    const retrievalPolicy = await apiRequest("/platform/runtime-policy", {
      body: {
        embeddingModelId: realTextModelId,
        reason: "Sprint 7 production retrieval qualification",
      },
      method: "POST",
      token: platformToken,
    });
    expect(retrievalPolicy.status).toBe(200);
    const route = await configureRealRoute(2);
    expect(route.status).toBe(201);
    realRouteId = stringField(route.body, "id");
    const contentSafetyKeys = [
      "content_safety.api_key",
      "content_safety.endpoint",
      "content_safety.mode",
      "content_safety.provider",
    ] as const;
    const originalContentSafety = await prisma.platformSetting.findMany({
      where: { key: { in: [...contentSafetyKeys] } },
    });
    for (const [key, value] of [
      ["content_safety.api_key", providerApiKey],
      ["content_safety.endpoint", `${protocolProvider.baseUrl}/content-safety`],
      ["content_safety.provider", "S6_CONTENT_SAFETY"],
      ["content_safety.mode", "HTTP"],
    ] as const) {
      const configured = await apiRequest(`/platform/settings/${key}`, {
        body: { reason: "Sprint 6 production content-safety readiness", value },
        method: "POST",
        token: platformToken,
      });
      expect(configured.status).toBe(200);
    }

    try {
      const safetyProbe = await apiRequest("/platform/settings/content-safety/test", {
        body: { reason: "Sprint 6 production content-safety readiness" },
        method: "POST",
        token: platformToken,
      });
      expect(safetyProbe.status, JSON.stringify(safetyProbe.body)).toBe(200);
      expect(asRecord(safetyProbe.body)).toMatchObject({ decision: "PASS" });
      await withDeliveryMode("PRODUCTION", async () => {
        const denied = await apiRequest(`/platform/model-routes/${realRouteId}/qualify`, {
          method: "POST",
          token: enterpriseToken,
        });
        expect(denied.status).toBe(403);
        const qualification = await qualifyRealRoute();
        expect(qualification.status).toBe(201);
        expect(asRecord(qualification.body)).toMatchObject({
          deliveryMode: "PRODUCTION",
          routeId: realRouteId,
          status: "PASSED",
          storageVerified: true,
        });
        expect(numberField(qualification.body, "estimatedCost")).toBeGreaterThan(0);
        expect(protocolProvider.paths).toEqual(
          expect.arrayContaining(["/v1/models", "/v1/chat/completions", "/v1/images/generations"]),
        );
        expect(
          protocolProvider.authorizations.every((value) => value === `Bearer ${providerApiKey}`),
        ).toBe(true);

        const [customer, platform] = await Promise.all([
          apiRequest(
            `/console/tenants/${tenant.id}/enterprises/${enterprise.id}/campaigns/preflight`,
            { body: campaignInput, method: "POST", token: enterpriseToken },
          ),
          apiRequest(
            `/platform/operations/customers/${tenant.id}/enterprises/${enterprise.id}/generation-preflight`,
            { body: campaignInput, method: "POST", token: platformToken },
          ),
        ]);
        expect(customer.status).toBe(200);
        expect(asRecord(customer.body), JSON.stringify(customer.body)).toMatchObject({
          ready: true,
          serviceStatus: "AVAILABLE",
        });
        const customerJson = JSON.stringify(customer.body);
        expect(customerJson).not.toMatch(
          /provider|endpoint|credential|apiKey|routeId|modelId|estimatedCost/iu,
        );
        expect(customerJson).not.toContain(providerApiKey);
        expect(customerJson).not.toContain(`S6_REAL_${suffix}`);
        expect(platform.status).toBe(200);
        expect(asRecord(platform.body)).toMatchObject({ deliveryMode: "PRODUCTION", ready: true });
        expect(asRecord(asRecord(platform.body).route)).toMatchObject({ routeId: realRouteId });
      });
    } finally {
      await restorePlatformSettings(prisma, contentSafetyKeys, originalContentSafety);
    }
  }, 30_000);

  it("invalidates qualification after credential, base URL, model or route changes", async () => {
    await withDeliveryMode("PRODUCTION", async () => {
      const qualifications = await app.resolve(ModelQualificationService);
      const policy = await (await app.resolve(RuntimePolicyService)).current();
      const assertInvalidated = async () => {
        const assessment = await qualifications.assessRoute(realRouteId, policy);
        expect(assessment.eligible).toBe(false);
        expect(assessment.qualification).toBeNull();
        expect(assessment.reasons.map(({ code }) => code)).toContain(
          "ROUTE_QUALIFICATION_REQUIRED",
        );
      };

      protocolProvider.acceptedApiKeys.add(rotatedApiKey);
      const rotated = await apiRequest(
        `/platform/model-providers/${realProviderId}/credentials/rotate`,
        {
          body: { apiKey: rotatedApiKey, reason: "Sprint 6 fingerprint credential change" },
          method: "POST",
          token: platformToken,
        },
      );
      expect(rotated.status).toBe(201);
      await assertInvalidated();
      expect((await qualifyRealRoute()).status).toBe(201);

      const provider = await prisma.modelProvider.findUniqueOrThrow({
        where: { id: realProviderId },
      });
      const baseUrlChanged = await apiRequest(
        `/platform/model-providers/${realProviderId}/settings`,
        {
          body: {
            baseUrl: `${provider.baseUrl}/`,
            reason: "Sprint 6 fingerprint base URL change",
          },
          method: "POST",
          token: platformToken,
        },
      );
      expect(baseUrlChanged.status).toBe(200);
      await assertInvalidated();
      expect((await qualifyRealRoute()).status).toBe(201);

      await prisma.modelDefinition.update({
        data: { externalModelId: `s6-real-text-${marker.toLowerCase()}-v2` },
        where: { id: realTextModelId },
      });
      await assertInvalidated();
      expect((await qualifyRealRoute()).status).toBe(201);

      expect((await configureRealRoute(3)).status).toBe(201);
      await assertInvalidated();
      expect((await qualifyRealRoute()).status).toBe(201);
    });
  }, 30_000);

  it("keeps old passes valid without expiry and records failed revalidation without rewriting history", async () => {
    await withDeliveryMode("PRODUCTION", async () => {
      const qualifications = await app.resolve(ModelQualificationService);
      const policy = await (await app.resolve(RuntimePolicyService)).current();
      const current = await prisma.modelRouteQualification.findFirstOrThrow({
        orderBy: { checkedAt: "desc" },
        where: { routeId: realRouteId, status: "PASSED" },
      });
      await prisma.modelRouteQualification.update({
        data: {
          checkedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),
          expiresAt: new Date(Date.now() - 24 * 60 * 60_000),
        },
        where: { id: current.id },
      });
      const expired = await qualifications.assessRoute(realRouteId, policy);
      expect(expired.eligible).toBe(true);
      expect(expired.qualification?.id).toBe(current.id);
      expect(expired.qualification?.expiresAt).toBeNull();
      expect((await qualifyRealRoute()).status).toBe(201);

      protocolProvider.failImage = true;
      const failed = await qualifyRealRoute();
      protocolProvider.failImage = false;
      expect(failed.status).toBe(201);
      expect(asRecord(failed.body)).toMatchObject({ status: "FAILED", storageVerified: false });
      expect(stringField(failed.body, "errorCode")).toBe("qualification_image_unavailable");

      const historical = await prisma.campaignPreflightSnapshot.findUniqueOrThrow({
        where: { campaignId: successfulSyntheticCampaignId },
      });
      expect(historical).toMatchObject({
        deliveryMode: "DEVELOPMENT",
        routeQualificationId: null,
        runtimePolicyId: "platform",
      });
      expect(historical.configurationFingerprint).toHaveLength(64);
    });
  }, 30_000);

  async function configureRealRoute(maxAttemptsPerModel: number) {
    return apiRequest("/platform/model-routes", {
      body: {
        enterpriseId: enterprise.id,
        imageModelId: realImageModelId,
        maxAttemptsPerModel,
        scopeId: enterprise.id,
        scopeType: "ENTERPRISE",
        tenantId: tenant.id,
        textModelId: realTextModelId,
      },
      method: "POST",
      token: platformToken,
    });
  }

  async function qualifyRealRoute() {
    return apiRequest(`/platform/model-routes/${realRouteId}/qualify`, {
      method: "POST",
      token: platformToken,
    });
  }

  async function tenantGenerationCounts() {
    const [campaigns] = await Promise.all([
      prisma.campaign.count({ where: { tenantId: tenant.id } }),
    ]);
    return { campaigns };
  }

  async function apiRequest(
    path: string,
    options: Readonly<{
      body?: unknown;
      idempotencyKey?: string | null;
      method?: "GET" | "POST";
      token?: string;
    }> = {},
  ): Promise<ApiResponse> {
    const headers = new Headers();
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.method === "POST" && options.idempotencyKey !== null) {
      headers.set("idempotency-key", options.idempotencyKey ?? randomUUID());
    }
    const response = await fetch(`${baseUrl}${path}`, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method: options.method ?? "GET",
    });
    const text = await response.text();
    return {
      body: text ? JSON.parse(text) : null,
      headers: response.headers,
      status: response.status,
    };
  }
});

async function startQualificationProvider(initialApiKey: string): Promise<{
  acceptedApiKeys: Set<string>;
  authorizations: Array<string | undefined>;
  baseUrl: string;
  close(): Promise<void>;
  failImage: boolean;
  paths: string[];
}> {
  const state = {
    acceptedApiKeys: new Set([initialApiKey]),
    authorizations: [] as Array<string | undefined>,
    failImage: false,
    paths: [] as string[],
  };
  const server = createServer((request, response) => {
    void handleQualificationRequest(request, response, state).catch((error: unknown) => {
      writeJson(response, 500, { error: { code: "mock_failure", message: safeError(error) } });
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Qualification mock did not bind");
  return {
    ...state,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
    get failImage() {
      return state.failImage;
    },
    set failImage(value: boolean) {
      state.failImage = value;
    },
  };
}

async function handleQualificationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: {
    acceptedApiKeys: Set<string>;
    authorizations: Array<string | undefined>;
    failImage: boolean;
    paths: string[];
  },
): Promise<void> {
  const authorization = request.headers.authorization;
  const path = request.url ?? "";
  state.authorizations.push(authorization);
  state.paths.push(path);
  const apiKey = authorization?.replace(/^Bearer\s+/u, "") ?? "";
  if (!state.acceptedApiKeys.has(apiKey)) {
    writeJson(response, 401, { error: { code: "invalid_api_key" } });
    return;
  }
  if (request.method === "POST" && path === "/v1/content-safety") {
    await readBody(request);
    writeJson(response, 200, { decision: "PASS", categories: [] });
    return;
  }
  if (request.method === "GET" && path === "/v1/models") {
    writeJson(response, 200, { data: [] });
    return;
  }
  if (request.method === "POST" && path === "/v1/chat/completions") {
    await readBody(request);
    writeJson(response, 200, {
      choices: [{ finish_reason: "stop", message: { content: "READY" } }],
      id: `qualification-text-${randomUUID()}`,
      usage: { completion_tokens: 2, prompt_tokens: 20 },
    });
    return;
  }
  if (request.method === "POST" && path === "/v1/embeddings") {
    const body = JSON.parse(await readBody(request)) as { input?: unknown[] };
    const inputs = Array.isArray(body.input) ? body.input : [];
    writeJson(response, 200, {
      data: inputs.map((_, index) => ({
        embedding: Array.from({ length: 64 }, () => 0.125),
        index,
      })),
      id: `qualification-embedding-${randomUUID()}`,
      usage: { prompt_tokens: 20, total_tokens: 20 },
    });
    return;
  }
  if (request.method === "POST" && path === "/v1/images/generations") {
    await readBody(request);
    if (state.failImage) {
      writeJson(response, 503, { error: { code: "qualification_image_unavailable" } });
      return;
    }
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    writeJson(response, 200, {
      data: [{ b64_json: png.toString("base64") }],
      id: `qualification-image-${randomUUID()}`,
    });
    return;
  }
  writeJson(response, 404, { error: { code: "not_found" } });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function requireRole(prisma: PrismaService, code: string): Promise<Role> {
  return prisma.role.findUniqueOrThrow({ where: { code } });
}

async function withDeliveryMode<T>(
  mode: "DEVELOPMENT" | "PRODUCTION",
  operation: () => Promise<T>,
): Promise<T> {
  const before = process.env.GENERATION_DELIVERY_MODE;
  const beforePrivateTestUrls = process.env.MODEL_PROVIDER_ALLOW_PRIVATE_TEST_URLS;
  process.env.GENERATION_DELIVERY_MODE = mode;
  if (mode === "PRODUCTION") process.env.MODEL_PROVIDER_ALLOW_PRIVATE_TEST_URLS = "true";
  try {
    return await operation();
  } finally {
    if (before === undefined) delete process.env.GENERATION_DELIVERY_MODE;
    else process.env.GENERATION_DELIVERY_MODE = before;
    if (beforePrivateTestUrls === undefined) {
      delete process.env.MODEL_PROVIDER_ALLOW_PRIVATE_TEST_URLS;
    } else {
      process.env.MODEL_PROVIDER_ALLOW_PRIVATE_TEST_URLS = beforePrivateTestUrls;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object response");
  }
  return value as Record<string, unknown>;
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

function testPhone(marker: string, ordinal: number): string {
  const digest = createHash("sha256").update(marker).digest("hex").slice(0, 8);
  const digits = Number.parseInt(digest, 16) % 10_000_000;
  return `19${String(digits).padStart(7, "0")}${String(ordinal).padStart(2, "0")}`;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown mock error").slice(0, 300);
}

async function restorePlatformSettings(
  prisma: PrismaService,
  keys: readonly string[],
  originals: readonly PlatformSetting[],
): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: { in: [...keys] } } });
  for (const setting of originals) {
    await prisma.platformSetting.create({
      data: {
        authenticationTag: setting.authenticationTag,
        ciphertext: setting.ciphertext,
        createdAt: setting.createdAt,
        group: setting.group,
        initializationVector: setting.initializationVector,
        key: setting.key,
        keyVersion: setting.keyVersion,
        secretLastFour: setting.secretLastFour,
        updatedAt: setting.updatedAt,
        updatedBy: setting.updatedBy,
        value: setting.value === null ? undefined : (setting.value as Prisma.InputJsonValue),
        valueType: setting.valueType,
        version: setting.version,
      },
    });
  }
}

function assertDevelopmentDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing local test database");
  const url = new URL(databaseUrl);
  const name = url.pathname.slice(1);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    (name !== "dev_xhs_agentic" && !/^dev_xhs_model_gates_test_\d+$/u.test(name))
  ) {
    throw new Error("Sprint 6 integration test requires an approved local development database");
  }
}
