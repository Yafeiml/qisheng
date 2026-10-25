import "reflect-metadata";

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { PlatformSetting, Prisma } from "@xhs-agentic/database";
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
import * as publicationShortUrl from "./publication-short-url";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);
const PREFIX = "/integrations/v2/collection-jobs";
const READBACK_PREFIX = "/integrations/v1/publication-readback";

describe("Windows browser publication work orders (local fixtures only)", {
  concurrent: false,
}, () => {
  const marker = `browser-publication-${randomUUID()}`;
  const key = randomBytes(40).toString("hex");
  const collectorId = `test-${randomUUID().slice(0, 8)}`;
  const nonceIds: string[] = [];
  const previousKey = process.env.PUBLICATION_COLLECTOR_HMAC_KEY;
  const previousId = process.env.PUBLICATION_COLLECTOR_ID;
  const previousReadbackEnabled = process.env.PUBLICATION_READBACK_ENABLED;
  const previousReadbackKeys = process.env.PUBLICATION_READBACK_NODE_KEYS_JSON;
  const readbackNodeId = `readback-${randomUUID().slice(0, 8)}`;
  const readbackKey = randomBytes(40).toString("hex");
  const readbackSecondaryId = `readback-${randomUUID().slice(0, 8)}`;
  const readbackSecondaryKey = randomBytes(40).toString("hex");
  let app: INestApplication;
  let db: PrismaService;
  let baseUrl: string;
  let modeSetting: PlatformSetting | null;
  let readbackEnabledSetting: PlatformSetting | null;
  let oldCollectorState: Awaited<
    ReturnType<PrismaService["publicationCollectorState"]["findUnique"]>
  >;
  let platformToken: string;
  let enterpriseToken: string;
  let tenantId: string;
  let enterpriseId: string;
  let userIds: string[] = [];
  let adminIds: string[] = [];
  let taskFixtures: { id: string; token: string; title: string; body: string }[] = [];
  let firstSubmissionId: string;
  let firstJobId: string;
  let firstLease: string;
  let retrySubmissionId: string;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || new URL(url).pathname.replace(/^\//u, "") !== "dev_xhs_agentic") {
      throw new Error("Browser publication integration tests require dev_xhs_agentic");
    }
    process.env.PUBLICATION_COLLECTOR_ID = collectorId;
    process.env.PUBLICATION_COLLECTOR_HMAC_KEY = key;
    // This suite tests signed auth and DB fencing; the developer's Redis may
    // be unavailable. Patch the limiter only inside this isolated test worker.
    vi.spyOn(RateLimitGuard.prototype, "canActivate").mockResolvedValue(true);
    app = await NestFactory.create(AppModule, {
      abortOnError: false,
      bodyParser: false,
      logger: false,
    });
    configureApplication(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
    db = app.get(PrismaService);
    readbackEnabledSetting = await db.platformSetting.findUnique({
      where: { key: "publication.readback_enabled" },
    });
    await seedAuthorizationCatalog(db);
    await seedRuntimePolicy(db);
    await seedPlatformSettings(db);
    // These cases exercise the retained environment-configured external-node mode.
    await db.platformSetting.deleteMany({ where: { key: "publication.readback_enabled" } });
    modeSetting = await db.platformSetting.findUnique({ where: { key: "publication.mode" } });
    oldCollectorState = await db.publicationCollectorState.findUnique({
      where: { id: "windows-browser" },
    });
    if (modeSetting) {
      await db.platformSetting.update({
        data: { value: "BROWSER", version: { increment: 1 } },
        where: { key: "publication.mode" },
      });
    } else {
      await db.platformSetting.create({
        data: {
          group: "PUBLICATION",
          key: "publication.mode",
          value: "BROWSER",
          valueType: "ENUM",
          version: 1,
          updatedBy: "browser-integration-test",
        },
      });
    }
    const [platformRole, enterpriseRole] = await Promise.all([
      db.role.findUniqueOrThrow({ where: { code: "PLATFORM_ADMIN" } }),
      db.role.findUniqueOrThrow({ where: { code: "ENTERPRISE_ADMIN" } }),
    ]);
    const [platformAdmin, enterpriseAdmin] = await Promise.all([
      db.adminUser.create({ data: { phone: phone(0), phoneVerifiedAt: new Date() } }),
      db.adminUser.create({ data: { phone: phone(1), phoneVerifiedAt: new Date() } }),
    ]);
    userIds = [platformAdmin.id, enterpriseAdmin.id];
    adminIds = [...userIds];
    const tenant = await db.tenant.create({
      data: { customerType: "GROUP", name: `${marker}-tenant` },
    });
    tenantId = tenant.id;
    const enterprise = await db.enterprise.create({
      data: {
        code: `BR_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
        name: `${marker}-enterprise`,
        tenantId,
      },
    });
    enterpriseId = enterprise.id;
    const auth = app.get(AuthorizationRepository);
    await Promise.all([
      auth.createRoleBinding(platformAccessScope(), {
        roleId: platformRole.id,
        targetScope: platformAccessScope(),
        userId: platformAdmin.id,
      }),
      auth.createRoleBinding(platformAccessScope(), {
        roleId: enterpriseRole.id,
        targetScope: enterpriseAccessScope(tenantId, enterpriseId),
        userId: enterpriseAdmin.id,
      }),
    ]);
    const tokens = app.get(AuthTokenService);
    platformToken = tokens.issueAdminAccessToken(platformAdmin.id);
    enterpriseToken = tokens.issueAdminAccessToken(enterpriseAdmin.id);
    const visibleAt = new Date(Date.now() - 60_000);
    const expiresAt = new Date(visibleAt.getTime() + 24 * 60 * 60_000);
    const campaign = await db.campaign.create({
      data: {
        approvedAt: new Date(),
        approvedBy: enterpriseAdmin.id,
        audienceCount: 5,
        createdBy: enterpriseAdmin.id,
        expiresAt,
        generatedCount: 5,
        imageCount: 1,
        prompt: "浏览器工作单本机测试",
        status: "ACTIVE",
        tenantId,
        enterpriseId,
        title: "浏览器验真工作单",
        visibleAt,
      },
    });
    taskFixtures = await Promise.all(
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(async (index) => {
        const employee = await db.globalUser.create({
          data: { phone: phone(index), phoneVerifiedAt: new Date() },
        });
        userIds.push(employee.id);
        if (!employee.phone) throw new Error("Expected a phone in the employee test fixture");
        const membership = await db.enterpriseMembership.create({
          data: {
            boundAt: new Date(),
            enterpriseId,
            globalUserId: employee.id,
            name: `员工-${index}`,
            phone: employee.phone,
            seatEnabledAt: new Date(),
            seatStatus: "ENABLED",
            status: "ACTIVE",
            tenantId,
          },
        });
        const snapshot = await db.campaignAudienceSnapshot.create({
          data: {
            campaignId: campaign.id,
            employeeName: membership.name,
            employeePhone: membership.phone,
            enterpriseId,
            membershipId: membership.id,
            tenantId,
          },
        });
        const title = `验真专属标题-${index}`;
        const body = `需要员工发布的完整图文内容-${index}：针对不同事实和内容避免错误通过。`;
        const checksum = createHash("sha256").update(`${marker}-${index}`).digest("hex");
        const content = await db.employeeContent.create({
          data: {
            audienceSnapshotId: snapshot.id,
            body,
            campaignId: campaign.id,
            contentFingerprint: createHash("sha256").update(`${title}\n${body}`).digest("hex"),
            enterpriseId,
            hashtags: ["验真"],
            imagePrompt: "真实图片匹配测试",
            membershipId: membership.id,
            riskAssessment: { passed: true },
            status: "APPROVED",
            synthetic: false,
            tenantId,
            title,
          },
        });
        await db.generatedImage.create({
          data: {
            campaignId: campaign.id,
            checksum,
            employeeContentId: content.id,
            height: 100,
            imageUrl: `https://assets.example.test/${index}.png`,
            mimeType: "image/png",
            model: "fixture-v1",
            perceptualHash: checksum.slice(0, 16),
            prompt: "fixture",
            provider: "TEST",
            sequence: 1,
            synthetic: false,
            tenantId,
            width: 100,
          },
        });
        const task = await db.distributionTask.create({
          data: {
            campaignId: campaign.id,
            employeeContentId: content.id,
            enterpriseId,
            expiresAt,
            factsConfirmedAt: visibleAt,
            factsConfirmedRevision: content.revision,
            membershipId: membership.id,
            status: "AVAILABLE",
            tenantId,
            visibleAt,
          },
        });
        return { id: task.id, token: tokens.issueEmployeeAccessToken(employee.id), title, body };
      }),
    );
  });

  afterAll(async () => {
    if (db) {
      await db.publicationCollectorRequestNonce.deleteMany({ where: { id: { in: nonceIds } } });
      if (oldCollectorState) {
        await db.publicationCollectorState.update({
          data: {
            lastSeenAt: oldCollectorState.lastSeenAt,
            pausedAt: oldCollectorState.pausedAt,
            pauseReason: oldCollectorState.pauseReason,
            resumedAt: oldCollectorState.resumedAt,
          },
          where: { id: oldCollectorState.id },
        });
      } else {
        await db.publicationCollectorState.deleteMany({ where: { id: "windows-browser" } });
      }
      if (tenantId) {
        await db.publishReadbackSnapshot.deleteMany({ where: { tenantId } });
        await db.publishMetricSnapshot.deleteMany({ where: { tenantId } });
        await db.publishedContentRegistry.deleteMany({ where: { tenantId } });
        await db.publicationCollectionJob.deleteMany({ where: { submission: { tenantId } } });
        await db.publishSubmission.deleteMany({ where: { tenantId } });
        await db.auditLog.deleteMany({
          where: { OR: [{ tenantId }, { actorUserId: { in: userIds } }] },
        });
        await db.generatedImage.deleteMany({ where: { tenantId } });
        await db.distributionTask.deleteMany({ where: { tenantId } });
        await db.employeeContentRevision.deleteMany({ where: { tenantId } });
        await db.employeeContent.deleteMany({ where: { tenantId } });
        await db.campaignAudienceSnapshot.deleteMany({ where: { tenantId } });
        await db.campaign.deleteMany({ where: { tenantId } });
        await db.roleBinding.deleteMany({
          where: { OR: [{ tenantId }, { userId: { in: adminIds } }] },
        });
        await db.enterpriseMembership.deleteMany({ where: { tenantId } });
        await db.tenantCapabilityPolicy.deleteMany({ where: { tenantId } });
        await db.enterprise.deleteMany({ where: { id: enterpriseId } });
        await db.tenant.deleteMany({ where: { id: tenantId } });
        await db.adminUser.deleteMany({ where: { id: { in: adminIds } } });
        await db.globalUser.deleteMany({
          where: { id: { in: userIds.filter((id) => !adminIds.includes(id)) } },
        });
      }
      if (modeSetting) {
        await db.platformSetting.update({
          data: { value: modeSetting.value as Prisma.InputJsonValue, version: modeSetting.version },
          where: { key: "publication.mode" },
        });
      } else {
        await db.platformSetting.deleteMany({ where: { key: "publication.mode" } });
      }
      if (readbackEnabledSetting) {
        const data = {
          group: readbackEnabledSetting.group,
          valueType: readbackEnabledSetting.valueType,
          value: readbackEnabledSetting.value as Prisma.InputJsonValue,
          version: readbackEnabledSetting.version,
          updatedBy: readbackEnabledSetting.updatedBy,
        };
        await db.platformSetting.upsert({
          where: { key: "publication.readback_enabled" },
          create: { key: "publication.readback_enabled", ...data },
          update: data,
        });
      } else
        await db.platformSetting.deleteMany({ where: { key: "publication.readback_enabled" } });
    }
    await app?.close();
    vi.restoreAllMocks();
    if (previousId === undefined) delete process.env.PUBLICATION_COLLECTOR_ID;
    else process.env.PUBLICATION_COLLECTOR_ID = previousId;
    if (previousKey === undefined) delete process.env.PUBLICATION_COLLECTOR_HMAC_KEY;
    else process.env.PUBLICATION_COLLECTOR_HMAC_KEY = previousKey;
    if (previousReadbackEnabled === undefined) delete process.env.PUBLICATION_READBACK_ENABLED;
    else process.env.PUBLICATION_READBACK_ENABLED = previousReadbackEnabled;
    if (previousReadbackKeys === undefined) delete process.env.PUBLICATION_READBACK_NODE_KEYS_JSON;
    else process.env.PUBLICATION_READBACK_NODE_KEYS_JSON = previousReadbackKeys;
  });

  it("rejects invalid HMAC, body/path substitution and a replayed nonce", async () => {
    const path = `${PREFIX}/status`;
    const badSignature = await signed(path, { wrongSignature: true });
    expect(badSignature.status).toBe(401);
    const wrongPath = await signed(path, { signaturePath: `${PREFIX}/claim` });
    expect(wrongPath.status).toBe(401);
    const nonce = randomUUID();
    expect((await signed(path, { nonce })).status).toBe(200);
    expect((await signed(path, { nonce })).status).toBe(401);
    const tamperedBody = await signed(`${PREFIX}/claim`, {
      method: "POST",
      body: { limit: 2 },
      signatureBody: { limit: 1 },
    });
    expect(tamperedBody.status).toBe(401);
  });

  it("atomically records the employee timestamp and leases to only one concurrent poll", async () => {
    const task = requiredAt(taskFixtures, 0);
    const submitted = await request(`/employee/tasks/${task.id}/submissions`, {
      method: "POST",
      token: task.token,
      body: {
        url: "分享 https://www.xiaohongshu.com/explore/browserabc001?xsec_token=private-access",
      },
    });
    expect(submitted.status).toBe(201);
    expect(JSON.stringify(submitted.body)).not.toContain("private-access");
    expect(record(submitted.body).status).toBe("VERIFYING");
    firstSubmissionId = String(record(submitted.body).submissionId);
    const due = await db.publicationCollectionJob.findMany({
      where: { submissionId: firstSubmissionId },
    });
    expect(due).toHaveLength(1);
    expect(due[0]?.kind).toBe("VERIFY");
    const claims = await Promise.all([
      signed(`${PREFIX}/claim`, { method: "POST", body: { limit: 1 } }),
      signed(`${PREFIX}/claim`, { method: "POST", body: { limit: 1 } }),
    ]);
    expect(claims.map(({ status }) => status)).toEqual([201, 201]);
    const jobs = claims.map(({ body }) => record(body).job).filter(Boolean);
    expect(jobs).toHaveLength(1);
    const job = record(jobs[0]);
    firstJobId = String(job.id);
    firstLease = String(job.leaseToken);
    expect(String(job.accessUrl)).toContain("xsec_token=private-access");
    expect(
      (await db.distributionTask.findUniqueOrThrow({ where: { id: task.id } })).submittedAt,
    ).toBeTruthy();
  });

  it("holds an uncertain expired lease for review; a new human retry can collect incomplete evidence", async () => {
    await db.publicationCollectionJob.update({
      data: { leaseExpiresAt: new Date(Date.now() - 10_000) },
      where: { id: firstJobId },
    });
    const stale = await signed(`${PREFIX}/${firstJobId}/evidence`, {
      method: "POST",
      body: { leaseToken: firstLease, status: "AVAILABLE" },
    });
    expect(stale.status).toBe(409);
    const noAutomaticReissue = await signed(`${PREFIX}/claim`, {
      method: "POST",
      body: { limit: 1 },
    });
    expect(record(noAutomaticReissue.body).job).toBeNull();
    expect(
      (await db.publicationCollectionJob.findUniqueOrThrow({ where: { id: firstJobId } })).status,
    ).toBe("NEEDS_REVIEW");
    expect(
      (await db.publishSubmission.findUniqueOrThrow({ where: { id: firstSubmissionId } })).status,
    ).toBe("UNAVAILABLE");
    const expiredHeartbeat = await signed(`${PREFIX}/${firstJobId}/heartbeat`, {
      method: "POST",
      body: { leaseToken: firstLease },
    });
    expect(expiredHeartbeat.status).toBe(409);
    const retry = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/publication-reviews/${firstSubmissionId}/retry`,
      {
        method: "POST",
        token: enterpriseToken,
        body: { reason: "断电后先人工核查原浏览器再重新领取" },
      },
    );
    expect(retry.status).toBe(201);
    firstSubmissionId = String(record(retry.body).submissionId);
    const reissued = await signed(`${PREFIX}/claim`, { method: "POST", body: { limit: 1 } });
    const renewed = record(record(reissued.body).job);
    expect(renewed.id).not.toBe(firstJobId);
    const newLease = String(renewed.leaseToken);
    firstJobId = String(renewed.id);
    firstLease = newLease;
    const task = requiredAt(taskFixtures, 0);
    const payload = {
      leaseToken: newLease,
      status: "AVAILABLE",
      observedAt: new Date().toISOString(),
      canonicalUrl: "https://www.xiaohongshu.com/explore/browserabc001",
      title: task.title,
      body: task.body,
      images: [{ url: "https://assets.example.test/2.png" }],
      visibilityContext: "COLLECTOR_ACCOUNT",
      metrics: { likes: 0 },
      metricsRaw: {
        likes: { value: 0, raw: "0", precision: "EXACT" },
        favorites: { value: null, raw: null, precision: "UNAVAILABLE" },
        comments: { value: null, raw: null, precision: "UNAVAILABLE" },
      },
    };
    const evidence = await signed(`${PREFIX}/${firstJobId}/evidence`, {
      method: "POST",
      body: payload,
    });
    expect(evidence.status).toBe(201);
    expect(record(evidence.body).status).toBe("NEEDS_REVIEW");
    const acknowledged = await signed(`${PREFIX}/${firstJobId}/evidence`, {
      method: "POST",
      body: payload,
    });
    expect(record(acknowledged.body).alreadyAccepted).toBe(true);
    const conflicting = await signed(`${PREFIX}/${firstJobId}/evidence`, {
      method: "POST",
      body: { ...payload, title: "被篡改的证据" },
    });
    expect(conflicting.status).toBe(409);
    expect(
      (await db.publishSubmission.findUniqueOrThrow({ where: { id: firstSubmissionId } })).status,
    ).toBe("MANUAL_REVIEW");
    expect((await db.distributionTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      "VERIFYING",
    );
    expect(
      await db.publishedContentRegistry.count({ where: { submissionId: firstSubmissionId } }),
    ).toBe(0);
    const reviews = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/publication-reviews`,
      { token: enterpriseToken },
    );
    expect(reviews.status).toBe(200);
    expect(JSON.stringify(reviews.body)).not.toContain("private-access");
  });

  it("supersedes old evidence; a risk pause blocks claims but accepts the active risk report", async () => {
    const retried = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/publication-reviews/${firstSubmissionId}/retry`,
      { method: "POST", token: enterpriseToken, body: { reason: "人工要求重新取得图文强证据" } },
    );
    expect(retried.status).toBe(201);
    expect(record(retried.body).status).toBe("VERIFYING");
    retrySubmissionId = String(record(retried.body).submissionId);
    const oldJob = await db.publicationCollectionJob.findUniqueOrThrow({
      where: { id: firstJobId },
    });
    expect(oldJob.status).toBe("CANCELLED");
    const oldReport = await signed(`${PREFIX}/${firstJobId}/evidence`, {
      method: "POST",
      body: { leaseToken: firstLease, status: "AVAILABLE" },
    });
    expect(oldReport.status).toBe(409);
    expect(
      (await db.publishSubmission.findUniqueOrThrow({ where: { id: firstSubmissionId } })).status,
    ).toBe("SUPERSEDED");
    const secondTask = requiredAt(taskFixtures, 1);
    expect(
      (
        await request(`/employee/tasks/${secondTask.id}/submissions`, {
          method: "POST",
          token: secondTask.token,
          body: { url: "https://www.xiaohongshu.com/explore/browserabc002" },
        })
      ).status,
    ).toBe(201);
    const claim = await signed(`${PREFIX}/claim`, { method: "POST", body: { limit: 1 } });
    const activeJob = record(record(claim.body).job);
    const paused = await signed(`${PREFIX}/pause`, {
      method: "POST",
      body: { reason: "CHALLENGE_REQUIRED" },
    });
    expect(record(paused.body).paused).toBe(true);
    const stopped = await signed(`${PREFIX}/claim`, { method: "POST", body: { limit: 1 } });
    expect(record(stopped.body).job).toBeNull();
    expect(record(stopped.body).paused).toBe(true);
    const risk = await signed(`${PREFIX}/${activeJob.id}/evidence`, {
      method: "POST",
      body: { leaseToken: activeJob.leaseToken, status: "CHALLENGE_REQUIRED" },
    });
    expect(risk.status).toBe(201);
    expect(record(risk.body).paused).toBe(true);
    const resumed = await request("/platform/publication-collector/resume", {
      method: "POST",
      token: platformToken,
      body: { reason: "仅用于本机隔离测试，人工确认恢复" },
    });
    expect(resumed.status).toBe(201);
    expect(record(resumed.body).paused).toBe(false);
  });

  it("verifies the note but never collects or stores metrics when tenant capability is disabled", async () => {
    const task = requiredAt(taskFixtures, 1);
    await db.tenantCapabilityPolicy.upsert({
      create: { tenantId, metricsIntegrationEnabled: false },
      update: { metricsIntegrationEnabled: false },
      where: { tenantId },
    });
    const due = await db.publicationCollectionJob.findFirstOrThrow({
      include: { submission: true },
      where: { submission: { taskId: task.id }, status: "QUEUED" },
    });
    const assigned = await signed(`${PREFIX}/claim`, { method: "POST", body: { limit: 1 } });
    const claimed = record(record(assigned.body).job);
    expect(claimed.id).toBe(due.id);
    const source = await db.distributionTask.findUniqueOrThrow({
      include: { employeeContent: { include: { images: true } } },
      where: { id: task.id },
    });
    const image = requiredAt(source.employeeContent.images, 0);
    const result = await signed(`${PREFIX}/${due.id}/evidence`, {
      method: "POST",
      body: {
        leaseToken: claimed.leaseToken,
        status: "AVAILABLE",
        observedAt: new Date().toISOString(),
        canonicalUrl: "https://www.xiaohongshu.com/explore/browserabc002",
        title: task.title,
        body: task.body,
        hashtags: ["验真"],
        images: [{ perceptualHash: image.perceptualHash }],
        visibilityContext: "COLLECTOR_ACCOUNT",
        metrics: { likes: 7 },
        metricsRaw: {
          likes: { value: 7, raw: "7", precision: "EXACT" },
          comments: { value: null, raw: null, precision: "UNAVAILABLE" },
          favorites: { value: null, raw: null, precision: "UNAVAILABLE" },
        },
      },
    });
    expect(result.status).toBe(201);
    expect(
      (await db.publishSubmission.findUniqueOrThrow({ where: { id: due.submissionId } })).status,
    ).toBe("VALID");
    expect((await db.distributionTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      "COMPLETED",
    );
    expect(await db.publishMetricSnapshot.count({ where: { tenantId } })).toBe(0);
    expect(
      await db.publicationCollectionJob.count({
        where: { submissionId: due.submissionId, kind: "METRICS" },
      }),
    ).toBe(0);
    const stored = await db.publicationCollectionJob.findUniqueOrThrow({ where: { id: due.id } });
    expect(JSON.stringify(stored.evidence)).not.toContain("metricsRaw");
    expect(JSON.stringify(stored.evidence)).not.toContain('"metrics"');
  });

  it("keeps the canonical note globally unique when another employee submits the same link", async () => {
    const task = requiredAt(taskFixtures, 2);
    const submitted = await request(`/employee/tasks/${task.id}/submissions`, {
      method: "POST",
      token: task.token,
      body: { url: "https://www.xiaohongshu.com/explore/browserabc002" },
    });
    expect(submitted.status).toBe(201);
    const collected = await signed(`${PREFIX}/claim`, { method: "POST", body: { limit: 1 } });
    const claim = record(record(collected.body).job);
    const source = await db.distributionTask.findUniqueOrThrow({
      include: { employeeContent: { include: { images: true } } },
      where: { id: task.id },
    });
    const image = requiredAt(source.employeeContent.images, 0);
    const result = await signed(`${PREFIX}/${claim.id}/evidence`, {
      method: "POST",
      body: {
        leaseToken: claim.leaseToken,
        status: "AVAILABLE",
        observedAt: new Date().toISOString(),
        canonicalUrl: "https://www.xiaohongshu.com/explore/browserabc002",
        title: task.title,
        body: task.body,
        hashtags: ["验真"],
        images: [{ perceptualHash: image.perceptualHash }],
      },
    });
    expect(result.status).toBe(201);
    expect(
      (
        await db.publishSubmission.findUniqueOrThrow({
          where: { id: String(record(submitted.body).submissionId) },
        })
      ).status,
    ).toBe("DUPLICATE");
    expect(
      await db.publishedContentRegistry.count({
        where: { canonicalKey: "xhs:note:browserabc002" },
      }),
    ).toBe(1);
  });

  it("schedules entitled metric windows after human approval of browser evidence", async () => {
    await db.tenantCapabilityPolicy.update({
      data: { metricsIntegrationEnabled: true },
      where: { tenantId },
    });
    const approved = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/publication-reviews/${retrySubmissionId}`,
      {
        method: "POST",
        token: enterpriseToken,
        body: { decision: "VERIFIED", reason: "本机隔离样本人工复核图文与员工内容相符" },
      },
    );
    expect(approved.status).toBe(201);
    expect(record(approved.body).status).toBe("VALID");
    const windows = await db.publicationCollectionJob.findMany({
      orderBy: { windowHours: "asc" },
      where: { submissionId: retrySubmissionId, kind: "METRICS" },
    });
    expect(windows.map(({ windowHours }) => windowHours)).toEqual([24, 72]);
    expect(JSON.stringify(windows)).not.toContain("private-access");
  });

  it("shows first browser metrics on the dashboard without treating zero, approximate, or unknown as each other", async () => {
    const task = requiredAt(taskFixtures, 5);
    await db.tenantCapabilityPolicy.upsert({
      create: { tenantId, metricsIntegrationEnabled: true },
      update: { metricsIntegrationEnabled: true },
      where: { tenantId },
    });
    const submitted = await request(`/employee/tasks/${task.id}/submissions`, {
      method: "POST",
      token: task.token,
      body: { url: "https://www.xiaohongshu.com/explore/browsermetrics006" },
    });
    expect(submitted.status).toBe(201);
    const submissionId = String(record(submitted.body).submissionId);
    const claimed = await signed(`${PREFIX}/claim`, { method: "POST", body: { limit: 1 } });
    expect(claimed.status).toBe(201);
    const job = record(record(claimed.body).job);
    expect(job.kind).toBe("VERIFY");
    const content = await db.distributionTask.findUniqueOrThrow({
      include: { employeeContent: { include: { images: true } } },
      where: { id: task.id },
    });
    const observedAt = new Date().toISOString();
    const evidence = await signed(`${PREFIX}/${job.id}/evidence`, {
      method: "POST",
      body: {
        leaseToken: job.leaseToken,
        status: "AVAILABLE",
        observedAt,
        canonicalUrl: "https://www.xiaohongshu.com/explore/browsermetrics006",
        title: task.title,
        body: task.body,
        hashtags: ["验真"],
        images: [{ perceptualHash: requiredAt(content.employeeContent.images, 0).perceptualHash }],
        visibilityContext: "COLLECTOR_ACCOUNT",
        metrics: { likes: 0 },
        metricsRaw: {
          likes: { value: 0, raw: "0", precision: "EXACT" },
          favorites: { value: null, raw: "1.2万", precision: "APPROXIMATE" },
          comments: { value: null, raw: null, precision: "UNAVAILABLE" },
        },
      },
    });
    expect(evidence.status).toBe(201);
    expect(
      (await db.publishSubmission.findUniqueOrThrow({ where: { id: submissionId } })).status,
    ).toBe("VALID");
    const stored = await db.publishMetricSnapshot.findFirstOrThrow({
      where: { tenantId, windowHours: 0, registry: { submissionId } },
    });
    expect(stored).toMatchObject({
      likes: 0,
      favorites: null,
      comments: null,
      views: null,
      windowHours: 0,
      source: "WINDOWS_BROWSER",
    });
    expect(stored.observedAt.toISOString()).toBe(observedAt);
    const dashboard = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/dashboard`,
      { token: enterpriseToken },
    );
    expect(dashboard.status).toBe(200);
    const observations = record(dashboard.body).metricObservations;
    if (!Array.isArray(observations)) throw new Error("Expected metric observations");
    const first = observations.find((row) => record(row).taskId === task.id);
    const metric = record(record(first).latestMetrics);
    expect(metric).toMatchObject({
      likes: 0,
      favorites: null,
      comments: null,
      windowHours: 0,
      rawData: {
        metricPrecision: {
          likes: "EXACT",
          favorites: "APPROXIMATE",
          comments: "UNAVAILABLE",
        },
        metricDisplay: { favorites: "1.2万" },
      },
    });
    const windows = record(dashboard.body).metricWindows;
    if (!Array.isArray(windows)) throw new Error("Expected metric windows");
    expect(
      windows
        .filter((row) => record(row).taskId === task.id)
        .map((row) => record(row).windowHours)
        .sort(),
    ).toEqual([24, 72]);
  });

  it("settles two concurrent claims to one VALID and one DUPLICATE for the same note", async () => {
    const pair = [requiredAt(taskFixtures, 3), requiredAt(taskFixtures, 4)];
    const submitted = await Promise.all(
      pair.map((task) =>
        request(`/employee/tasks/${task.id}/submissions`, {
          method: "POST",
          token: task.token,
          body: { url: "https://www.xiaohongshu.com/explore/browserrace003" },
        }),
      ),
    );
    expect(submitted.map(({ status }) => status)).toEqual([201, 201]);
    const leases = await Promise.all([
      signed(`${PREFIX}/claim`, { method: "POST", body: { limit: 1 } }),
      signed(`${PREFIX}/claim`, { method: "POST", body: { limit: 1 } }),
    ]);
    const claimed = leases.map(({ body }) => record(record(body).job));
    expect(new Set(claimed.map(({ id }) => id)).size).toBe(2);
    const jobs = await db.publicationCollectionJob.findMany({
      where: { id: { in: claimed.map(({ id }) => String(id)) } },
    });
    const evidence = await Promise.all(
      claimed.map(async (lease) => {
        const job = requiredAt(
          jobs.filter(({ id }) => id === lease.id),
          0,
        );
        const task = requiredAt(
          pair.filter(
            (_item, index) => record(submitted[index]?.body).submissionId === job.submissionId,
          ),
          0,
        );
        const source = await db.distributionTask.findUniqueOrThrow({
          include: { employeeContent: { include: { images: true } } },
          where: { id: task.id },
        });
        return {
          path: `${PREFIX}/${lease.id}/evidence`,
          body: {
            leaseToken: lease.leaseToken,
            status: "AVAILABLE",
            observedAt: new Date().toISOString(),
            canonicalUrl: "https://www.xiaohongshu.com/explore/browserrace003",
            title: task.title,
            body: task.body,
            hashtags: ["验真"],
            images: [
              { perceptualHash: requiredAt(source.employeeContent.images, 0).perceptualHash },
            ],
          },
        };
      }),
    );
    const firstTry = await Promise.all(
      evidence.map(({ path, body }) =>
        signed(path, {
          method: "POST",
          body,
        }),
      ),
    );
    const results = await Promise.all(
      firstTry.map(async (response, index) =>
        response.status === 409
          ? signed(requiredAt(evidence, index).path, {
              method: "POST",
              body: requiredAt(evidence, index).body,
            })
          : response,
      ),
    );
    expect(results.map(({ status }) => status)).toEqual([201, 201]);
    const statuses = await db.publishSubmission.findMany({
      select: { status: true },
      where: { id: { in: submitted.map(({ body }) => String(record(body).submissionId)) } },
    });
    expect(statuses.map(({ status }) => status).sort()).toEqual(["DUPLICATE", "VALID"]);
    expect(
      await db.publishedContentRegistry.count({
        where: { canonicalKey: "xhs:note:browserrace003" },
      }),
    ).toBe(1);
  });

  it("quarantines a legacy incompatible URL and claims the next shared modern short link", async () => {
    const dirtyTask = requiredAt(taskFixtures, 2);
    const remainingTasks = await db.distributionTask.findMany({
      select: { id: true },
      where: {
        id: { in: [...taskFixtures.slice(3, 6), requiredAt(taskFixtures, 7)].map(({ id }) => id) },
        status: "AVAILABLE",
      },
    });
    const legitimateTask = requiredAt(
      taskFixtures.filter(({ id }) => id === remainingTasks[0]?.id),
      0,
    );
    const dirty = await request(`/employee/tasks/${dirtyTask.id}/submissions`, {
      method: "POST",
      token: dirtyTask.token,
      body: { url: "https://www.xiaohongshu.com/explore/browsertest004" },
    });
    expect(dirty.status).toBe(201);
    const dirtyId = String(record(dirty.body).submissionId);
    await db.publishSubmission.update({
      data: {
        rawUrl: "https://www.xiaohongshu.com/explore/browsertest004/extra?xsec_token=never-expose",
      },
      where: { id: dirtyId },
    });
    const valid = await request(`/employee/tasks/${legitimateTask.id}/submissions`, {
      method: "POST",
      token: legitimateTask.token,
      body: {
        url: "发布的笔记 https://xhslink.cn/o/Fixture123 复制这段话，进入【小红书】就能找到笔记。",
      },
    });
    expect(valid.status).toBe(201);
    const result = await signed(`${PREFIX}/claim`, { method: "POST", body: { limit: 1 } });
    expect(result.status).toBe(201);
    expect(JSON.stringify(result.body)).not.toContain("never-expose");
    expect(record(record(result.body).job).accessUrl).toBe("https://xhslink.cn/o/Fixture123");
    expect(record(record(result.body).job).id).toBe(
      (
        await db.publicationCollectionJob.findFirstOrThrow({
          where: { submissionId: String(record(valid.body).submissionId) },
        })
      ).id,
    );
    expect((await db.publishSubmission.findUniqueOrThrow({ where: { id: dirtyId } })).status).toBe(
      "UNAVAILABLE",
    );
    expect(
      (await db.publicationCollectionJob.findFirstOrThrow({ where: { submissionId: dirtyId } }))
        .status,
    ).toBe("NEEDS_REVIEW");
  });

  it("stops issuing browser URLs immediately when the platform changes mode", async () => {
    await db.platformSetting.update({
      data: { value: "DEVELOPMENT" },
      where: { key: "publication.mode" },
    });
    const health = await signed(`${PREFIX}/status`);
    expect(record(health.body)).toMatchObject({ paused: true, reason: "BROWSER_MODE_DISABLED" });
    const claim = await signed(`${PREFIX}/claim`, { method: "POST", body: { limit: 1 } });
    expect(record(claim.body).job).toBeNull();
    expect(JSON.stringify(claim.body)).not.toContain("xsec_token");
    await db.platformSetting.update({
      data: { value: "BROWSER" },
      where: { key: "publication.mode" },
    });
  });

  it("records only one verification work order for simultaneous submissions of one employee task", async () => {
    const task = requiredAt(taskFixtures, 6);
    const attempts = await Promise.all(
      ["browserdouble007", "browserdouble008"].map((id) =>
        request(`/employee/tasks/${task.id}/submissions`, {
          method: "POST",
          token: task.token,
          body: { url: `https://www.xiaohongshu.com/explore/${id}` },
        }),
      ),
    );
    expect(attempts.map(({ status }) => status).sort(), JSON.stringify(attempts)).toEqual([
      201, 409,
    ]);
    const submissions = await db.publishSubmission.findMany({ where: { taskId: task.id } });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.status).toBe("VERIFYING");
    expect(
      await db.publicationCollectionJob.count({
        where: { submission: { taskId: task.id }, kind: "VERIFY" },
      }),
    ).toBe(1);
    expect((await db.distributionTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      "VERIFYING",
    );
  });

  it("shows authenticated node presence and edits the shared daily limit without exposing keys", async () => {
    const beforeState = await db.publicationCollectorState.findUnique({
      where: { id: "distributed-readback" },
    });
    const beforeKeys = process.env.PUBLICATION_READBACK_NODE_KEYS_JSON;
    process.env.PUBLICATION_READBACK_NODE_KEYS_JSON = JSON.stringify({
      [readbackNodeId]: readbackKey,
    });
    try {
      const unauthorized = await request("/platform/publication-readback/operations", {
        token: enterpriseToken,
      });
      expect(unauthorized.status).toBe(403);
      const heartbeat = await signed(`${READBACK_PREFIX}/status`, {
        readback: true,
        panelUrl: "https://collector.example.com:8443/",
      });
      expect(heartbeat.status).toBe(200);
      const overview = await request("/platform/publication-readback/operations", {
        token: platformToken,
      });
      expect(overview.status).toBe(200);
      expect(record(overview.body)).toMatchObject({
        onlineNodes: 1,
        nodes: [
          {
            id: readbackNodeId,
            online: true,
            panelHost: "collector.example.com",
            panelUrl: "https://collector.example.com:8443/",
          },
        ],
      });
      expect(JSON.stringify(overview.body)).not.toContain(readbackKey);
      const localhostPanel = await signed(`${READBACK_PREFIX}/status`, {
        readback: true,
        panelUrl: "http://[::1]:23110/",
      });
      expect(localhostPanel.status).toBe(200);
      const updated = await request("/platform/publication-readback/daily-limit", {
        method: "POST",
        token: platformToken,
        body: { dailyLimit: 37, reason: "试点预算调整" },
      });
      expect(updated.status).toBe(201);
      expect(record(updated.body)).toMatchObject({ dailyLimit: 37 });
      expect(
        (await db.publicationReadbackNode.findUniqueOrThrow({ where: { id: readbackNodeId } }))
          .panelUrl,
      ).toBe("http://[::1]:23110/");
      const deniedUpdate = await request("/platform/publication-readback/daily-limit", {
        method: "POST",
        token: enterpriseToken,
        body: { dailyLimit: 1, reason: "越权测试" },
      });
      expect(deniedUpdate.status).toBe(403);
    } finally {
      await db.publicationReadbackNode.deleteMany({ where: { id: readbackNodeId } });
      if (beforeState) {
        await db.publicationCollectorState.update({
          where: { id: "distributed-readback" },
          data: { dailyLimit: beforeState.dailyLimit },
        });
      } else {
        await db.publicationCollectorState.deleteMany({ where: { id: "distributed-readback" } });
      }
      if (beforeKeys === undefined) delete process.env.PUBLICATION_READBACK_NODE_KEYS_JSON;
      else process.env.PUBLICATION_READBACK_NODE_KEYS_JSON = beforeKeys;
    }
  });

  it("schedules 24-hour API readback, leases to one of two nodes and saves exact metric totals", async () => {
    process.env.PUBLICATION_READBACK_ENABLED = "true";
    process.env.PUBLICATION_READBACK_NODE_KEYS_JSON = JSON.stringify({
      [readbackNodeId]: readbackKey,
      [readbackSecondaryId]: readbackSecondaryKey,
    });
    const day = new Date().toISOString().slice(0, 10);
    const previousBudget = await db.publicationReadbackBudget.findUnique({ where: { day } });
    try {
      const task = requiredAt(taskFixtures, 8);
      const submit = await request(`/employee/tasks/${task.id}/submissions`, {
        method: "POST",
        token: task.token,
        body: { url: "https://www.xiaohongshu.com/explore/readbacktest009?xsec_token=private" },
      });
      expect(submit.status).toBe(201);
      expect(JSON.stringify(submit.body)).not.toContain("private");
      const submissionId = String(record(submit.body).submissionId);
      const jobs = await db.publicationCollectionJob.findMany({ where: { submissionId } });
      expect(jobs).toHaveLength(1);
      const job = requiredAt(jobs, 0);
      expect(job.kind).toBe("READBACK");
      expect(job.dueAt.getTime() - job.createdAt.getTime()).toBeGreaterThan(23 * 60 * 60_000);
      const premature = await signed(`${READBACK_PREFIX}/claim`, {
        method: "POST",
        body: { limit: 1 },
        readback: true,
      });
      expect(record(premature.body).job).toBeNull();
      await db.publicationCollectionJob.update({
        data: { dueAt: new Date(Date.now() - 3000) },
        where: { id: job.id },
      });
      const claims = await Promise.all([
        signed(`${READBACK_PREFIX}/claim`, { method: "POST", body: { limit: 1 }, readback: true }),
        signed(`${READBACK_PREFIX}/claim`, {
          method: "POST",
          body: { limit: 1 },
          readback: true,
          readbackSecondary: true,
        }),
      ]);
      expect(claims.map((result) => result.status)).toEqual([201, 201]);
      const leases = claims.map((result) => record(result.body).job).filter(Boolean);
      expect(leases).toHaveLength(1);
      const lease = record(leases[0]);
      const ownerIsSecondary = Boolean(record(claims[1]?.body).job);
      expect(lease.noteId).toBe("readbacktest009");
      expect(JSON.stringify(lease)).not.toContain("private");
      const data = {
        leaseToken: lease.leaseToken,
        source: "COMPATIBLE_API_V1",
        status: "AVAILABLE",
        code: "NOTE_AVAILABLE",
        observedAt: new Date().toISOString(),
        note: {
          noteId: "readbacktest009",
          title: task.title,
          body: task.body,
          imageCount: 1,
          likes: 0,
          comments: 5,
          favorites: 2,
          hashtags: ["验真"],
        },
      };
      const wrongNote = await signed(`${READBACK_PREFIX}/${job.id}/result`, {
        method: "POST",
        body: { ...data, note: { ...data.note, noteId: "wrongnote009" } },
        readback: true,
        readbackSecondary: ownerIsSecondary,
      });
      expect(wrongNote.status).toBe(409);
      const accepted = await signed(`${READBACK_PREFIX}/${job.id}/result`, {
        method: "POST",
        body: data,
        readback: true,
        readbackSecondary: ownerIsSecondary,
      });
      expect(accepted.status).toBe(201);
      expect(record(accepted.body).status).toBe("COMPLETED");
      expect(
        (await db.publishSubmission.findUniqueOrThrow({ where: { id: submissionId } })).status,
      ).toBe("VALID");
      const snapshot = await db.publishReadbackSnapshot.findUniqueOrThrow({
        where: { jobId: job.id },
      });
      expect([snapshot.likes, snapshot.comments, snapshot.favorites]).toEqual([0, 5, 2]);
      const operations = await signed(`${READBACK_PREFIX}/operations`, { readback: true });
      expect(operations.status).toBe(200);
      const operationsData = record(operations.body);
      expect(operationsData.completed).toBeGreaterThanOrEqual(1);
      expect(
        record((operationsData.jobs as unknown[]).find((entry) => record(entry).id === job.id))
          .status,
      ).toBe("COMPLETED");
      expect(JSON.stringify(operations.body)).not.toContain("private");
      expect(JSON.stringify(operations.body)).not.toContain(task.body);
      expect(await db.publishMetricSnapshot.count({ where: { registry: { submissionId } } })).toBe(
        1,
      );
      expect((await db.distributionTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
        "COMPLETED",
      );
      const replay = await signed(`${READBACK_PREFIX}/${job.id}/result`, {
        method: "POST",
        body: data,
        readback: true,
        readbackSecondary: ownerIsSecondary,
      });
      expect(replay.status).toBe(201);
      expect(record(replay.body).alreadyAccepted).toBe(true);
      const conflicting = await signed(`${READBACK_PREFIX}/${job.id}/result`, {
        method: "POST",
        body: { ...data, note: { ...data.note, comments: 999 } },
        readback: true,
        readbackSecondary: ownerIsSecondary,
      });
      expect(conflicting.status).toBe(409);
    } finally {
      if (previousBudget) {
        await db.publicationReadbackBudget.update({
          data: { used: previousBudget.used },
          where: { day },
        });
      } else {
        await db.publicationReadbackBudget.deleteMany({ where: { day } });
      }
      if (previousReadbackEnabled === undefined) delete process.env.PUBLICATION_READBACK_ENABLED;
      else process.env.PUBLICATION_READBACK_ENABLED = previousReadbackEnabled;
      if (previousReadbackKeys === undefined)
        delete process.env.PUBLICATION_READBACK_NODE_KEYS_JSON;
      else process.env.PUBLICATION_READBACK_NODE_KEYS_JSON = previousReadbackKeys;
    }
  });

  it("quarantines unresolved short links without a paid request and pauses all nodes on supplier auth failure", async () => {
    process.env.PUBLICATION_READBACK_ENABLED = "true";
    process.env.PUBLICATION_READBACK_NODE_KEYS_JSON = JSON.stringify({
      [readbackNodeId]: readbackKey,
    });
    const day = new Date().toISOString().slice(0, 10);
    const previousBudget = await db.publicationReadbackBudget.findUnique({ where: { day } });
    const previousState = await db.publicationCollectorState.findUnique({
      where: { id: "distributed-readback" },
    });
    const shortResolution = vi
      .spyOn(publicationShortUrl, "resolvePublicationShortUrl")
      .mockRejectedValue(
        new publicationShortUrl.PublicationShortUrlError("SHORT_URL_TARGET_INVALID"),
      );
    try {
      const shortTask = requiredAt(taskFixtures, 9);
      const short = await request(`/employee/tasks/${shortTask.id}/submissions`, {
        method: "POST",
        token: shortTask.token,
        body: { url: "https://xhslink.com/FakeShortCode" },
      });
      expect(short.status).toBe(201);
      const shortJob = await db.publicationCollectionJob.findFirstOrThrow({
        where: { submissionId: String(record(short.body).submissionId) },
      });
      await db.publicationCollectionJob.update({
        data: { dueAt: new Date(Date.now() - 3000) },
        where: { id: shortJob.id },
      });
      const quarantined = await signed(`${READBACK_PREFIX}/claim`, {
        method: "POST",
        body: { limit: 1 },
        readback: true,
      });
      expect(record(quarantined.body).job).toBeNull();
      expect(
        (await db.publicationCollectionJob.findUniqueOrThrow({ where: { id: shortJob.id } }))
          .errorCode,
      ).toBe("SHORT_URL_TARGET_INVALID");
      expect(
        (await db.publishSubmission.findUniqueOrThrow({ where: { id: shortJob.submissionId } }))
          .status,
      ).toBe("MANUAL_REVIEW");
      const task = requiredAt(taskFixtures, 10);
      const submitted = await request(`/employee/tasks/${task.id}/submissions`, {
        method: "POST",
        token: task.token,
        body: { url: "https://www.xiaohongshu.com/explore/readbackauth012" },
      });
      expect(submitted.status).toBe(201);
      const job = await db.publicationCollectionJob.findFirstOrThrow({
        where: { submissionId: String(record(submitted.body).submissionId) },
      });
      await db.publicationCollectionJob.update({
        data: { dueAt: new Date(Date.now() - 3000) },
        where: { id: job.id },
      });
      const lease = record(
        record(
          (
            await signed(`${READBACK_PREFIX}/claim`, {
              method: "POST",
              body: { limit: 1 },
              readback: true,
            })
          ).body,
        ).job,
      );
      const auth = await signed(`${READBACK_PREFIX}/${job.id}/result`, {
        method: "POST",
        readback: true,
        body: {
          leaseToken: lease.leaseToken,
          source: "COMPATIBLE_API_V1",
          status: "AUTH_ERROR",
          code: "VENDOR_AUTH",
        },
      });
      expect(auth.status).toBe(201);
      expect(
        (await db.publishSubmission.findUniqueOrThrow({ where: { id: job.submissionId } })).status,
      ).toBe("VERIFYING");
      const paused = await signed(`${READBACK_PREFIX}/claim`, {
        method: "POST",
        body: { limit: 1 },
        readback: true,
      });
      expect(record(paused.body).paused).toBe(true);
      const resumed = await request("/platform/publication-readback/resume", {
        method: "POST",
        token: platformToken,
        body: { reason: "本地测试：认证已修复" },
      });
      expect(resumed.status).toBe(201);
      await db.publicationCollectionJob.update({
        data: { dueAt: new Date(Date.now() - 3000) },
        where: { id: job.id },
      });
      const renewed = await signed(`${READBACK_PREFIX}/claim`, {
        method: "POST",
        body: { limit: 1 },
        readback: true,
      });
      const leaseAfterResume = record(record(renewed.body).job);
      await db.publicationCollectionJob.update({
        data: { leaseExpiresAt: new Date(Date.now() - 1000) },
        where: { id: job.id },
      });
      const noDoubleCharge = await signed(`${READBACK_PREFIX}/claim`, {
        method: "POST",
        body: { limit: 1 },
        readback: true,
      });
      expect(record(noDoubleCharge.body).job).toBeNull();
      expect(
        (await db.publicationCollectionJob.findUniqueOrThrow({ where: { id: job.id } })).status,
      ).toBe("NEEDS_REVIEW");
      expect(
        (await db.publishSubmission.findUniqueOrThrow({ where: { id: job.submissionId } })).status,
      ).toBe("UNAVAILABLE");
      const late = await signed(`${READBACK_PREFIX}/${job.id}/result`, {
        method: "POST",
        readback: true,
        body: {
          leaseToken: leaseAfterResume.leaseToken,
          source: "COMPATIBLE_API_V1",
          status: "RETRYABLE",
          code: "VENDOR_TRANSIENT",
        },
      });
      expect(late.status).toBe(409);
    } finally {
      shortResolution.mockRestore();
      if (previousBudget) {
        await db.publicationReadbackBudget.update({
          data: { used: previousBudget.used },
          where: { day },
        });
      } else {
        await db.publicationReadbackBudget.deleteMany({ where: { day } });
      }
      if (previousState) {
        await db.publicationCollectorState.update({
          data: {
            pausedAt: previousState.pausedAt,
            pauseReason: previousState.pauseReason,
            resumedAt: previousState.resumedAt,
            lastSeenAt: previousState.lastSeenAt,
          },
          where: { id: "distributed-readback" },
        });
      } else {
        await db.publicationCollectorState.deleteMany({ where: { id: "distributed-readback" } });
      }
      if (previousReadbackEnabled === undefined) delete process.env.PUBLICATION_READBACK_ENABLED;
      else process.env.PUBLICATION_READBACK_ENABLED = previousReadbackEnabled;
      if (previousReadbackKeys === undefined)
        delete process.env.PUBLICATION_READBACK_NODE_KEYS_JSON;
      else process.env.PUBLICATION_READBACK_NODE_KEYS_JSON = previousReadbackKeys;
    }
  });

  it("keeps collected totals visible for review without falsely confirming unrelated copy", async () => {
    process.env.PUBLICATION_READBACK_ENABLED = "true";
    process.env.PUBLICATION_READBACK_NODE_KEYS_JSON = JSON.stringify({
      [readbackNodeId]: readbackKey,
    });
    const day = new Date().toISOString().slice(0, 10);
    const previousBudget = await db.publicationReadbackBudget.findUnique({ where: { day } });
    try {
      const task = requiredAt(taskFixtures, 11);
      const submit = await request(`/employee/tasks/${task.id}/submissions`, {
        method: "POST",
        token: task.token,
        body: { url: "https://www.xiaohongshu.com/explore/readbackmanual013" },
      });
      expect(submit.status).toBe(201);
      const submissionId = String(record(submit.body).submissionId);
      const job = await db.publicationCollectionJob.findFirstOrThrow({ where: { submissionId } });
      await db.publicationCollectionJob.update({
        data: { dueAt: new Date(Date.now() - 3000) },
        where: { id: job.id },
      });
      const assigned = await signed(`${READBACK_PREFIX}/claim`, {
        method: "POST",
        body: { limit: 1 },
        readback: true,
      });
      const lease = record(record(assigned.body).job);
      const result = await signed(`${READBACK_PREFIX}/${job.id}/result`, {
        method: "POST",
        readback: true,
        body: {
          leaseToken: lease.leaseToken,
          source: "COMPATIBLE_API_V1",
          status: "AVAILABLE",
          code: "NOTE_AVAILABLE",
          observedAt: new Date().toISOString(),
          note: {
            noteId: "readbackmanual013",
            title: "不相关内容",
            body: "完全不同的正文",
            imageCount: 1,
            likes: 0,
            comments: null,
            favorites: 4,
          },
        },
      });
      expect(result.status).toBe(201);
      expect(record(result.body).status).toBe("NEEDS_REVIEW");
      expect(
        (await db.publishSubmission.findUniqueOrThrow({ where: { id: submissionId } })).status,
      ).toBe("MANUAL_REVIEW");
      expect(await db.publishMetricSnapshot.count({ where: { registry: { submissionId } } })).toBe(
        0,
      );
      const reviews = await request(
        `/console/tenants/${tenantId}/enterprises/${enterpriseId}/publication-reviews`,
        { token: enterpriseToken },
      );
      expect(reviews.status).toBe(200);
      const item = (record(reviews.body).items as Record<string, unknown>[]).find(
        (row) => row.id === submissionId,
      );
      expect(record(item?.readback)).toMatchObject({ likes: 0, comments: null, favorites: 4 });
    } finally {
      if (previousBudget) {
        await db.publicationReadbackBudget.update({
          data: { used: previousBudget.used },
          where: { day },
        });
      } else {
        await db.publicationReadbackBudget.deleteMany({ where: { day } });
      }
      if (previousReadbackEnabled === undefined) delete process.env.PUBLICATION_READBACK_ENABLED;
      else process.env.PUBLICATION_READBACK_ENABLED = previousReadbackEnabled;
      if (previousReadbackKeys === undefined)
        delete process.env.PUBLICATION_READBACK_NODE_KEYS_JSON;
      else process.env.PUBLICATION_READBACK_NODE_KEYS_JSON = previousReadbackKeys;
    }
  });

  async function signed(
    path: string,
    options: {
      body?: unknown;
      method?: "GET" | "POST";
      nonce?: string;
      signatureBody?: unknown;
      signaturePath?: string;
      wrongSignature?: boolean;
      readback?: boolean;
      readbackSecondary?: boolean;
      panelHost?: string;
      panelUrl?: string;
    } = {},
  ) {
    const method = options.method ?? "GET";
    const payload = options.body === undefined ? "" : JSON.stringify(options.body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = options.nonce ?? randomUUID();
    nonceIds.push(nonce);
    const signedPayload =
      options.signatureBody === undefined ? payload : JSON.stringify(options.signatureBody);
    const digest = createHash("sha256").update(signedPayload).digest("hex");
    const signatureFields = [method, options.signaturePath ?? path, timestamp, nonce, digest];
    if (options.panelUrl !== undefined) signatureFields.push(options.panelUrl);
    const signature = createHmac(
      "sha256",
      options.readbackSecondary ? readbackSecondaryKey : options.readback ? readbackKey : key,
    )
      .update(signatureFields.join("\n"))
      .digest("hex");
    const headers = new Headers({
      "x-collector-id": options.readbackSecondary
        ? readbackSecondaryId
        : options.readback
          ? readbackNodeId
          : collectorId,
      "x-collector-timestamp": timestamp,
      "x-collector-request-id": nonce,
      "x-collector-signature": options.wrongSignature ? "0".repeat(64) : signature,
    });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.panelHost !== undefined) headers.set("x-collector-panel-host", options.panelHost);
    if (options.panelUrl !== undefined) headers.set("x-collector-panel-url", options.panelUrl);
    const response = await fetch(`${baseUrl}${path}`, {
      body: options.body === undefined ? undefined : payload,
      headers,
      method,
    });
    const text = await response.text();
    return { body: text ? JSON.parse(text) : null, status: response.status };
  }

  async function request(
    path: string,
    options: {
      body?: unknown;
      method?: "GET" | "POST";
      token?: string;
    } = {},
  ) {
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

  function phone(index: number): string {
    return `186${marker.replace(/\D/gu, "").slice(-7).padStart(7, "0")}${index}`;
  }
});

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("Expected response object");
  return value as Record<string, unknown>;
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (!value) throw new Error(`Expected test fixture at index ${index}`);
  return value;
}
