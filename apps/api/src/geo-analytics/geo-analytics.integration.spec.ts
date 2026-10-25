import "reflect-metadata";

import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformAccessScope, tenantAccessScope } from "../access/access-scope";
import { AuthTokenService } from "../access/auth-token.service";
import { AuthorizationRepository } from "../access/authorization.repository";
import { seedAuthorizationCatalog } from "../access/authorization.seed";
import { AppModule } from "../app.module";
import { configureApplication } from "../configure-application";
import { PrismaService } from "../database/prisma.service";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

describe("Sprint 9 GEO coverage analytics", { concurrent: false }, () => {
  const marker = `geo-analysis-${Date.now()}-${randomUUID().slice(0, 6)}`;
  let adminToken: string;
  let app: INestApplication;
  let baseUrl: string;
  let enterpriseAId: string;
  let enterpriseBId: string;
  let foreignEnterpriseId: string;
  let foreignTenantId: string;
  let prisma: PrismaService;
  let tenantId: string;
  let userId: string;

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
    const authorization = app.get(AuthorizationRepository);
    const tokens = app.get(AuthTokenService);
    await seedAuthorizationCatalog(prisma);

    const role = await prisma.role.findUniqueOrThrow({ where: { code: "TENANT_ADMIN" } });
    const user = await prisma.adminUser.create({ data: { phone: uniquePhone() } });
    userId = user.id;
    const [tenant, foreignTenant] = await Promise.all([
      prisma.tenant.create({ data: { customerType: "GROUP", name: `${marker}-tenant` } }),
      prisma.tenant.create({ data: { customerType: "GROUP", name: `${marker}-foreign` } }),
    ]);
    tenantId = tenant.id;
    foreignTenantId = foreignTenant.id;
    await Promise.all([
      prisma.tenantCapabilityPolicy.create({ data: { tenantId } }),
      prisma.tenantCapabilityPolicy.create({ data: { tenantId: foreignTenantId } }),
    ]);
    const [enterpriseA, enterpriseB, foreignEnterprise] = await Promise.all([
      prisma.enterprise.create({
        data: { code: `${marker}-A`.toUpperCase(), name: "杭州旗舰院区", tenantId },
      }),
      prisma.enterprise.create({
        data: { code: `${marker}-B`.toUpperCase(), name: "宁波旗舰院区", tenantId },
      }),
      prisma.enterprise.create({
        data: {
          code: `${marker}-F`.toUpperCase(),
          name: "其他集团企业",
          tenantId: foreignTenantId,
        },
      }),
    ]);
    enterpriseAId = enterpriseA.id;
    enterpriseBId = enterpriseB.id;
    foreignEnterpriseId = foreignEnterprise.id;
    await authorization.createRoleBinding(platformAccessScope(), {
      roleId: role.id,
      targetScope: tenantAccessScope(tenantId),
      userId,
    });
    adminToken = tokens.issueAdminAccessToken(userId);

    const entityA = await prisma.geoEntity.create({
      data: {
        aliases: ["全飞秒Pro术式"],
        createdBy: userId,
        enterpriseId: enterpriseAId,
        facts: { device: "VisuMax", recovery: "遵医嘱评估" },
        key: "technology:全飞秒pro",
        name: "全飞秒PRO",
        scopeKey: enterpriseAId,
        tenantId,
        type: "TECHNOLOGY",
      },
    });
    const topicA = await prisma.geoTopic.create({
      data: {
        createdBy: userId,
        enterpriseId: enterpriseAId,
        entityId: entityA.id,
        intent: "DEVICE",
        priority: 10,
        question: "全飞秒PRO的手术设备有哪些",
        tenantId,
      },
    });
    await prisma.geoEntity.create({
      data: {
        createdBy: userId,
        enterpriseId: enterpriseAId,
        key: "device:未覆盖设备",
        name: "未覆盖设备",
        scopeKey: enterpriseAId,
        tenantId,
        type: "DEVICE",
      },
    });
    const entityB = await prisma.geoEntity.create({
      data: {
        aliases: ["宁波品牌"],
        createdBy: userId,
        enterpriseId: enterpriseBId,
        facts: { city: "宁波" },
        key: "brand:宁波旗舰院区",
        name: "宁波旗舰院区",
        scopeKey: enterpriseBId,
        tenantId,
        type: "BRAND",
      },
    });
    const topicB = await prisma.geoTopic.create({
      data: {
        createdBy: userId,
        enterpriseId: enterpriseBId,
        entityId: entityB.id,
        intent: "LOCATION",
        priority: 5,
        question: "宁波旗舰院区在哪里",
        tenantId,
      },
    });

    await createMeasuredCampaign({
      bodies: [
        "全飞秒PRO采用专业手术设备，术前评估与术后护理同样重要。",
        "今天分享日常视力健康管理知识。",
      ],
      enterpriseId: enterpriseAId,
      entity: entityA,
      title: "全飞秒设备科普",
      topic: topicA,
    });
    await createMeasuredCampaign({
      bodies: ["宁波旗舰院区位于宁波核心城区，欢迎提前预约。"],
      enterpriseId: enterpriseBId,
      entity: entityB,
      title: "宁波院区介绍",
      topic: topicB,
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.employeeContent.deleteMany({ where: { tenantId } });
    await prisma.campaignBlueprint.deleteMany({ where: { tenantId } });
    await prisma.campaignAudienceSnapshot.deleteMany({ where: { tenantId } });
    await prisma.campaign.deleteMany({ where: { tenantId } });
    await prisma.enterpriseMembership.deleteMany({ where: { tenantId } });
    await prisma.geoTopic.deleteMany({ where: { tenantId } });
    await prisma.geoEntity.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: userId }, { tenantId }] } });
    await prisma.roleBinding.deleteMany({ where: { userId } });
    await prisma.enterprise.deleteMany({
      where: { tenantId: { in: [tenantId, foreignTenantId] } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, foreignTenantId] } } });
    await prisma.adminUser.delete({ where: { id: userId } });
    await app.close();
  });

  it("returns stable asset, target and final-copy delivery coverage without external ranking claims", async () => {
    const response = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/geo-analytics/summary`,
    );
    expect(response.status).toBe(200);
    const summary = asRecord(response.body);
    expect(asRecord(summary.assets)).toMatchObject({
      activeEntityCount: 2,
      activeTopicCount: 1,
      completeEntityCount: 1,
      entitiesWithoutTopics: 1,
    });
    expect(asRecord(summary.target)).toMatchObject({
      campaignCount: 1,
      currentTargetedEntityCount: 1,
      currentTargetedTopicCount: 1,
      targetEntityCoverageRate: 0.5,
      targetTopicCoverageRate: 1,
    });
    expect(asRecord(summary.delivery)).toMatchObject({
      employeeContentCount: 2,
      entityHitRate: 0.5,
      topicHitRate: 0.5,
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /小红书权重|externalWeight|ranking|citation/iu,
    );
  });

  it("provides campaign detail, trend, gap analysis and group comparison", async () => {
    await prisma.tenantCapabilityPolicy.update({
      data: { geoEnabled: true, geoEntityLimit: 100, geoTopicLimit: 1_000 },
      where: { tenantId },
    });
    const base = `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/geo-analytics`;
    const [campaigns, trends, gaps, comparison] = await Promise.all([
      request(`${base}/campaigns`),
      request(`${base}/trends`),
      request(`${base}/gaps`),
      request(`/console/tenants/${tenantId}/geo-analytics/comparison`),
    ]);
    expect(campaigns.status).toBe(200);
    expect(trends.status).toBe(200);
    expect(gaps.status).toBe(200);
    expect(comparison.status).toBe(200);
    expect(arrayValue(campaigns.body)).toHaveLength(1);
    expect(arrayValue(trends.body)).toHaveLength(1);
    expect(arrayValue(gaps.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gapType: "PARTIALLY_DELIVERED", title: "全飞秒PRO" }),
        expect.objectContaining({ gapType: "NOT_TARGETED", title: "未覆盖设备" }),
      ]),
    );
  });

  it("keeps cross-enterprise comparison on one unified metric definition", async () => {
    await prisma.tenantCapabilityPolicy.update({
      data: { geoEnabled: true, geoEntityLimit: 500, geoTopicLimit: 5_000 },
      where: { tenantId },
    });
    const response = await request(`/console/tenants/${tenantId}/geo-analytics/comparison`);
    expect(response.status).toBe(200);
    const rows = arrayValue(asRecord(response.body).enterprises);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enterpriseId: enterpriseAId, entityDeliveryRate: 0.5 }),
        expect.objectContaining({ enterpriseId: enterpriseBId, entityDeliveryRate: 1 }),
      ]),
    );
  });

  it("does not use legacy GEO levels for feature gating and still blocks cross-tenant access", async () => {
    await prisma.tenantCapabilityPolicy.update({
      data: { geoEnabled: true, geoEntityLimit: 20, geoTopicLimit: 100 },
      where: { tenantId },
    });
    const ownBase = `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/geo-analytics`;
    const [summary, trends, gaps, comparison, foreign] = await Promise.all([
      request(`${ownBase}/summary`),
      request(`${ownBase}/trends`),
      request(`${ownBase}/gaps`),
      request(`/console/tenants/${tenantId}/geo-analytics/comparison`),
      request(
        `/console/tenants/${foreignTenantId}/enterprises/${foreignEnterpriseId}/geo-analytics/summary`,
      ),
    ]);
    expect(summary.status).toBe(200);
    expect(trends.status).toBe(200);
    expect(gaps.status).toBe(200);
    expect(comparison.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  async function createMeasuredCampaign(
    input: Readonly<{
      bodies: readonly string[];
      enterpriseId: string;
      entity: Readonly<{
        aliases: string[];
        id: string;
        name: string;
        seriesId: string;
        version: number;
      }>;
      title: string;
      topic: Readonly<{ id: string; question: string; seriesId: string; version: number }>;
    }>,
  ): Promise<void> {
    const visibleAt = new Date(Date.now() + 60 * 60 * 1000);
    const campaign = await prisma.campaign.create({
      data: {
        approvedAt: new Date(),
        approvedBy: userId,
        audienceCount: input.bodies.length,
        createdBy: userId,
        enterpriseId: input.enterpriseId,
        expiresAt: new Date(visibleAt.getTime() + 24 * 60 * 60 * 1000),
        generatedCount: input.bodies.length,
        prompt: input.title,
        status: "APPROVED",
        tenantId,
        title: input.title,
        visibleAt,
      },
    });
    await prisma.campaignBlueprint.create({
      data: {
        campaignId: campaign.id,
        generationPolicy: { source: "GEO_TEST" },
        imageDirection: "GEO 分析测试图",
        masterCopy: input.title,
        sourceContext: {
          assetSnapshot: {
            geoEntities: [
              {
                aliases: input.entity.aliases,
                id: input.entity.id,
                name: input.entity.name,
                seriesId: input.entity.seriesId,
                topics: [
                  {
                    id: input.topic.id,
                    question: input.topic.question,
                    seriesId: input.topic.seriesId,
                    version: input.topic.version,
                  },
                ],
                version: input.entity.version,
              },
            ],
          },
          geoEntities: [
            {
              aliases: input.entity.aliases,
              id: input.entity.id,
              name: input.entity.name,
              seriesId: input.entity.seriesId,
            },
          ],
          schemaVersion: "geo-analysis-test-v1",
        },
        tenantId,
      },
    });
    for (const [index, body] of input.bodies.entries()) {
      const membership = await prisma.enterpriseMembership.create({
        data: {
          employeeNo: `${input.enterpriseId.slice(-4)}-${index}`,
          enterpriseId: input.enterpriseId,
          name: `GEO 测试员工 ${index + 1}`,
          phone: uniquePhone(),
          tenantId,
        },
      });
      const audience = await prisma.campaignAudienceSnapshot.create({
        data: {
          campaignId: campaign.id,
          employeeName: membership.name,
          employeePhone: membership.phone,
          enterpriseId: input.enterpriseId,
          membershipId: membership.id,
          tenantId,
        },
      });
      await prisma.employeeContent.create({
        data: {
          audienceSnapshotId: audience.id,
          body,
          campaignId: campaign.id,
          contentFingerprint: randomUUID().replaceAll("-", ""),
          enterpriseId: input.enterpriseId,
          imagePrompt: "GEO 测试图片",
          membershipId: membership.id,
          riskAssessment: { unresolvedBlocks: [], warnings: [] },
          status: "APPROVED",
          tenantId,
          title: input.title,
        },
      });
    }
  }

  async function request(path: string): Promise<Readonly<{ body: unknown; status: number }>> {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const text = await response.text();
    return { body: text ? (JSON.parse(text) as unknown) : null, status: response.status };
  }
});

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object response");
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array response");
  return value;
}

function uniquePhone(): string {
  return `135${randomInt(10_000_000, 100_000_000)}`;
}

function assertDevelopmentDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || new URL(databaseUrl).pathname.slice(1) !== "dev_xhs_agentic") {
    throw new Error("GEO analytics test requires dev_xhs_agentic");
  }
}
