import "reflect-metadata";

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { PlatformSetting, Prisma, Role } from "@xhs-agentic/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { enterpriseAccessScope, platformAccessScope } from "../access/access-scope";
import { AuthTokenService } from "../access/auth-token.service";
import { AuthorizationRepository } from "../access/authorization.repository";
import { seedAuthorizationCatalog } from "../access/authorization.seed";
import { AppModule } from "../app.module";
import { configureApplication } from "../configure-application";
import { PrismaService } from "../database/prisma.service";
import { RateLimitGuard } from "../http/rate-limit.guard";
import { seedRuntimePolicy } from "../model-configuration/runtime-policy.seed";
import { seedPlatformSettings } from "../platform-settings/platform-settings.seed";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

const publicationSettingKeys = [
  "publication.api_key",
  "publication.endpoint",
  "publication.mode",
  "publication.provider",
] as const;

type ApiResponse = Readonly<{ body: unknown; status: number }>;
type TaskFixture = Readonly<{
  body: string;
  checksum: string;
  hashtags: readonly string[];
  taskId: string;
  title: string;
  token: string;
}>;

describe("HTTP publication verification lifecycle", { concurrent: false }, () => {
  const marker = `publication-http-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const providerKey = `publication-provider-${randomUUID()}`;
  const userIds: string[] = [];
  const adminUserIds: string[] = [];
  const employeeUserIds: string[] = [];
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let platformToken: string;
  let enterpriseToken: string;
  let tenantId: string;
  let enterpriseId: string;
  let lateCampaignId: string;
  let tasks: TaskFixture[] = [];
  let lateTask: TaskFixture;
  let provider: Awaited<ReturnType<typeof startPublicationProvider>>;
  let originalSettings: PlatformSetting[] = [];
  let firstUnavailableSubmissionId: string;

  beforeAll(async () => {
    assertDevelopmentDatabase();
    // The provider contract and publication lifecycle do not depend on the
    // developer's Redis credentials; keep this suite isolated like browser tests.
    vi.spyOn(RateLimitGuard.prototype, "canActivate").mockResolvedValue(true);
    app = await NestFactory.create(AppModule, {
      abortOnError: false,
      bodyParser: false,
      logger: false,
    });
    configureApplication(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
    prisma = app.get(PrismaService);
    await seedAuthorizationCatalog(prisma);
    await seedRuntimePolicy(prisma);
    await seedPlatformSettings(prisma);
    originalSettings = await prisma.platformSetting.findMany({
      where: { key: { in: [...publicationSettingKeys] } },
    });

    const authorization = app.get(AuthorizationRepository);
    const tokens = app.get(AuthTokenService);
    const [platformRole, enterpriseRole] = await Promise.all([
      requireRole(prisma, "PLATFORM_ADMIN"),
      requireRole(prisma, "ENTERPRISE_ADMIN"),
    ]);
    const [platformAdmin, enterpriseAdmin] = await Promise.all([
      prisma.adminUser.create({
        data: { phone: testPhone(marker, 0), phoneVerifiedAt: new Date() },
      }),
      prisma.adminUser.create({
        data: { phone: testPhone(marker, 1), phoneVerifiedAt: new Date() },
      }),
    ]);
    userIds.push(platformAdmin.id, enterpriseAdmin.id);
    adminUserIds.push(platformAdmin.id, enterpriseAdmin.id);
    const tenant = await prisma.tenant.create({
      data: { customerType: "GROUP", name: `${marker}-tenant` },
    });
    tenantId = tenant.id;
    const enterprise = await prisma.enterprise.create({
      data: {
        code: `PUB_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
        name: `${marker}-enterprise`,
        tenantId,
      },
    });
    enterpriseId = enterprise.id;
    await Promise.all([
      authorization.createRoleBinding(platformAccessScope(), {
        roleId: platformRole.id,
        targetScope: platformAccessScope(),
        userId: platformAdmin.id,
      }),
      authorization.createRoleBinding(platformAccessScope(), {
        roleId: enterpriseRole.id,
        targetScope: enterpriseAccessScope(tenantId, enterpriseId),
        userId: enterpriseAdmin.id,
      }),
    ]);
    platformToken = tokens.issueAdminAccessToken(platformAdmin.id);
    enterpriseToken = tokens.issueAdminAccessToken(enterpriseAdmin.id);

    const visibleAt = new Date(Date.now() - 3_600_000);
    const expiresAt = new Date(visibleAt.getTime() + 24 * 3_600_000);
    const mainCampaign = await prisma.campaign.create({
      data: {
        approvedAt: new Date(),
        approvedBy: enterpriseAdmin.id,
        audienceCount: 7,
        createdBy: enterpriseAdmin.id,
        expiresAt,
        generatedCount: 7,
        imageCount: 1,
        prompt: "验证正式 HTTP 小红书公开内容回填",
        status: "ACTIVE",
        tenantId,
        enterpriseId,
        title: "HTTP 发布验真活动",
        visibleAt,
      },
    });
    tasks = await Promise.all(
      [
        { label: "valid", textKey: "valid" },
        { label: "gray", textKey: "gray" },
        { label: "retry", textKey: "retry" },
        { label: "invalid", textKey: "invalid" },
        { label: "fact", textKey: "fact" },
        { label: "race-a", textKey: "race" },
        { label: "race-b", textKey: "race" },
      ].map((spec, index) =>
        createTaskFixture({
          campaignId: mainCampaign.id,
          expiresAt,
          index: index + 2,
          label: spec.label,
          status: "AVAILABLE",
          textKey: spec.textKey,
          visibleAt,
        }),
      ),
    );

    const lateVisibleAt = new Date(Date.now() - 25 * 3_600_000);
    const lateExpiresAt = new Date(lateVisibleAt.getTime() + 24 * 3_600_000);
    const lateCampaign = await prisma.campaign.create({
      data: {
        approvedAt: new Date(lateVisibleAt.getTime() - 1_000),
        approvedBy: enterpriseAdmin.id,
        audienceCount: 1,
        createdBy: enterpriseAdmin.id,
        expiresAt: lateExpiresAt,
        generatedCount: 1,
        imageCount: 1,
        prompt: "验证逾期纠错",
        status: "EXPIRED",
        tenantId,
        enterpriseId,
        title: "逾期纠错活动",
        visibleAt: lateVisibleAt,
      },
    });
    lateCampaignId = lateCampaign.id;
    lateTask = await createTaskFixture({
      campaignId: lateCampaign.id,
      expiresAt: lateExpiresAt,
      index: 9,
      label: "late",
      status: "EXPIRED",
      textKey: "late",
      visibleAt: lateVisibleAt,
    });

    provider = await startPublicationProvider({ lateTask, tasks });
    for (const [key, value] of [
      ["publication.api_key", providerKey],
      ["publication.endpoint", provider.endpoint],
      ["publication.provider", "LOCAL_HTTP_PUBLICATION"],
      ["publication.mode", "HTTP"],
    ] as const) {
      const updated = await request(`/platform/settings/${key}`, {
        body: { reason: "配置 HTTP 发布验真集成测试", value },
        method: "POST",
        token: platformToken,
      });
      expect(updated.status).toBe(200);
      expect(JSON.stringify(updated.body)).not.toContain(providerKey);
    }

    async function createTaskFixture(input: {
      campaignId: string;
      expiresAt: Date;
      index: number;
      label: string;
      status: "AVAILABLE" | "EXPIRED";
      textKey: string;
      visibleAt: Date;
    }): Promise<TaskFixture> {
      const user = await prisma.globalUser.create({
        data: { phone: testPhone(marker, input.index), phoneVerifiedAt: new Date() },
      });
      userIds.push(user.id);
      employeeUserIds.push(user.id);
      if (!user.phone) throw new Error("Expected a phone in the employee test fixture");
      const membership = await prisma.enterpriseMembership.create({
        data: {
          boundAt: new Date(),
          enterpriseId,
          globalUserId: user.id,
          name: `员工-${input.label}`,
          phone: user.phone,
          seatEnabledAt: new Date(),
          seatStatus: "ENABLED",
          status: "ACTIVE",
          tenantId,
        },
      });
      const snapshot = await prisma.campaignAudienceSnapshot.create({
        data: {
          campaignId: input.campaignId,
          employeeName: membership.name,
          employeePhone: membership.phone,
          enterpriseId,
          membershipId: membership.id,
          tenantId,
        },
      });
      const title = `验真标题-${input.textKey}`;
      const body =
        input.textKey === "fact"
          ? "这是用于验证公开内容事实一致性的专属文案，要求在24小时内完成发布"
          : `这是用于验证公开内容正文、图片指纹和全局链接去重的专属文案-${input.textKey}`;
      const hashtags = ["公开验真", input.textKey];
      const contentFingerprint = createHash("sha256")
        .update(`${title}\n${body}\n${hashtags.join(" ")}`)
        .digest("hex");
      const content = await prisma.employeeContent.create({
        data: {
          audienceSnapshotId: snapshot.id,
          body,
          campaignId: input.campaignId,
          contentFingerprint,
          enterpriseId,
          hashtags,
          imagePrompt: `独立图片-${input.label}`,
          membershipId: membership.id,
          riskAssessment: { passed: true, status: "APPROVED" },
          status: "APPROVED",
          synthetic: false,
          tenantId,
          title,
        },
      });
      const checksum = createHash("sha256").update(`image-${input.label}`).digest("hex");
      await prisma.generatedImage.create({
        data: {
          campaignId: input.campaignId,
          checksum,
          employeeContentId: content.id,
          height: 1200,
          imageUrl: `https://assets.example.test/${input.label}.jpg`,
          mimeType: "image/jpeg",
          model: "test-image-v1",
          perceptualHash: checksum.slice(0, 16),
          prompt: `独立图片-${input.label}`,
          provider: "TEST",
          sequence: 1,
          synthetic: false,
          tenantId,
          width: 900,
        },
      });
      const task = await prisma.distributionTask.create({
        data: {
          campaignId: input.campaignId,
          employeeContentId: content.id,
          enterpriseId,
          expiredAt: input.status === "EXPIRED" ? input.expiresAt : null,
          expiresAt: input.expiresAt,
          factsConfirmedAt: input.visibleAt,
          factsConfirmedRevision: content.revision,
          membershipId: membership.id,
          status: input.status,
          tenantId,
          visibleAt: input.visibleAt,
        },
      });
      return {
        body,
        checksum,
        hashtags,
        taskId: task.id,
        title,
        token: tokens.issueEmployeeAccessToken(user.id),
      };
    }
  });

  afterAll(async () => {
    await provider?.close();
    if (!prisma) return;
    await prisma.publishMetricSnapshot.deleteMany({ where: { tenantId } });
    await prisma.publishedContentRegistry.deleteMany({ where: { tenantId } });
    await prisma.publishSubmission.deleteMany({ where: { tenantId } });
    await prisma.publicContentFixture.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ tenantId }, { actorUserId: { in: userIds } }] },
    });
    await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.generatedImage.deleteMany({ where: { tenantId } });
    await prisma.distributionTask.deleteMany({ where: { tenantId } });
    await prisma.employeeContentRevision.deleteMany({ where: { tenantId } });
    await prisma.employeeContent.deleteMany({ where: { tenantId } });
    await prisma.campaignAudienceSnapshot.deleteMany({ where: { tenantId } });
    await prisma.campaignEffectObservation.deleteMany({ where: { tenantId } });
    await prisma.campaign.deleteMany({ where: { tenantId } });
    await prisma.roleBinding.deleteMany({
      where: { OR: [{ tenantId }, { userId: { in: adminUserIds } }] },
    });
    await prisma.enterpriseMembership.deleteMany({ where: { tenantId } });
    await prisma.enterprise.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.adminUser.deleteMany({ where: { id: { in: adminUserIds } } });
    await prisma.globalUser.deleteMany({ where: { id: { in: employeeUserIds } } });
    await restoreSettings(prisma, originalSettings);
    await app.close();
    vi.restoreAllMocks();
  });

  it("resolves a short link, freezes the final canonical URL and verifies text plus checksum", async () => {
    const task = requiredAt(tasks, 0);
    const response = await request(`/employee/tasks/${task.taskId}/submissions`, {
      body: { url: "分享口令 https://xhslink.com/short-valid?utm_source=employee" },
      method: "POST",
      token: task.token,
    });
    expect(response.status).toBe(201);
    expect(asRecord(response.body)).toMatchObject({
      canonicalKey: "xhs:note:httpvalid0001",
      status: "VALID",
    });
    const [submission, distributionTask] = await Promise.all([
      prisma.publishSubmission.findUniqueOrThrow({
        where: { id: stringField(response.body, "submissionId") },
      }),
      prisma.distributionTask.findUniqueOrThrow({ where: { id: task.taskId } }),
    ]);
    expect(submission.extractedUrl).toContain("xhslink.com/short-valid");
    expect(submission.resolvedUrl).toBe("https://www.xiaohongshu.com/explore/httpvalid0001");
    expect(submission.textSimilarityScore).toBe(1);
    expect(submission.imageSimilarityScore).toBe(1);
    expect(submission.verificationPolicyVersion).toBe("xhs-public-v1");
    expect(distributionTask.status).toBe("COMPLETED");
  });

  it("routes missing image evidence to a customer-safe manual review and allows approval", async () => {
    const task = requiredAt(tasks, 1);
    const submitted = await request(`/employee/tasks/${task.taskId}/submissions`, {
      body: { url: "https://www.xiaohongshu.com/explore/httpgray0001" },
      method: "POST",
      token: task.token,
    });
    expect(submitted.status).toBe(201);
    expect(stringField(submitted.body, "status")).toBe("MANUAL_REVIEW");
    const submissionId = stringField(submitted.body, "submissionId");
    const reviews = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/publication-reviews`,
      { token: enterpriseToken },
    );
    expect(reviews.status).toBe(200);
    const review = arrayField(reviews.body, "items").find(
      (item) => stringField(item, "id") === submissionId,
    );
    expect(review).toBeTruthy();
    expectCustomerPublicationReviewSanitized(review);
    expect(JSON.stringify(review)).not.toContain(providerKey);
    const approved = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/publication-reviews/${submissionId}`,
      {
        body: { decision: "VERIFIED", reason: "运营人员已核对公开图片与本次专属内容一致" },
        method: "POST",
        token: enterpriseToken,
      },
    );
    expect(approved.status).toBe(201);
    expect(stringField(approved.body, "status")).toBe("VALID");
    await expect(
      prisma.distributionTask.findUniqueOrThrow({ where: { id: task.taskId } }),
    ).resolves.toMatchObject({ status: "COMPLETED" });
  });

  it("keeps provider failure non-punitive and retries as a new versioned verification attempt", async () => {
    const task = requiredAt(tasks, 2);
    const unavailable = await request(`/employee/tasks/${task.taskId}/submissions`, {
      body: { url: "https://www.xiaohongshu.com/explore/httpretry0001" },
      method: "POST",
      token: task.token,
    });
    expect(unavailable.status).toBe(201);
    expect(stringField(unavailable.body, "status")).toBe("UNAVAILABLE");
    firstUnavailableSubmissionId = stringField(unavailable.body, "submissionId");
    await expect(
      prisma.distributionTask.findUniqueOrThrow({ where: { id: task.taskId } }),
    ).resolves.toMatchObject({ status: "VERIFYING" });
    const retried = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/publication-reviews/${firstUnavailableSubmissionId}/retry`,
      {
        body: { reason: "验真供应商恢复后重新获取公开内容" },
        method: "POST",
        token: enterpriseToken,
      },
    );
    expect(retried.status).toBe(201);
    expect(stringField(retried.body, "status")).toBe("VALID");
    const attempts = await prisma.publishSubmission.findMany({
      orderBy: { verificationAttempt: "asc" },
      where: { taskId: task.taskId },
    });
    expect(
      attempts.map(({ status, verificationAttempt }) => [status, verificationAttempt]),
    ).toEqual([
      ["SUPERSEDED", 1],
      ["VALID", 2],
    ]);
  });

  it("returns a mismatched post to AVAILABLE without treating the employee as completed", async () => {
    const task = requiredAt(tasks, 3);
    const response = await request(`/employee/tasks/${task.taskId}/submissions`, {
      body: { url: "https://www.xiaohongshu.com/explore/httpinvalid01" },
      method: "POST",
      token: task.token,
    });
    expect(response.status).toBe(201);
    expect(stringField(response.body, "status")).toBe("INVALID");
    await expect(
      prisma.distributionTask.findUniqueOrThrow({ where: { id: task.taskId } }),
    ).resolves.toMatchObject({ status: "AVAILABLE", verifiedAt: null });
  });

  it("rejects a numerically altered fact even when the remaining text and image match", async () => {
    const task = requiredAt(tasks, 4);
    const response = await request(`/employee/tasks/${task.taskId}/submissions`, {
      body: { url: "https://www.xiaohongshu.com/explore/httpfact0001" },
      method: "POST",
      token: task.token,
    });
    expect(response.status).toBe(201);
    expect(stringField(response.body, "status")).toBe("INVALID");
    const submission = await prisma.publishSubmission.findUniqueOrThrow({
      where: { id: stringField(response.body, "submissionId") },
    });
    expect(submission.textSimilarityScore).toBeGreaterThan(0.9);
    expect(submission.imageSimilarityScore).toBe(1);
    expect(submission.factMatchScore).toBe(0);
    expect(submission.failureReason).toContain("数字事实");
  });

  it("atomically allows only one valid owner when two employees submit the same final post", async () => {
    const left = requiredAt(tasks, 5);
    const right = requiredAt(tasks, 6);
    const [leftResult, rightResult] = await Promise.all([
      request(`/employee/tasks/${left.taskId}/submissions`, {
        body: { url: "https://xhslink.com/race-shared" },
        method: "POST",
        token: left.token,
      }),
      request(`/employee/tasks/${right.taskId}/submissions`, {
        body: { url: "https://xhslink.com/race-shared" },
        method: "POST",
        token: right.token,
      }),
    ]);
    expect([leftResult.status, rightResult.status]).toEqual([201, 201]);
    expect(
      [stringField(leftResult.body, "status"), stringField(rightResult.body, "status")].sort(),
    ).toEqual(["DUPLICATE", "VALID"]);
    await expect(
      prisma.publishedContentRegistry.count({ where: { canonicalKey: "xhs:note:httprace0001" } }),
    ).resolves.toBe(1);
    const taskRows = await prisma.distributionTask.findMany({
      select: { status: true },
      where: { id: { in: [left.taskId, right.taskId] } },
    });
    expect(taskRows.map(({ status }) => status).sort()).toEqual(["AVAILABLE", "COMPLETED"]);
  });

  it("uses the same verification chain for late correction without rewriting on-time completion", async () => {
    const response = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/tasks/${lateTask.taskId}/late-correction`,
      {
        body: {
          reason: "员工已逾期，但企业确认需要保留真实发布结果供后续决策",
          url: "https://www.xiaohongshu.com/explore/httplate0001",
        },
        method: "POST",
        token: enterpriseToken,
      },
    );
    expect(response.status).toBe(201);
    expect(stringField(response.body, "status")).toBe("VALID");
    await expect(
      prisma.distributionTask.findUniqueOrThrow({ where: { id: lateTask.taskId } }),
    ).resolves.toMatchObject({ status: "LATE_CORRECTED" });
    await expect(
      prisma.campaign.findUniqueOrThrow({ where: { id: lateCampaignId } }),
    ).resolves.toMatchObject({ status: "EXPIRED" });
    const dashboard = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/dashboard`,
      { token: enterpriseToken },
    );
    expect(dashboard.status).toBe(200);
    const summary = objectField(dashboard.body, "summary");
    expect(numberField(summary, "taskCount")).toBe(8);
    expect(numberField(summary, "verifiedCount")).toBe(4);
    expect(numberField(summary, "lateCorrectedCount")).toBe(1);
    expect(numberField(summary, "completionRate")).toBeCloseTo(4 / 8, 8);
    expect(
      arrayField(dashboard.body, "incompleteEmployees").some(
        (item) => stringField(item, "taskId") === lateTask.taskId,
      ),
    ).toBe(false);
  });

  it("sends bearer and idempotency headers while keeping the provider key out of responses and audit", async () => {
    expect(provider.requests.length).toBeGreaterThanOrEqual(9);
    expect(
      provider.requests.every(({ authorization }) => authorization === `Bearer ${providerKey}`),
    ).toBe(true);
    expect(provider.requests.every(({ idempotencyKey }) => Boolean(idempotencyKey))).toBe(true);
    const audits = await prisma.auditLog.findMany({
      where: {
        action: { startsWith: "publication." },
        tenantId,
      },
    });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(providerKey);
    const reviewList = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/publication-reviews`,
      { token: enterpriseToken },
    );
    expect(JSON.stringify(reviewList.body)).not.toContain(providerKey);
    expectCustomerPublicationReviewSanitized(reviewList.body);
  });

  it("requires current employee facts, blocks contradictory author evidence and records actual transaction snapshots", async () => {
    const fixture = requiredAt(tasks, 3);
    const task = await prisma.distributionTask.findUniqueOrThrow({ where: { id: fixture.taskId } });
    const publisher = {
      schemaVersion: "medical-publisher-v1",
      category: "ORDINARY",
      authorId: "author_123",
      verifiedAt: "2026-01-01T00:00:00.000Z",
      validUntil: "2099-01-01T00:00:00.000Z",
      verifiedBy: "test-operator",
      evidence: "企业核对员工公开发布者身份",
      allowBrandAttribution: false,
      allowPlatformConsultation: false,
    };
    await prisma.enterpriseMembership.update({
      where: { id: task.membershipId },
      data: { publisherContext: publisher },
    });
    await prisma.campaign.update({
      where: { id: task.campaignId },
      data: {
        selectionSnapshot: {
          schemaVersion: "medical-selection-v1",
          executionVersion: "medical-plan-v1",
          objective: "GEO_AND_TRANSACTION",
          priority: "BALANCED",
          readerSituation: "FIRST_UNDERSTANDING",
          noteForm: "QUESTION_LIST",
          imageMode: "QUESTION_CARD",
          conversionPath: "NONE",
          topicIds: ["topic"],
          topics: [
            {
              id: "topic",
              seriesId: "series",
              version: 1,
              question: "首次准备哪些问题？",
              intent: "了解",
              entityId: "entity",
              entityName: "真实主体",
            },
          ],
          publishers: [{ membershipId: task.membershipId, publisherContext: publisher }],
          frozenAt: new Date().toISOString(),
        },
      },
    });
    await prisma.distributionTask.update({
      where: { id: task.id },
      data: { factsConfirmedAt: null, factsConfirmedRevision: null },
    });
    const employeePost = (suffix: string, body: unknown) =>
      request(`/employee/tasks/${task.id}/${suffix}`, {
        body,
        method: "POST",
        token: fixture.token,
      });
    const submissionsBefore = provider.requests.length;
    expect((await employeePost("events", { type: "COPY", revision: 1 })).status).toBe(409);
    expect(
      (
        await employeePost("submissions", {
          url: "https://www.xiaohongshu.com/explore/httpmedicalwrong",
        })
      ).status,
    ).toBe(409);
    expect(provider.requests).toHaveLength(submissionsBefore);
    expect(
      (await employeePost("facts", { revision: 1, confirmed: false, reason: "FACTS_MISMATCH" }))
        .status,
    ).toBe(201);
    expect((await employeePost("facts", { revision: 1, confirmed: true })).status).toBe(409);
    await prisma.employeeContent.update({
      where: { id: task.employeeContentId },
      data: { revision: 2 },
    });
    const confirmation = await employeePost("facts", { revision: 2, confirmed: true });
    expect(confirmation.status).toBe(201);
    expect(confirmation.body).toMatchObject({ contentRevision: 2, factsConfirmed: true });
    expect((await employeePost("events", { type: "COPY", revision: 1 })).status).toBe(409);
    expect((await employeePost("events", { type: "COPY", revision: 2 })).status).toBe(201);
    const wrongAuthor = await employeePost("submissions", {
      url: "https://www.xiaohongshu.com/explore/httpmedicalwrong",
    });
    expect(wrongAuthor.status).toBe(201);
    expect(wrongAuthor.body).toMatchObject({ status: "MANUAL_REVIEW" });
    const reviewPath = `/console/tenants/${tenantId}/enterprises/${enterpriseId}/publication-reviews/${stringField(wrongAuthor.body, "submissionId")}`;
    const contradiction = await request(reviewPath, {
      method: "POST",
      token: enterpriseToken,
      body: {
        decision: "VERIFIED",
        reason: "企业复核",
        authorId: "author_123",
        authorEvidence: "企业核对公开发布页面",
      },
    });
    expect(contradiction.status).toBe(409);
    expect(
      (
        await request(reviewPath, {
          method: "POST",
          token: enterpriseToken,
          body: { decision: "REJECTED", reason: "实际作者与分配安排不同" },
        })
      ).status,
    ).toBe(201);
    const correctAuthor = await employeePost("submissions", {
      url: "https://www.xiaohongshu.com/explore/httpmedicalcorrect",
    });
    expect(correctAuthor.status).toBe(201);
    expect(correctAuthor.body).toMatchObject({ status: "VALID" });
    const audited = await prisma.auditLog.findFirst({
      where: {
        tenantId,
        action: "publication.verify.valid",
        metadata: { path: ["accountOwnershipChecked"], equals: true },
      },
    });
    expect(audited?.metadata).toMatchObject({
      accountOwnershipChecked: true,
      authorId: "author_123",
      contentRevision: 2,
    });
    const effectPath = `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${task.campaignId}/effect-observations`;
    const result = await request(effectPath, {
      method: "POST",
      token: enterpriseToken,
      body: {
        kind: "TRANSACTION",
        observedAt: new Date().toISOString(),
        payload: {
          channel: "小红书",
          cohortStart: "2026-01-01T00:00:00.000Z",
          cohortEnd: "2026-01-02T00:00:00.000Z",
          conversionWindowEnd: "2026-02-01T00:00:00.000Z",
          definition: "PAID_ORDER",
          dataStatus: "VERIFIED",
          leadCount: 10,
          consultationCount: 8,
          transactionPeople: 2,
          orderCount: 2,
          receivedMinor: 500000,
          refundMinor: 100000,
          costMinor: 60000,
          currency: "CNY",
          source: "企业财务汇总与线索批次核对",
        },
      },
    });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      metrics: {
        netReceivedMinor: 400000,
        transactionRate: 0.2,
        costPerTransactionMinor: 30000,
        windowComplete: true,
      },
    });
    const history = await request(effectPath, { token: enterpriseToken });
    expect(history.status).toBe(200);
    expect(arrayField(history.body, "items")).toHaveLength(1);
  });

  async function request(
    path: string,
    options: Readonly<{
      body?: unknown;
      method?: "GET" | "POST";
      token?: string;
    }> = {},
  ): Promise<ApiResponse> {
    const headers = new Headers();
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.method === "POST") headers.set("idempotency-key", randomUUID());
    const response = await fetch(`${baseUrl}${path}`, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method: options.method ?? "GET",
    });
    const text = await response.text();
    return { body: text ? JSON.parse(text) : null, status: response.status };
  }
});

async function startPublicationProvider(input: {
  lateTask: TaskFixture;
  tasks: readonly TaskFixture[];
}): Promise<{
  close(): Promise<void>;
  endpoint: string;
  requests: {
    authorization: string | undefined;
    idempotencyKey: string | undefined;
    url: string;
  }[];
}> {
  const requests: {
    authorization: string | undefined;
    idempotencyKey: string | undefined;
    url: string;
  }[] = [];
  let retryCount = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { url: string };
      requests.push({
        authorization: request.headers.authorization,
        idempotencyKey: headerValue(request.headers["idempotency-key"]),
        url: parsed.url,
      });
      if (parsed.url.includes("httpretry0001") && retryCount++ === 0) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "UPSTREAM_TEMPORARY" } }));
        return;
      }
      const evidence = evidenceFor(parsed.url, input);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(evidence));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Publication provider failed");
  return {
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    endpoint: `http://127.0.0.1:${address.port}/v1/resolve`,
    requests,
  };
}

function evidenceFor(url: string, input: { lateTask: TaskFixture; tasks: readonly TaskFixture[] }) {
  if (url.includes("httpmedicalwrong"))
    return {
      ...availableEvidence("httpmedicalwrong", requiredAt(input.tasks, 3)),
      authorId: "another_author",
    };
  if (url.includes("httpmedicalcorrect"))
    return {
      ...availableEvidence("httpmedicalcorrect", requiredAt(input.tasks, 3)),
      authorId: "author_123",
    };
  if (url.includes("short-valid")) {
    return availableEvidence("httpvalid0001", requiredAt(input.tasks, 0));
  }
  if (url.includes("httpgray0001")) {
    return availableEvidence("httpgray0001", requiredAt(input.tasks, 1), []);
  }
  if (url.includes("httpretry0001")) {
    return availableEvidence("httpretry0001", requiredAt(input.tasks, 2));
  }
  if (url.includes("httpinvalid01")) {
    return {
      ...availableEvidence("httpinvalid01", requiredAt(input.tasks, 3)),
      body: "这是一条完全无关的公开内容",
      images: [{ checksum: "f".repeat(64), perceptualHash: null, url: null }],
      title: "无关主题",
    };
  }
  if (url.includes("httpfact0001")) {
    const task = requiredAt(input.tasks, 4);
    return {
      ...availableEvidence("httpfact0001", task),
      body: task.body.replace("24小时", "48小时"),
    };
  }
  if (url.includes("race-shared")) {
    const left = requiredAt(input.tasks, 5);
    const right = requiredAt(input.tasks, 6);
    return availableEvidence("httprace0001", left, [
      { checksum: left.checksum, perceptualHash: null, url: null },
      { checksum: right.checksum, perceptualHash: null, url: null },
    ]);
  }
  if (url.includes("httplate0001")) {
    return availableEvidence("httplate0001", input.lateTask);
  }
  return { reason: "Public content is unavailable", status: "UNAVAILABLE" };
}

function availableEvidence(
  noteId: string,
  task: TaskFixture,
  images: readonly Readonly<{
    checksum: string | null;
    perceptualHash: string | null;
    url: string | null;
  }>[] = [{ checksum: task.checksum, perceptualHash: null, url: null }],
) {
  return {
    body: task.body,
    canonicalUrl: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=removed`,
    externalPublishedAt: new Date().toISOString(),
    hashtags: task.hashtags,
    images,
    model: "publication-http-test-v1",
    reference: `reference:${noteId}`,
    requestId: `provider:${noteId}:${randomUUID()}`,
    status: "AVAILABLE",
    title: task.title,
  };
}

async function restoreSettings(
  prisma: PrismaService,
  settings: readonly PlatformSetting[],
): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: { in: [...publicationSettingKeys] } } });
  for (const setting of settings) {
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

async function requireRole(prisma: PrismaService, code: string): Promise<Role> {
  const role = await prisma.role.findUnique({ where: { code } });
  if (!role) throw new Error(`Seeded role was not found: ${code}`);
  return role;
}

function arrayField(value: unknown, field: string): unknown[] {
  const result = asRecord(value)[field];
  if (!Array.isArray(result)) throw new Error(`Expected array field: ${field}`);
  return result;
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  return asRecord(asRecord(value)[field]);
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

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Expected an object response");
  return value as Record<string, unknown>;
}

function expectCustomerPublicationReviewSanitized(value: unknown): void {
  const forbidden = new Set([
    "adapterModel",
    "adapterProvider",
    "adapterReference",
    "adapterRequestId",
    "generatedBy",
    "generationPrompt",
    "imageModel",
    "imageProvider",
    "model",
    "prompt",
    "provider",
    "reference",
    "requestId",
    "storageEtag",
    "storageKey",
    "synthetic",
    "verifier",
    "verifierUserId",
  ]);
  const exposed = objectKeysDeep(value).filter((key) => forbidden.has(key));
  expect(exposed).toEqual([]);
}

function objectKeysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeysDeep);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...objectKeysDeep(child)]);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (!value) throw new Error(`Expected fixture at index ${index}`);
  return value;
}

function assertDevelopmentDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname.replace(/^\//u, "") !== "dev_xhs_agentic") {
    throw new Error("Publication HTTP integration test requires dev_xhs_agentic");
  }
}

function testPhone(marker: string, suffix: number): string {
  const digits = marker.replace(/\D/g, "").slice(-7).padStart(7, "0");
  return `186${digits}${suffix}`;
}
