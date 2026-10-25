import "reflect-metadata";

import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { deterministicEmbedding } from "@xhs-agentic/ai-gateway";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { configureApplication } from "../configure-application";
import { PrismaService } from "../database/prisma.service";
import { PlatformObjectStorageService } from "../platform-settings/platform-object-storage.service";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import type { IngestPublicationMetricsDto } from "./publication.dto";
import { canonicalMetricPayload } from "./publication-metrics-security";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

type ApiResponse = Readonly<{ status: number; body: unknown; headers: Headers }>;

describe("complete MVP campaign and publication lifecycle", { concurrent: false }, () => {
  const marker = `mvp-lifecycle-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const tenantAdminPhone = testPhone(marker, 1);
  const employeePhones = [testPhone(marker, 2), testPhone(marker, 3), testPhone(marker, 4)];
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let platformToken: string;
  let tenantToken: string;
  let tenantId: string;
  let enterpriseId: string;
  let campaignId: string;
  let sharedGeoEntityVersionId: string;
  let sharedMaterialVersionId: string;
  let sharedRuleId: string;
  let employeeTokens: string[] = [];
  let taskIds: string[] = [];
  let verifiedCanonicalKey: string;
  let verifiedUrl: string;
  let metricsIngestKey: string;

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
    const resolvedMetricsKey = (
      await app.get(PlatformSettingsReader).resolve("publication.metrics_ingest_key")
    ).value;
    if (typeof resolvedMetricsKey !== "string" || resolvedMetricsKey.length < 32) {
      throw new Error("MVP lifecycle test requires publication.metrics_ingest_key");
    }
    metricsIngestKey = resolvedMetricsKey;
  });

  afterAll(async () => {
    if (!prisma) return;
    const tenant = await prisma.tenant.findFirst({
      select: { id: true },
      where: { name: { startsWith: marker } },
    });
    if (tenant) {
      const userIds = (
        await prisma.globalUser.findMany({
          select: { id: true },
          where: { phone: { in: [tenantAdminPhone, ...employeePhones] } },
        })
      ).map(({ id }) => id);
      const [artifacts, generatedImages, reservations] = await Promise.all([
        prisma.materialArtifact.findMany({
          select: { objectKey: true },
          where: { tenantId: tenant.id },
        }),
        prisma.generatedImage.findMany({
          select: { storageKey: true },
          where: { tenantId: tenant.id },
        }),
        prisma.storageReservation.findMany({
          select: { storageKey: true },
          where: { tenantId: tenant.id },
        }),
      ]);
      const objectKeys = new Set(
        [
          ...artifacts.map(({ objectKey }) => objectKey),
          ...generatedImages.map(({ storageKey }) => storageKey),
          ...reservations.map(({ storageKey }) => storageKey),
        ].filter((key): key is string => typeof key === "string" && key.length > 0),
      );
      if (objectKeys.size > 0) {
        const { storage } = await app.get(PlatformObjectStorageService).current();
        await Promise.all([...objectKeys].map((key) => storage.delete(key)));
      }
      await prisma.publishMetricSnapshot.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.publishedContentRegistry.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.publishSubmission.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.publicContentFixture.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.generatedImage.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.distributionTask.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.employeeContentRevision.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.employeeContent.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.generationWorkItem.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.generationRun.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.campaignBlueprint.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.campaignAudienceSnapshot.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.campaignPreflightSnapshot.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.campaignRetrievalEvidence.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.campaign.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.materialEmbedding.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.materialChunk.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.materialIngestionJob.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.materialArtifact.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.material.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.sensitiveRule.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.geoTopic.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.geoEntity.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.storageUsageLedger.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.storageReservation.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.tenantStorageAccount.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.membershipImportBatch.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.roleBinding.deleteMany({
        where: { OR: [{ tenantId: tenant.id }, { userId: { in: userIds } }] },
      });
      await prisma.enterpriseMembership.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.department.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.customerContract.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.modelRoute.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.enterprise.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.tenant.delete({ where: { id: tenant.id } });
      await prisma.globalUser.deleteMany({ where: { id: { in: userIds } } });
    }
    await app.close();
  });

  it("opens a funded enterprise with three enabled employees and leaves one pending bind", async () => {
    const platformAuth = await request("/auth/dev/admin-token", {
      body: { phone: process.env.DEV_PLATFORM_ADMIN_PHONE },
      method: "POST",
    });
    expect(platformAuth.status).toBe(201);
    platformToken = stringField(platformAuth.body, "accessToken");

    const tenant = await request("/platform/tenants", {
      body: { customerType: "GROUP", name: `${marker}-tenant` },
      method: "POST",
      token: platformToken,
    });
    expect(tenant.status).toBe(201);
    tenantId = stringField(tenant.body, "id");
    const enterprise = await request(`/platform/tenants/${tenantId}/enterprises`, {
      body: { code: `${marker}-enterprise`, name: "MVP 闭环企业" },
      method: "POST",
      token: platformToken,
    });
    expect(enterprise.status).toBe(201);
    enterpriseId = stringField(enterprise.body, "id");
    const [textModel, imageModel] = await Promise.all([
      prisma.modelDefinition.findFirstOrThrow({
        where: { code: "SYNTHETIC_COPY_V1", synthetic: true },
      }),
      prisma.modelDefinition.findFirstOrThrow({
        where: { code: "SYNTHETIC_SVG_V1", synthetic: true },
      }),
    ]);
    await prisma.modelRoute.create({
      data: {
        tenantId,
        scopeId: tenantId,
        scopeType: "TENANT",
        textModelId: textModel.id,
        imageModelId: imageModel.id,
        createdBy: "test:mvp-lifecycle",
      },
    });
    expect(
      (
        await request(`/platform/tenants/${tenantId}/admins`, {
          body: { phone: tenantAdminPhone, reason: "发布闭环测试授予集团管理员" },
          method: "POST",
          token: platformToken,
        })
      ).status,
    ).toBe(201);
    const tenantAuth = await request("/auth/dev/admin-token", {
      body: { phone: tenantAdminPhone },
      method: "POST",
    });
    tenantToken = stringField(tenantAuth.body, "accessToken");

    const imported = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/memberships/import`,
      {
        body: {
          members: employeePhones.map((phone, index) => ({
            employeeNo: `MVP-${index + 1}`,
            name: `员工${index + 1}`,
            phone,
          })),
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(imported.status).toBe(201);
    const memberships = arrayField(imported.body, "memberships");
    expect(memberships).toHaveLength(3);
    for (const membership of memberships) {
      const membershipId = stringField(membership, "id");
      const enabled = await request(
        `/console/tenants/${tenantId}/enterprises/${enterpriseId}/memberships/${membershipId}/enable`,
        {
          body: { reason: "MVP lifecycle test" },
          method: "POST",
          token: tenantToken,
        },
      );
      expect(enabled.status).toBe(201);
    }
    employeeTokens = [];
    for (const phone of employeePhones.slice(0, 2)) {
      const requested = await request("/auth/employee/request-code", {
        body: { phone },
        method: "POST",
      });
      expect(requested.status).toBe(201);
      expect(stringField(requested.body, "developmentCode")).toBe("000000");
      const bound = await request("/auth/employee/bind", {
        body: { code: "000000", enterpriseIds: [enterpriseId], phone },
        method: "POST",
      });
      expect(bound.status).toBe(201);
      employeeTokens.push(stringField(bound.body, "accessToken"));
    }
    expect(employeeTokens).toHaveLength(2);
    await expect(
      prisma.enterpriseMembership.count({
        where: { enterpriseId, seatStatus: "ENABLED", status: "PENDING_BIND" },
      }),
    ).resolves.toBe(1);
  });

  it("inherits versioned group materials, sensitive rules and GEO assets", async () => {
    const materialV1 = await request(`/console/tenants/${tenantId}/materials`, {
      body: {
        authorizationConfirmed: true,
        content: "集团公共资料 v1：全飞秒设备采用规范流程。",
        tags: ["集团公共", "设备"],
        title: "集团全飞秒资料",
        type: "TEXT",
      },
      method: "POST",
      token: tenantToken,
    });
    expect(materialV1.status).toBe(201);
    expect(numberField(materialV1.body, "version")).toBe(1);
    const materialV1Id = stringField(materialV1.body, "id");
    const materialSeriesId = stringField(materialV1.body, "seriesId");
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: materialV1Id } }),
    ).resolves.toMatchObject({ ingestionStatus: "PENDING", status: "ACTIVE" });
    await completePendingMaterialIngestion(materialV1Id);
    const materialV2 = await request(
      `/console/tenants/${tenantId}/materials/${materialV1Id}/versions`,
      {
        body: {
          authorizationConfirmed: true,
          changeNote: "补充设备评估边界",
          content: "集团公共资料 v2：设备能力需要结合规范术前评估与个体条件说明。",
          tags: ["集团公共", "设备", "术前评估"],
          title: "集团全飞秒资料",
          type: "TEXT",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(materialV2.status).toBe(201);
    expect(numberField(materialV2.body, "version")).toBe(2);
    expect(stringField(materialV2.body, "seriesId")).toBe(materialSeriesId);
    sharedMaterialVersionId = stringField(materialV2.body, "id");
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: materialV1Id } }),
    ).resolves.toMatchObject({ ingestionStatus: "READY", status: "ACTIVE", version: 1 });
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: sharedMaterialVersionId } }),
    ).resolves.toMatchObject({ ingestionStatus: "PENDING", status: "ACTIVE", version: 2 });
    await completePendingMaterialIngestion(sharedMaterialVersionId);
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: materialV1Id } }),
    ).resolves.toMatchObject({
      status: "DISABLED",
      version: 1,
    });

    const sharedRule = await request(`/console/tenants/${tenantId}/sensitive-rules`, {
      body: {
        replacementSuggestion: "规范改善",
        riskType: "集团医疗合规",
        severity: "NOTICE",
        term: "绝对治愈",
      },
      method: "POST",
      token: tenantToken,
    });
    expect(sharedRule.status).toBe(201);
    sharedRuleId = stringField(sharedRule.body, "id");

    const geoV1 = await request(`/console/tenants/${tenantId}/geo-entities`, {
      body: { aliases: ["全飞秒"], name: "全飞秒 Pro", type: "TECHNOLOGY" },
      method: "POST",
      token: tenantToken,
    });
    expect(geoV1.status).toBe(201);
    const geoV1Id = stringField(geoV1.body, "id");
    const topicV1 = await request(`/console/tenants/${tenantId}/geo-topics`, {
      body: {
        entityId: geoV1Id,
        intent: "技术科普",
        priority: 80,
        question: "全飞秒 Pro 的设备和评估流程是什么？",
      },
      method: "POST",
      token: tenantToken,
    });
    expect(topicV1.status).toBe(201);
    const geoV2 = await request(`/console/tenants/${tenantId}/geo-entities/${geoV1Id}/versions`, {
      body: {
        aliases: ["全飞秒", "SMILE Pro"],
        changeNote: "补充英文技术别名",
        name: "全飞秒 Pro",
        type: "TECHNOLOGY",
      },
      method: "POST",
      token: tenantToken,
    });
    expect(geoV2.status, JSON.stringify(geoV2.body)).toBe(201);
    sharedGeoEntityVersionId = stringField(geoV2.body, "id");
    expect(numberField(geoV2.body, "version")).toBe(2);
    await expect(
      prisma.geoTopic.findFirstOrThrow({
        where: { entityId: sharedGeoEntityVersionId, status: "ACTIVE" },
      }),
    ).resolves.toMatchObject({ version: 2 });

    const inheritedMaterials = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/materials`,
      { token: tenantToken },
    );
    expect(inheritedMaterials.status).toBe(200);
    expect(
      (inheritedMaterials.body as unknown[]).some(
        (item) => stringField(item, "id") === sharedMaterialVersionId,
      ),
    ).toBe(true);
    const cannotDisableInherited = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/materials/${sharedMaterialVersionId}/disable`,
      {
        body: { reason: "企业不能停用集团公共资产" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(cannotDisableInherited.status).toBe(404);
  });

  it("creates authorized context and generates one independent text-image package per employee", async () => {
    const material = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/materials`,
      {
        body: {
          authorizationConfirmed: true,
          content: "全飞秒技术资料：设备稳定性、规范术前评估和个体化方案都很重要。",
          tags: ["设备", "技术"],
          title: "全飞秒技术资料",
          type: "TEXT",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(material.status).toBe(201);
    await completePendingMaterialIngestion(stringField(material.body, "id"));
    const sensitive = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/sensitive-rules`,
      {
        body: {
          replacementSuggestion: "规范改善",
          riskType: "医疗绝对化",
          severity: "BLOCK",
          term: "绝对治愈",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(sensitive.status).toBe(201);
    const enterpriseGeo = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/geo-entities`,
      {
        body: {
          aliases: ["企业版全飞秒"],
          name: "全飞秒 Pro",
          type: "TECHNOLOGY",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(enterpriseGeo.status).toBe(201);
    const enterpriseGeoId = stringField(enterpriseGeo.body, "id");

    const campaignRequest = {
      prompt: "生成全飞秒 Pro 技术宣传内容，强调设备与效果，但不要承诺绝对治愈。",
      title: "全飞秒 Pro 技术分享",
      visibleAt: new Date(Date.now() + 9 * 3_600_000).toISOString(),
    };
    const campaignIdempotencyKey = randomUUID();
    const generated = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns`,
      {
        body: campaignRequest,
        idempotencyKey: campaignIdempotencyKey,
        method: "POST",
        token: tenantToken,
      },
    );
    expect(generated.status, JSON.stringify(generated.body)).toBe(201);
    expect(stringField(generated.body, "status")).toBe("REVIEW_PENDING");
    expectCustomerCampaignResponseSanitized(generated.body);
    campaignId = stringField(generated.body, "id");
    const retrievalEvidence = arrayField(generated.body, "retrievalEvidence");
    expect(retrievalEvidence.length).toBeGreaterThan(0);
    expect(retrievalEvidence.every((item) => stringField(item, "frozenSnippet").length > 0)).toBe(
      true,
    );
    const contents = arrayField(generated.body, "employeeContents");
    expect(contents).toHaveLength(3);
    expect(contents.every((item) => !stringField(item, "body").includes("绝对治愈"))).toBe(true);
    const images = await prisma.generatedImage.findMany({ where: { tenantId } });
    expect(images).toHaveLength(3);
    expect(new Set(images.map(({ checksum }) => checksum)).size).toBe(3);
    expect(new Set(images.map(({ imageUrl }) => imageUrl)).size).toBe(3);
    expect(images.every(({ synthetic }) => synthetic)).toBe(true);
    const replayed = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns`,
      {
        body: campaignRequest,
        idempotencyKey: campaignIdempotencyKey,
        method: "POST",
        token: tenantToken,
      },
    );
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get("idempotency-replayed")).toBe("true");
    expect(stringField(replayed.body, "id")).toBe(campaignId);
    const frozenBeforeVersion = await prisma.campaignRetrievalEvidence.findMany({
      orderBy: { rank: "asc" },
      where: { campaignId },
    });
    const materialVersion = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/materials/${stringField(material.body, "id")}/versions`,
      {
        body: {
          authorizationConfirmed: true,
          changeNote: "验证活动 Chunk 证据冻结",
          content: "全飞秒技术资料更新：新增设备维护与规范评估说明。",
          tags: ["设备", "技术", "维护"],
          title: "全飞秒技术资料更新",
          type: "TEXT",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(materialVersion.status).toBe(201);
    await completePendingMaterialIngestion(stringField(materialVersion.body, "id"));
    await expect(
      prisma.campaignRetrievalEvidence.findMany({
        orderBy: { rank: "asc" },
        where: { campaignId },
      }),
    ).resolves.toEqual(frozenBeforeVersion);
    await expect(prisma.campaign.count({ where: { id: campaignId } })).resolves.toBe(1);

    const [listed, detailed, workspace] = await Promise.all([
      request(`/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns`, {
        token: tenantToken,
      }),
      request(`/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${campaignId}`, {
        token: tenantToken,
      }),
      request(`/console/tenants/${tenantId}/enterprises/${enterpriseId}/workspace`, {
        token: tenantToken,
      }),
    ]);
    expect(listed.status).toBe(200);
    const listedCampaign = arrayField(listed.body, "items").find(
      (item) => stringField(item, "id") === campaignId,
    );
    expect(listedCampaign).toBeDefined();
    expectCustomerCampaignResponseSanitized(listedCampaign);
    expect(detailed.status).toBe(200);
    expectCustomerCampaignResponseSanitized(detailed.body);
    expect(workspace.status).toBe(200);
    expect(asRecord(workspace.body)).toMatchObject({
      campaignReady: true,
      campaigns: {
        active: 0,
        approved: 0,
        completed: 0,
        generating: 0,
        generationFailed: 0,
        reviewPending: 1,
        total: 1,
      },
      nextAction: {
        code: "REVIEW_CAMPAIGN",
        href: "/console/campaigns?view=ACTION_REQUIRED",
      },
    });
    expect(JSON.stringify(workspace.body)).not.toMatch(
      /provider|endpoint|credential|apiKey|modelName/iu,
    );

    const blueprint = await prisma.campaignBlueprint.findUniqueOrThrow({ where: { campaignId } });
    const sourceContext = asRecord(blueprint.sourceContext);
    expect(stringField(sourceContext, "schemaVersion")).toBe("content-assets-v2");
    const assetSnapshot = objectField(sourceContext, "assetSnapshot");
    const materialSnapshots = arrayField(assetSnapshot, "materials");
    expect(
      materialSnapshots.some(
        (item) =>
          stringField(item, "id") === sharedMaterialVersionId && numberField(item, "version") === 2,
      ),
    ).toBe(true);
    const sensitiveSnapshots = arrayField(assetSnapshot, "sensitiveRules");
    expect(sensitiveSnapshots.some((item) => stringField(item, "id") === sharedRuleId)).toBe(false);
    expect(
      sensitiveSnapshots.some(
        (item) => stringField(item, "id") === stringField(sensitive.body, "id"),
      ),
    ).toBe(true);
    const geoSnapshots = arrayField(assetSnapshot, "geoEntities");
    expect(geoSnapshots.some((item) => stringField(item, "id") === sharedGeoEntityVersionId)).toBe(
      false,
    );
    expect(geoSnapshots.some((item) => stringField(item, "id") === enterpriseGeoId)).toBe(true);
  });

  it("keeps the campaign asset snapshot immutable after a source is disabled", async () => {
    const disabled = await request(
      `/console/tenants/${tenantId}/materials/${sharedMaterialVersionId}/disable`,
      {
        body: { reason: "验证历史活动仍保留原始资产版本" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(disabled.status).toBe(201);
    expect(stringField(disabled.body, "status")).toBe("DISABLED");
    const blueprint = await prisma.campaignBlueprint.findUniqueOrThrow({ where: { campaignId } });
    const materialSnapshots = arrayField(
      objectField(asRecord(blueprint.sourceContext), "assetSnapshot"),
      "materials",
    );
    expect(
      materialSnapshots.some(
        (item) =>
          stringField(item, "id") === sharedMaterialVersionId && numberField(item, "version") === 2,
      ),
    ).toBe(true);
  });

  it("publishes immutable document and link versions and switches them only after ingestion", async () => {
    const documentV1Bytes = new TextEncoder().encode(
      `文档版本一 ${marker}：设备资料与规范评估说明。`,
    );
    const documentV1Checksum = createHash("sha256").update(documentV1Bytes).digest("hex");
    const documentV1Intent = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/material-upload-intents`,
      {
        body: {
          authorizationConfirmed: true,
          byteSize: documentV1Bytes.byteLength,
          checksum: documentV1Checksum,
          fileName: "device-v1.txt",
          mimeType: "text/plain",
          tags: ["设备资料"],
          title: "设备资料文档",
          type: "DOCUMENT",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(documentV1Intent.status).toBe(201);
    const documentV1Id = stringField(documentV1Intent.body, "materialId");
    const documentV1ArtifactId = stringField(documentV1Intent.body, "artifactId");
    await uploadMaterialArtifact(documentV1Intent.body, documentV1Bytes, "text/plain");
    const documentV1Queued = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/materials/${documentV1Id}/artifacts/${documentV1ArtifactId}/complete`,
      {
        body: { uploadCompleted: true },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(documentV1Queued.status).toBe(201);
    await completePendingMaterialIngestion(documentV1Id, new TextDecoder().decode(documentV1Bytes));
    const documentV1 = await prisma.material.findUniqueOrThrow({ where: { id: documentV1Id } });

    const missingChangeNote = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/material-upload-intents`,
      {
        body: {
          authorizationConfirmed: true,
          byteSize: 16,
          checksum: createHash("sha256").update(`${marker}-missing-note`).digest("hex"),
          fileName: "missing-note.txt",
          mimeType: "text/plain",
          supersedesId: documentV1Id,
          title: "缺少变更说明",
          type: "DOCUMENT",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(missingChangeNote.status).toBe(409);

    const documentV2Bytes = new TextEncoder().encode(
      `文档版本二 ${marker}：补充设备边界与个体差异说明。`,
    );
    const documentV2Intent = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/material-upload-intents`,
      {
        body: {
          authorizationConfirmed: true,
          byteSize: documentV2Bytes.byteLength,
          changeNote: "补充设备边界",
          checksum: createHash("sha256").update(documentV2Bytes).digest("hex"),
          fileName: "device-v2.txt",
          mimeType: "text/plain",
          supersedesId: documentV1Id,
          tags: ["设备资料", "个体差异"],
          title: "设备资料文档",
          type: "DOCUMENT",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(documentV2Intent.status).toBe(201);
    const documentV2Id = stringField(documentV2Intent.body, "materialId");
    const documentV2ArtifactId = stringField(documentV2Intent.body, "artifactId");
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: documentV2Id } }),
    ).resolves.toMatchObject({
      ingestionStatus: "PENDING",
      seriesId: documentV1.seriesId,
      status: "ACTIVE",
      supersedesId: documentV1Id,
      version: 2,
    });
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: documentV1Id } }),
    ).resolves.toMatchObject({ ingestionStatus: "READY", status: "ACTIVE", version: 1 });

    const nonLatestSource = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/material-upload-intents`,
      {
        body: {
          authorizationConfirmed: true,
          byteSize: 17,
          changeNote: "错误地继续使用 V1",
          checksum: createHash("sha256").update(`${marker}-non-latest`).digest("hex"),
          fileName: "non-latest.txt",
          mimeType: "text/plain",
          supersedesId: documentV1Id,
          title: "非最新版本",
          type: "DOCUMENT",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(nonLatestSource.status).toBe(409);
    const changedSourceType = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/material-upload-intents`,
      {
        body: {
          authorizationConfirmed: true,
          byteSize: 18,
          changeNote: "错误地改变素材类型",
          checksum: createHash("sha256").update(`${marker}-changed-type`).digest("hex"),
          fileName: "changed-type.png",
          mimeType: "image/png",
          supersedesId: documentV2Id,
          title: "改变类型的版本",
          type: "IMAGE_REFERENCE",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(changedSourceType.status).toBe(409);

    await uploadMaterialArtifact(documentV2Intent.body, documentV2Bytes, "text/plain");
    const documentV2Queued = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/materials/${documentV2Id}/artifacts/${documentV2ArtifactId}/complete`,
      {
        body: { uploadCompleted: true },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(documentV2Queued.status).toBe(201);
    await completePendingMaterialIngestion(documentV2Id, new TextDecoder().decode(documentV2Bytes));
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: documentV1Id } }),
    ).resolves.toMatchObject({ status: "DISABLED", version: 1 });
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: documentV2Id } }),
    ).resolves.toMatchObject({ ingestionStatus: "READY", status: "ACTIVE", version: 2 });

    const linkV1Queued = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/material-links`,
      {
        body: {
          authorizationConfirmed: true,
          content: "链接版本一：公开设备说明。",
          sourceUrl: `https://example.com/${marker}/device-v1`,
          title: "公开设备链接",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(linkV1Queued.status).toBe(201);
    const linkV1Id = stringField(linkV1Queued.body, "materialId");
    await completePendingMaterialIngestion(linkV1Id);
    const linkV1 = await prisma.material.findUniqueOrThrow({ where: { id: linkV1Id } });
    const linkV2Queued = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/material-links`,
      {
        body: {
          authorizationConfirmed: true,
          changeNote: "更新公开说明",
          content: "链接版本二：补充规范评估与风险边界。",
          sourceUrl: `https://example.com/${marker}/device-v2`,
          supersedesId: linkV1Id,
          title: "公开设备链接",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(linkV2Queued.status).toBe(201);
    const linkV2Id = stringField(linkV2Queued.body, "materialId");
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: linkV2Id } }),
    ).resolves.toMatchObject({
      ingestionStatus: "PENDING",
      seriesId: linkV1.seriesId,
      status: "ACTIVE",
      supersedesId: linkV1Id,
      version: 2,
    });
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: linkV1Id } }),
    ).resolves.toMatchObject({ ingestionStatus: "READY", status: "ACTIVE" });
    await completePendingMaterialIngestion(linkV2Id);
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: linkV1Id } }),
    ).resolves.toMatchObject({ status: "DISABLED" });
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: linkV2Id } }),
    ).resolves.toMatchObject({ ingestionStatus: "READY", status: "ACTIVE", version: 2 });
  });

  it("includes a pending-bind enabled employee, then securely previews and binds its enterprise", async () => {
    const phone = employeePhones[2];
    if (!phone) throw new Error("Expected the third employee phone");
    const requested = await request("/auth/employee/request-code", {
      body: { phone },
      method: "POST",
    });
    expect(requested.status).toBe(201);
    expect(stringField(requested.body, "developmentCode")).toBe("000000");

    const wrongCode = await request("/auth/employee/candidates", {
      body: { code: "111111", phone },
      method: "POST",
    });
    expect(wrongCode.status).toBe(401);
    const candidates = await request("/auth/employee/candidates", {
      body: { code: "000000", phone },
      method: "POST",
    });
    expect(candidates.status).toBe(201);
    const candidateRows = arrayField(candidates.body, "candidates");
    expect(candidateRows).toHaveLength(1);
    expect(stringField(candidateRows[0], "enterpriseId")).toBe(enterpriseId);

    const bound = await request("/auth/employee/bind", {
      body: { code: "000000", enterpriseIds: [enterpriseId], phone },
      method: "POST",
    });
    expect(bound.status).toBe(201);
    employeeTokens.push(stringField(bound.body, "accessToken"));
    expect(employeeTokens).toHaveLength(3);

    const replay = await request("/auth/employee/bind", {
      body: { code: "000000", enterpriseIds: [enterpriseId], phone },
      method: "POST",
    });
    expect(replay.status).toBe(401);

    const tasks = await request("/employee/tasks", { token: employeeTokens[2] });
    expect(tasks.status).toBe(200);
    const task = campaignTask(tasks.body, campaignId);
    expect(stringField(task, "status")).toBe("LOCKED");
    expect(asRecord(task).content).toBeNull();
  });

  it("keeps content locked before approval and unlocks all tasks after human approval", async () => {
    const locked = await request("/employee/tasks", { token: employeeTokens[0] });
    expect(locked.status).toBe(200);
    const lockedTask = campaignTask(locked.body, campaignId);
    expect(stringField(lockedTask, "status")).toBe("LOCKED");
    expect(asRecord(lockedTask).content).toBeNull();

    const campaignSchedule = await prisma.campaign.findUniqueOrThrow({
      select: { visibleAt: true },
      where: { id: campaignId },
    });
    const approved = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${campaignId}/approve`,
      {
        body: { visibleAt: campaignSchedule.visibleAt.toISOString() },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(approved.status).toBe(201);
    expect(stringField(approved.body, "status")).toBe("APPROVED");
    const scheduledTasks = await request("/employee/tasks", { token: employeeTokens[0] });
    expect(stringField(campaignTask(scheduledTasks.body, campaignId), "status")).toBe("LOCKED");

    // Advance only this test campaign's persisted schedule to exercise the
    // already-open distribution flow without weakening the eight-hour rule.
    const openedAt = new Date(Date.now() - 2_000);
    const expiresAt = new Date(openedAt.getTime() + 24 * 3_600_000);
    await prisma.$transaction([
      prisma.campaign.update({
        data: { visibleAt: openedAt, expiresAt },
        where: { id: campaignId },
      }),
      prisma.distributionTask.updateMany({
        data: { visibleAt: openedAt, expiresAt },
        where: { campaignId },
      }),
    ]);
    taskIds = [];
    for (const token of employeeTokens) {
      const response = await request("/employee/tasks", { token });
      const task = campaignTask(response.body, campaignId);
      expect(stringField(task, "status")).toBe("AVAILABLE");
      expect(asRecord(task).content).not.toBeNull();
      const confirmed = await request(`/employee/tasks/${stringField(task, "id")}/facts`, {
        body: { revision: numberField(task, "contentRevision"), confirmed: true },
        method: "POST",
        token,
      });
      expect(confirmed.status).toBe(201);
      expect(booleanField(confirmed.body, "factsConfirmationRequired")).toBe(true);
      expect(booleanField(confirmed.body, "factsConfirmed")).toBe(true);
      taskIds.push(stringField(task, "id"));
    }
  });

  it("allows an employee to view, copy, publish and pass content-image verification", async () => {
    const viewed = await request(`/employee/tasks/${taskIds[0]}/view`, {
      method: "POST",
      token: employeeTokens[0],
    });
    expect(viewed.status).toBe(201);
    expect(
      (
        await request(`/employee/tasks/${taskIds[0]}/events`, {
          body: { type: "COPY", revision: numberField(viewed.body, "contentRevision") },
          method: "POST",
          token: employeeTokens[0],
        })
      ).status,
    ).toBe(201);
    const fixture = await request(`/employee/tasks/${taskIds[0]}/dev-publication`, {
      body: { contentMode: "MATCH" },
      method: "POST",
      token: employeeTokens[0],
    });
    expect(fixture.status).toBe(201);
    expect(booleanField(fixture.body, "synthetic")).toBe(true);
    verifiedUrl = stringField(fixture.body, "normalizedUrl");
    const submitted = await request(`/employee/tasks/${taskIds[0]}/submissions`, {
      body: { url: `我的发布链接：${verifiedUrl}?utm_source=employee-share` },
      method: "POST",
      token: employeeTokens[0],
    });
    expect(submitted.status).toBe(201);
    expect(stringField(submitted.body, "status")).toBe("VALID");
    verifiedCanonicalKey = stringField(submitted.body, "canonicalKey");
    const completedTask = await request(`/employee/tasks/${taskIds[0]}`, {
      token: employeeTokens[0],
    });
    expect(stringField(completedTask.body, "status")).toBe("COMPLETED");
  });

  it("prevents cross-employee reads and rejects a globally duplicated link", async () => {
    const crossRead = await request(`/employee/tasks/${taskIds[0]}`, {
      token: employeeTokens[1],
    });
    expect(crossRead.status).toBe(404);
    const duplicate = await request(`/employee/tasks/${taskIds[1]}/submissions`, {
      body: { url: verifiedUrl },
      method: "POST",
      token: employeeTokens[1],
    });
    expect(duplicate.status).toBe(201);
    expect(stringField(duplicate.body, "status")).toBe("DUPLICATE");
    const duplicateTask = await request(`/employee/tasks/${taskIds[1]}`, {
      token: employeeTokens[1],
    });
    expect(stringField(duplicateTask.body, "status")).toBe("AVAILABLE");
    expect(stringField(duplicateTask.body, "submissionFailureReason")).toContain("其他员工任务");
  });

  it("rejects unrelated published content instead of accepting a link at face value", async () => {
    const fixture = await request(`/employee/tasks/${taskIds[2]}/dev-publication`, {
      body: { contentMode: "UNRELATED" },
      method: "POST",
      token: employeeTokens[2],
    });
    expect(fixture.status).toBe(201);
    const rejected = await request(`/employee/tasks/${taskIds[2]}/submissions`, {
      body: { url: stringField(fixture.body, "normalizedUrl") },
      method: "POST",
      token: employeeTokens[2],
    });
    expect(rejected.status).toBe(201);
    expect(stringField(rejected.body, "status")).toBe("INVALID");
    const rejectedTask = await request(`/employee/tasks/${taskIds[2]}`, {
      token: employeeTokens[2],
    });
    expect(stringField(rejectedTask.body, "status")).toBe("AVAILABLE");
    expect(stringField(rejectedTask.body, "submissionFailureReason")).toMatch(
      /正文相似度|图片相似度/u,
    );
  });

  it("keeps an on-time unavailable verification pending after expiry and allows a later decision", async () => {
    const submitted = await request(`/employee/tasks/${taskIds[2]}/submissions`, {
      body: { url: `https://www.xiaohongshu.com/explore/${randomUUID().replaceAll("-", "")}` },
      method: "POST",
      token: employeeTokens[2],
    });
    expect(submitted.status).toBe(201);
    expect(stringField(submitted.body, "status")).toBe("UNAVAILABLE");
    const submissionId = stringField(submitted.body, "submissionId");
    const submission = await prisma.publishSubmission.findUniqueOrThrow({
      where: { id: submissionId },
    });
    const expiresAt = new Date(submission.submittedAt.getTime() + 20);
    await prisma.distributionTask.update({
      data: {
        expiresAt,
        visibleAt: new Date(expiresAt.getTime() - 24 * 3_600_000),
      },
      where: { id: taskIds[2] },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const afterExpiry = await request("/employee/tasks", { token: employeeTokens[2] });
    expect(stringField(campaignTask(afterExpiry.body, campaignId), "status")).toBe("VERIFYING");
    const reviewed = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/publication-reviews/${submissionId}`,
      {
        body: { decision: "VERIFIED", reason: "员工按时提交，授权运营已核对公开内容" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(reviewed.status).toBe(201);
    expect(stringField(reviewed.body, "status")).toBe("VALID");
    const completed = await request(`/employee/tasks/${taskIds[2]}`, {
      token: employeeTokens[2],
    });
    expect(stringField(completed.body, "status")).toBe("COMPLETED");
  });

  it("accepts idempotent Hermes metrics and exposes authorized rankings", async () => {
    const registry = await prisma.publishedContentRegistry.findUniqueOrThrow({
      where: { canonicalKey: verifiedCanonicalKey },
    });
    const observedAt = new Date(registry.verifiedAt.getTime() + 1000).toISOString();
    const metricBody = {
      canonicalKey: verifiedCanonicalKey,
      comments: 8,
      favorites: 21,
      likes: 35,
      observedAt,
      shares: 3,
      source: "HERMES",
      views: 1280,
      windowHours: 24,
    };
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const unauthorized = await request("/integrations/v1/publish-metrics", {
      body: metricBody,
      headers: {
        "x-integration-signature": "0".repeat(64),
        "x-integration-timestamp": timestamp,
      },
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);
    const expiredTimestamp = (Math.floor(Date.now() / 1000) - 301).toString();
    const expiredSignature = metricSignature(metricsIngestKey, expiredTimestamp, metricBody);
    const expiredRequest = await request("/integrations/v1/publish-metrics", {
      body: metricBody,
      headers: {
        "x-integration-signature": expiredSignature,
        "x-integration-timestamp": expiredTimestamp,
      },
      method: "POST",
    });
    expect(expiredRequest.status).toBe(401);
    const originalMetricsCapability = await prisma.tenantCapabilityPolicy.findUniqueOrThrow({
      select: { metricsIntegrationEnabled: true },
      where: { tenantId },
    });
    await prisma.tenantCapabilityPolicy.update({
      data: { metricsIntegrationEnabled: false },
      where: { tenantId },
    });
    const planDenied = await request("/integrations/v1/publish-metrics", {
      body: metricBody,
      headers: {
        "x-integration-signature": metricSignature(metricsIngestKey, timestamp, metricBody),
        "x-integration-timestamp": timestamp,
      },
      method: "POST",
    });
    await prisma.tenantCapabilityPolicy.update({
      data: originalMetricsCapability,
      where: { tenantId },
    });
    expect(planDenied.status).toBe(403);
    expect(asRecord(planDenied.body)).toMatchObject({
      code: "TENANT_METRICS_INTEGRATION_DISABLED",
    });
    for (let index = 0; index < 2; index += 1) {
      const signedAt = Math.floor(Date.now() / 1000).toString();
      const ingested = await request("/integrations/v1/publish-metrics", {
        body: metricBody,
        headers: {
          "x-integration-signature": metricSignature(metricsIngestKey, signedAt, metricBody),
          "x-integration-timestamp": signedAt,
        },
        method: "POST",
      });
      expect(ingested.status).toBe(201);
    }
    const conflictingBody = { ...metricBody, views: 1300 };
    const conflictingTimestamp = Math.floor(Date.now() / 1000).toString();
    const conflict = await request("/integrations/v1/publish-metrics", {
      body: conflictingBody,
      headers: {
        "x-integration-signature": metricSignature(
          metricsIngestKey,
          conflictingTimestamp,
          conflictingBody,
        ),
        "x-integration-timestamp": conflictingTimestamp,
      },
      method: "POST",
    });
    expect(conflict.status).toBe(409);
    expect(await prisma.publishMetricSnapshot.count({ where: { tenantId } })).toBe(1);
    const frozen = await prisma.publishMetricSnapshot.findFirstOrThrow({ where: { tenantId } });
    expect(frozen.views).toBe(1280);
    const integrationAudit = await prisma.auditLog.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
      where: { action: "publication.metrics.ingest", tenantId },
    });
    expect(integrationAudit.actorType).toBe("INTEGRATION");
    expect(JSON.stringify(integrationAudit)).not.toContain(metricsIngestKey);

    const dashboard = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/dashboard?campaignId=${campaignId}`,
      { token: tenantToken },
    );
    expect(dashboard.status).toBe(200);
    const summary = objectField(dashboard.body, "summary");
    expect(numberField(summary, "verifiedCount")).toBe(2);
    expect(numberField(summary, "lateCorrectedCount")).toBe(0);
    const rankings = arrayField(dashboard.body, "rankings");
    expect(rankings).toHaveLength(1);
    expect(numberField(objectField(rankings[0], "latestMetrics"), "views")).toBe(1280);

    const browserBody = {
      canonicalKey: verifiedCanonicalKey,
      comments: 0,
      favorites: null,
      likes: null,
      observedAt: new Date(new Date(observedAt).getTime() + 60_000).toISOString(),
      rawData: {
        metricDisplay: { likes: "1.2万" },
        metricPrecision: { comments: "EXACT", favorites: "UNAVAILABLE", likes: "APPROXIMATE" },
      },
      shares: null,
      source: "WORKBUDDY_BROWSER",
      views: null,
      windowHours: 0,
    } satisfies IngestPublicationMetricsDto;
    const browserTimestamp = Math.floor(Date.now() / 1000).toString();
    const browserIngest = await request("/integrations/v1/publish-metrics", {
      body: browserBody,
      headers: {
        "x-integration-signature": metricSignature(metricsIngestKey, browserTimestamp, browserBody),
        "x-integration-timestamp": browserTimestamp,
      },
      method: "POST",
    });
    expect(browserIngest.status, JSON.stringify(browserIngest.body)).toBe(201);
    const browserDashboard = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/dashboard?campaignId=${campaignId}`,
      { token: tenantToken },
    );
    expect(browserDashboard.status).toBe(200);
    const browserSummary = objectField(browserDashboard.body, "summary");
    expect(objectField(browserSummary, "metricTotals")).toMatchObject({
      comments: 0,
      favorites: null,
      likes: null,
      views: null,
    });
    expect(objectField(browserSummary, "metricCoverage")).toMatchObject({
      comments: 1,
      favorites: 0,
      likes: 0,
      views: 0,
    });
    expect(arrayField(browserDashboard.body, "rankings")).toHaveLength(0);
    const observations = arrayField(browserDashboard.body, "metricObservations");
    expect(observations).toHaveLength(2);
    expect(objectField(observations[0], "latestMetrics")).toMatchObject({
      comments: 0,
      likes: null,
      rawData: { metricDisplay: { likes: "1.2万" } },
      windowHours: 0,
    });
    expect(objectField(observations[1], "latestMetrics")).toMatchObject({
      views: 1280,
      windowHours: 24,
    });

    const employeeDenied = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/dashboard`,
      { token: employeeTokens[0] },
    );
    expect(employeeDenied.status).toBe(401);
  });

  it("expires an unfinished task after its fixed 24-hour window and marks it incomplete", async () => {
    const visibleAt = new Date(Date.now() - 25 * 3_600_000);
    await prisma.distributionTask.update({
      data: { expiresAt: new Date(visibleAt.getTime() + 24 * 3_600_000), visibleAt },
      where: { id: taskIds[1] },
    });
    const tasks = await request("/employee/tasks", { token: employeeTokens[1] });
    const expiredTask = campaignTask(tasks.body, campaignId);
    expect(stringField(expiredTask, "status")).toBe("EXPIRED");
    expect(asRecord(expiredTask).content).toBeNull();
    const dashboard = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/dashboard?campaignId=${campaignId}`,
      { token: tenantToken },
    );
    const incomplete = arrayField(dashboard.body, "incompleteEmployees");
    expect(incomplete.some((item) => stringField(item, "taskId") === taskIds[1])).toBe(true);
    const tenantDashboard = await request(`/console/tenants/${tenantId}/dashboard`, {
      token: tenantToken,
    });
    expect(tenantDashboard.status).toBe(200);
  });

  it("supports server-side campaign operations without copying or mutating historical facts", async () => {
    const copyInput = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${campaignId}/copy-input`,
      { token: tenantToken },
    );
    expect(copyInput.status).toBe(200);
    expect(asRecord(copyInput.body)).toMatchObject({
      audienceMode: "ALL",
      imageCount: 1,
      sourceCampaignId: campaignId,
      title: "全飞秒 Pro 技术分享",
    });
    expect(arrayField(copyInput.body, "membershipIds")).toHaveLength(3);
    await expect(prisma.campaign.count({ where: { tenantId } })).resolves.toBe(1);

    const timeline = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${campaignId}/timeline`,
      { token: tenantToken },
    );
    expect(timeline.status).toBe(200);
    const timelineTitles = arrayField(timeline.body, "events").map((event) =>
      stringField(event, "title"),
    );
    expect(timelineTitles).toEqual(
      expect.arrayContaining(["活动已创建", "生成前置检查通过", "活动母版已生成", "活动已批准"]),
    );
    expect(JSON.stringify(timeline.body)).not.toMatch(/provider|endpoint|apiKey|modelName|cost/iu);

    const run = await prisma.generationRun.findFirstOrThrow({ where: { campaignId } });
    const snapshots = await prisma.campaignAudienceSnapshot.findMany({
      orderBy: { createdAt: "asc" },
      take: 2,
      where: { campaignId },
    });
    const failedSnapshot = snapshots[0];
    const succeededSnapshot = snapshots[1];
    if (!failedSnapshot || !succeededSnapshot) throw new Error("Expected campaign snapshots");
    await prisma.generationWorkItem.updateMany({
      data: {
        attemptCount: 2,
        errorCode: "PROVIDER_TIMEOUT",
        errorMessage: "internal provider detail must remain hidden",
        errorRetryable: true,
        status: "FAILED",
      },
      where: { audienceSnapshotId: failedSnapshot.id, campaignId, generationRunId: run.id },
    });
    await prisma.generationWorkItem.updateMany({
      data: { attemptCount: 1, status: "SUCCEEDED" },
      where: { audienceSnapshotId: succeededSnapshot.id, campaignId, generationRunId: run.id },
    });
    const failedItems = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${campaignId}/work-items?status=FAILED&errorCategory=TEMPORARY_SERVICE&employee=${encodeURIComponent("员工")}`,
      { token: tenantToken },
    );
    expect(failedItems.status).toBe(200);
    const failedRows = arrayField(failedItems.body, "items");
    expect(failedRows).toHaveLength(1);
    expect(asRecord(failedRows[0])).toMatchObject({
      attemptCount: 2,
      errorCategory: "TEMPORARY_SERVICE",
      status: "FAILED",
    });
    expect(JSON.stringify(failedItems.body)).not.toMatch(
      /PROVIDER_TIMEOUT|internal provider detail/iu,
    );
    const csvUrl = `${baseUrl}/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${campaignId}/work-items.csv?status=FAILED&errorCategory=TEMPORARY_SERVICE`;
    const [csvResponse, employeeCsvDenied] = await Promise.all([
      fetch(csvUrl, { headers: { authorization: `Bearer ${tenantToken}` } }),
      fetch(csvUrl, { headers: { authorization: `Bearer ${employeeTokens[0]}` } }),
    ]);
    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers.get("content-type")).toContain("text/csv");
    expect(csvResponse.headers.get("content-disposition")).toContain("attachment");
    const csv = await csvResponse.text();
    expect(csv).toContain("脱敏错误分类");
    expect(csv).toContain("未成功生成");
    expect(csv).toContain("临时服务异常");
    expect(csv).toContain(failedSnapshot.employeeName);
    expect(csv).not.toMatch(/FAILED|TEMPORARY_SERVICE|PROVIDER_TIMEOUT|internal provider detail/iu);
    expect(employeeCsvDenied.status).toBe(401);

    const archiveVisibleAt = new Date(Date.now() - 2 * 86_400_000);
    const archivedCandidate = await prisma.campaign.create({
      data: {
        audienceCount: 0,
        createdBy: stringField(asRecord(copyInput.body), "sourceCampaignId"),
        enterpriseId,
        expiresAt: new Date(archiveVisibleAt.getTime() + 86_400_000),
        imageCount: 1,
        prompt: "仅用于验证活动归档不会改变业务状态和财务事实。",
        cancelledAt: new Date(),
        status: "CANCELLED",
        tenantId,
        title: `${marker}-归档检索目标`,
        visibleAt: archiveVisibleAt,
      },
    });
    const searchPath = `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns?search=${encodeURIComponent(marker)}&status=CANCELLED`;
    const beforeArchive = await request(searchPath, { token: tenantToken });
    expect(arrayField(beforeArchive.body, "items")).toHaveLength(1);

    const archived = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${archivedCandidate.id}/archive`,
      {
        body: { reason: "历史活动已结束，移出日常运营列表" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(archived.status).toBe(201);
    expect(asRecord(archived.body)).toMatchObject({
      id: archivedCandidate.id,
      status: "CANCELLED",
    });
    expect(asRecord(archived.body).archivedAt).toEqual(expect.any(String));
    const hidden = await request(searchPath, { token: tenantToken });
    expect(arrayField(hidden.body, "items")).toHaveLength(0);
    const archivedOnly = await request(`${searchPath}&archive=ARCHIVED`, { token: tenantToken });
    expect(arrayField(archivedOnly.body, "items")).toHaveLength(1);

    const restored = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${archivedCandidate.id}/restore`,
      {
        body: { reason: "需要重新查看历史活动输入" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(restored.status).toBe(201);
    expect(asRecord(restored.body)).toMatchObject({ archivedAt: null, status: "CANCELLED" });
    await expect(
      prisma.auditLog.count({
        where: {
          action: { in: ["campaign.archive", "campaign.restore"] },
          resourceId: archivedCandidate.id,
        },
      }),
    ).resolves.toBe(2);
  });

  it("disposes review warnings, reschedules, reopens and cancels with idempotent cancellation", async () => {
    const warningRule = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/sensitive-rules`,
      {
        body: {
          riskType: "审核提示",
          severity: "WARNING",
          term: "快速见效",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(warningRule.status).toBe(201);
    const activeCampaign = await prisma.campaign.findUniqueOrThrow({
      select: { expiresAt: true },
      where: { id: campaignId },
    });
    const overlappingVisibleAt = new Date(Date.now() + 9 * 3_600_000);
    const initialVisibleAt = new Date(activeCampaign.expiresAt.getTime() + 3_600_000);
    const created = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns`,
      {
        body: {
          prompt: "生成设备科普内容，并提醒读者不要只关注快速见效。",
          title: "审核治理测试活动",
          visibleAt: initialVisibleAt.toISOString(),
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(created.status).toBe(201);
    const governanceCampaignId = stringField(created.body, "id");
    const employeeContents = arrayField(created.body, "employeeContents");
    expect(employeeContents).toHaveLength(3);
    const reviewCandidate = employeeContents[0];
    if (!reviewCandidate) throw new Error("Expected an employee content review candidate");
    await prisma.employeeContent.update({
      data: {
        riskAssessment: {
          notices: [],
          passed: false,
          replacedBlocks: [],
          warnings: ["审核提示：快速见效"],
        },
        status: "REVIEW_BLOCKED",
      },
      where: { id: stringField(reviewCandidate, "id") },
    });
    const blockedContents = [reviewCandidate];

    const blockedApproval = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${governanceCampaignId}/approve`,
      {
        body: { visibleAt: initialVisibleAt.toISOString() },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(blockedApproval.status).toBe(409);
    for (const content of blockedContents) {
      const accepted = await request(
        `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${governanceCampaignId}/contents/${stringField(content, "id")}/accept-review`,
        {
          body: { reason: "已人工确认属于风险提示，不构成绝对效果承诺" },
          method: "POST",
          token: tenantToken,
        },
      );
      expect(accepted.status).toBe(201);
    }
    const overlappingApproval = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${governanceCampaignId}/approve`,
      {
        body: { visibleAt: overlappingVisibleAt.toISOString() },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(overlappingApproval.status).toBe(201);
    const approved = overlappingApproval;
    expect(approved.status).toBe(201);
    expect(stringField(approved.body, "status")).toBe("APPROVED");

    const overlappingReschedule = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${governanceCampaignId}/reschedule`,
      {
        body: {
          reason: "允许多个活动在相同窗口内开放",
          visibleAt: overlappingVisibleAt.toISOString(),
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(overlappingReschedule.status).toBe(201);

    const rescheduledAt = new Date(initialVisibleAt.getTime() + 2 * 3_600_000);
    const rescheduled = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${governanceCampaignId}/reschedule`,
      {
        body: {
          reason: "调整到员工下班后的分散发布时间",
          visibleAt: rescheduledAt.toISOString(),
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(rescheduled.status).toBe(201);
    expect(new Date(stringField(rescheduled.body, "visibleAt")).getTime()).toBe(
      rescheduledAt.getTime(),
    );
    expect(
      arrayField(rescheduled.body, "distributionTasks").every(
        (task) =>
          new Date(stringField(task, "visibleAt")).getTime() === rescheduledAt.getTime() &&
          stringField(task, "status") === "LOCKED",
      ),
    ).toBe(true);

    const reopened = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${governanceCampaignId}/reopen-review`,
      {
        body: { reason: "需要进行第二轮运营审核" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(reopened.status).toBe(201);
    expect(asRecord(reopened.body)).toMatchObject({ approvedAt: null, status: "REVIEW_PENDING" });
    expect(
      arrayField(reopened.body, "employeeContents").every(
        (content) => stringField(content, "status") === "GENERATED",
      ),
    ).toBe(true);

    const reapproved = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${governanceCampaignId}/approve`,
      {
        body: { visibleAt: rescheduledAt.toISOString() },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(reapproved.status).toBe(201);
    const cancellationKey = randomUUID();
    const cancelled = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${governanceCampaignId}/cancel`,
      {
        body: { reason: "本期活动口径调整，停止解锁" },
        idempotencyKey: cancellationKey,
        method: "POST",
        token: tenantToken,
      },
    );
    expect(cancelled.status).toBe(201);
    expect(asRecord(cancelled.body)).toMatchObject({
      cancellationReason: "本期活动口径调整，停止解锁",
      status: "CANCELLED",
    });
    expect(asRecord(asRecord(cancelled.body).cancellationSummary)).toMatchObject({
      cancelledDistributionTasks: 3,
    });
    expect(
      arrayField(cancelled.body, "distributionTasks").every(
        (task) => stringField(task, "status") === "CANCELLED",
      ),
    ).toBe(true);
    const cancellationReplay = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${governanceCampaignId}/cancel`,
      {
        body: { reason: "本期活动口径调整，停止解锁" },
        idempotencyKey: cancellationKey,
        method: "POST",
        token: tenantToken,
      },
    );
    expect(cancellationReplay.status).toBe(201);
    expect(cancellationReplay.headers.get("idempotency-replayed")).toBe("true");

    const [membership] = await Promise.all([
      prisma.enterpriseMembership.findFirstOrThrow({ where: { enterpriseId, tenantId } }),
    ]);
    const queuedCampaign = await prisma.campaign.create({
      data: {
        audienceCount: 1,
        createdBy: "campaign-governance-test",
        enterpriseId,
        expiresAt: new Date(Date.now() + 30 * 3_600_000),
        imageCount: 1,
        prompt: "并发取消测试",
        status: "GENERATING",
        tenantId,
        title: "并发取消测试活动",
        visibleAt: new Date(Date.now() + 6 * 3_600_000),
      },
    });
    const queuedRun = await prisma.generationRun.create({
      data: {
        campaignId: queuedCampaign.id,
        imageModel: "synthetic-image",
        provider: "synthetic",
        requestedCount: 1,
        status: "QUEUED",
        synthetic: true,
        tenantId,
        textModel: "synthetic-text",
      },
    });
    const queuedSnapshot = await prisma.campaignAudienceSnapshot.create({
      data: {
        campaignId: queuedCampaign.id,
        employeeName: membership.name,
        employeePhone: membership.phone,
        enterpriseId,
        membershipId: membership.id,
        tenantId,
      },
    });
    const queuedItem = await prisma.generationWorkItem.create({
      data: {
        attemptCount: 1,
        audienceSnapshotId: queuedSnapshot.id,
        campaignId: queuedCampaign.id,
        enterpriseId,
        executionVersion: 1,
        generationRunId: queuedRun.id,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        leaseOwner: "worker-before-cancel",
        leaseToken: randomUUID(),
        membershipId: membership.id,
        startedAt: new Date(),
        status: "RUNNING",
        tenantId,
      },
    });
    const [firstCancel, secondCancel] = await Promise.all([
      request(
        `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${queuedCampaign.id}/cancel`,
        {
          body: { reason: "并发取消验证" },
          method: "POST",
          token: tenantToken,
        },
      ),
      request(
        `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${queuedCampaign.id}/cancel`,
        {
          body: { reason: "并发取消验证" },
          method: "POST",
          token: tenantToken,
        },
      ),
    ]);
    expect([firstCancel.status, secondCancel.status]).toEqual([201, 201]);
    const [cancelledItem, cancelledRun] = await Promise.all([
      prisma.generationWorkItem.findUniqueOrThrow({ where: { id: queuedItem.id } }),
      prisma.generationRun.findUniqueOrThrow({ where: { id: queuedRun.id } }),
    ]);
    expect(cancelledItem).toMatchObject({
      leaseOwner: null,
      leaseToken: null,
      status: "CANCELLED",
    });
    expect(cancelledRun.status).toBe("CANCELLED");
  });

  it("allows concurrent overlapping campaign approvals within the same enterprise", async () => {
    const isolatedEnterprise = await prisma.enterprise.create({
      data: {
        code: `WINDOW_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
        name: "重叠活动窗口并发测试企业",
        tenantId,
      },
    });
    const visibleAt = new Date(Date.now() + 48 * 3_600_000);
    const expiresAt = new Date(visibleAt.getTime() + 24 * 3_600_000);
    const candidates = await Promise.all(
      ["并发活动 A", "并发活动 B"].map((title) =>
        prisma.campaign.create({
          data: {
            approvedAt: new Date(),
            approvedBy: "database-window-test",
            createdBy: "database-window-test",
            enterpriseId: isolatedEnterprise.id,
            expiresAt,
            prompt: title,
            status: "DRAFT",
            tenantId,
            title,
            visibleAt,
          },
        }),
      ),
    );

    const approvals = await Promise.allSettled(
      candidates.map((candidate) =>
        prisma.campaign.update({
          data: { status: "APPROVED" },
          where: { id: candidate.id },
        }),
      ),
    );
    expect(approvals.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
    expect(approvals.filter(({ status }) => status === "rejected")).toHaveLength(0);
    expect(
      await prisma.campaign.count({
        where: { enterpriseId: isolatedEnterprise.id, status: "APPROVED" },
      }),
    ).toBe(2);
  });

  async function request(
    path: string,
    options: Readonly<{
      token?: string;
      method?: "GET" | "POST";
      body?: unknown;
      headers?: Readonly<Record<string, string>>;
      idempotencyKey?: string | null;
    }> = {},
  ): Promise<ApiResponse> {
    const headers = new Headers(options.headers);
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

  async function completePendingMaterialIngestion(
    materialId: string,
    extractedContent?: string,
  ): Promise<void> {
    const material = await prisma.material.findFirstOrThrow({
      where: { id: materialId, tenantId },
    });
    const job = await prisma.materialIngestionJob.findFirstOrThrow({
      orderBy: { queueVersion: "desc" },
      where: { materialId, purpose: "INGEST", status: "PENDING", tenantId },
    });
    const content = extractedContent ?? material.content;
    const checksum = createHash("sha256").update(content).digest("hex");
    const vector = deterministicEmbedding(content);
    await prisma.$transaction(async (transaction) => {
      const chunk = await transaction.materialChunk.create({
        data: {
          characterCount: content.length,
          enterpriseId: material.enterpriseId,
          materialId: material.id,
          ordinal: 0,
          scopeKey: material.scopeKey,
          structuredFacts: material.structuredFacts ?? undefined,
          tenantId: material.tenantId,
          text: content,
          textChecksum: checksum,
          tokenCount: Math.ceil(content.length / 2),
        },
      });
      await transaction.materialEmbedding.create({
        data: {
          chunkId: chunk.id,
          dimension: vector.length,
          enterpriseId: material.enterpriseId,
          materialId: material.id,
          profileVersion: "deterministic-char-ngram-v1",
          scopeKey: material.scopeKey,
          tenantId: material.tenantId,
          vector,
        },
      });
      if (material.supersedesId) {
        await transaction.material.updateMany({
          data: { status: "DISABLED" },
          where: {
            scopeKey: material.scopeKey,
            seriesId: material.seriesId,
            tenantId: material.tenantId,
            version: { lt: material.version },
          },
        });
      }
      await transaction.material.update({
        data: {
          content,
          contentChecksum: checksum,
          ingestionStatus: "READY",
          usabilityStatus: "USABLE",
          parserVersion: job.parserVersion,
          readyAt: new Date(),
        },
        where: { id: material.id },
      });
      await transaction.materialIngestionJob.update({
        data: { finishedAt: new Date(), status: "READY" },
        where: { id: job.id },
      });
      await transaction.materialArtifact.updateMany({
        data: { status: "VERIFIED", verifiedAt: new Date() },
        where: { materialId: material.id, tenantId: material.tenantId },
      });
    });
  }

  async function uploadMaterialArtifact(
    intentBody: unknown,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<void> {
    const uploaded = await fetch(stringField(intentBody, "uploadUrl"), {
      body: bytes.buffer as ArrayBuffer,
      headers: { "content-type": mimeType },
      method: "PUT",
    });
    expect(uploaded.status).toBe(200);
  }
});

function campaignTask(value: unknown, campaignId: string): unknown {
  const task = (Array.isArray(value) ? value : []).find(
    (item) => stringField(objectField(item, "campaign"), "id") === campaignId,
  );
  if (!task) throw new Error(`Expected employee task for campaign ${campaignId}`);
  return task;
}

function arrayField(value: unknown, field: string): unknown[] {
  const fieldValue = asRecord(value)[field];
  if (!Array.isArray(fieldValue)) throw new Error(`Expected array field: ${field}`);
  return fieldValue;
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  return asRecord(asRecord(value)[field]);
}

function stringField(value: unknown, field: string): string {
  const fieldValue = asRecord(value)[field];
  if (typeof fieldValue !== "string") throw new Error(`Expected string field: ${field}`);
  return fieldValue;
}

function numberField(value: unknown, field: string): number {
  const fieldValue = asRecord(value)[field];
  if (typeof fieldValue !== "number") throw new Error(`Expected number field: ${field}`);
  return fieldValue;
}

function booleanField(value: unknown, field: string): boolean {
  const fieldValue = asRecord(value)[field];
  if (typeof fieldValue !== "boolean") throw new Error(`Expected boolean field: ${field}`);
  return fieldValue;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Expected an object response");
  return value as Record<string, unknown>;
}

function metricSignature(
  key: string,
  timestamp: string,
  input: IngestPublicationMetricsDto,
): string {
  return createHmac("sha256", key)
    .update(`${timestamp}\n${canonicalMetricPayload(input)}`)
    .digest("hex");
}

function expectCustomerCampaignResponseSanitized(value: unknown): void {
  const forbidden = new Set([
    "adapter",
    "estimatedCost",
    "externalModelId",
    "generationInput",
    "generationPolicy",
    "idempotencyKey",
    "imageModel",
    "imageModelId",
    "imageProvider",
    "invocations",
    "model",
    "modelRouteId",
    "provider",
    "providerRequestId",
    "routingPolicy",
    "storageEtag",
    "storageKey",
    "synthetic",
    "textModel",
    "textModelId",
    "textProvider",
  ]);
  const exposed = objectKeysDeep(value).filter((key) => forbidden.has(key));
  expect(exposed).toEqual([]);
}

function objectKeysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeysDeep);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...objectKeysDeep(child)]);
}

function assertDevelopmentDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname.replace(/^\//, "") !== "dev_xhs_agentic") {
    throw new Error("MVP lifecycle test requires dev_xhs_agentic");
  }
}

function testPhone(marker: string, suffix: number): string {
  const digits = marker.replace(/\D/g, "").slice(-7).padStart(7, "0");
  return `137${digits}${suffix}`;
}
