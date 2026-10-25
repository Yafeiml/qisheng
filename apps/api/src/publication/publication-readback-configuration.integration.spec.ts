import "reflect-metadata";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExecutionContext } from "@nestjs/common";
import { fetchNoteDetail } from "@xhs-agentic/xhs-api-collector";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import type { CampaignService } from "../campaign/campaign.service";
import type { ImageDeliveryService } from "../campaign/image-delivery.service";
import { PrismaService } from "../database/prisma.service";
import { seedRuntimePolicy } from "../model-configuration/runtime-policy.seed";
import { PlatformPublicationVerificationService } from "../platform-settings/platform-publication-verification.service";
import { PlatformSettingCrypto } from "../platform-settings/platform-setting-crypto";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { seedPlatformSettings } from "../platform-settings/platform-settings.seed";
import { PublicationReadbackConfigurationService } from "../platform-settings/publication-readback.configuration";
import type { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import { PublicationService } from "./publication.service";
import type { PublicationCollectorService } from "./publication-collector.service";
import { PublicationReadbackGuard } from "./publication-readback.guard";
import { PublicationReadbackService } from "./publication-readback.service";

vi.mock("@xhs-agentic/xhs-api-collector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xhs-agentic/xhs-api-collector")>()),
  fetchNoteDetail: vi.fn(),
}));

describe.skipIf(!process.env.DATABASE_URL)(
  "managed readback and manual publication with isolated PostgreSQL",
  () => {
    const endpoint = "https://api.example.com/notes/detail";
    const providerToken = randomBytes(40).toString("hex");
    const managedKey = randomBytes(40).toString("base64");
    let directory = "";
    let db: PrismaService;
    let configuration: PublicationReadbackConfigurationService;
    let publication: PublicationService;
    let readback: PublicationReadbackService;
    let access: RequestAccessContext;
    let administratorId: string;
    let campaignId: string;
    let enterpriseId: string;
    let tenantId: string;
    let employeeId: string;
    let membershipId: string;
    let submissionId: string;

    beforeAll(async () => {
      const name = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
      if (!/^dev_readback_[a-z0-9_]+$/u.test(name))
        throw new Error("Readback integration requires an isolated dev_readback_ database");
      directory = mkdtempSync(join(tmpdir(), "qisheng-readback-api-"));
      db = new PrismaService();
      vi.stubEnv("PUBLICATION_READBACK_ENABLED", "false");
      vi.stubEnv("QISHENG_RUNTIME_CONFIG", join(directory, "runtime.json"));
      vi.stubEnv("MODEL_CREDENTIAL_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
      vi.stubEnv("MODEL_CREDENTIAL_ENCRYPTION_KEY_VERSION", "readback-integration-v1");
      writeFileSync(join(directory, "readback-node-key"), managedKey, { mode: 0o600 });
      await db.$connect();
      await seedRuntimePolicy(db);
      await seedPlatformSettings(db);
      const administrator = await db.adminUser.create({
        data: { username: `owner-${randomUUID()}`, name: "回读集成管理员" },
      });
      administratorId = administrator.id;
      const tenant = await db.tenant.create({
        data: { name: "回读隔离企业", customerType: "SINGLE_ENTERPRISE" },
      });
      tenantId = tenant.id;
      const enterprise = await db.enterprise.create({
        data: { tenantId, name: "回读隔离企业", code: `RB_${randomUUID()}` },
      });
      enterpriseId = enterprise.id;
      const employee = await db.globalUser.create({
        data: { phone: "13800000989", phoneVerifiedAt: new Date() },
      });
      employeeId = employee.id;
      const membership = await db.enterpriseMembership.create({
        data: {
          tenantId,
          enterpriseId,
          globalUserId: employeeId,
          name: "回读隔离员工",
          phone: "13800000989",
          seatStatus: "ENABLED",
          status: "ACTIVE",
          boundAt: new Date(),
          seatEnabledAt: new Date(),
        },
      });
      membershipId = membership.id;
      const visibleAt = new Date(Date.now() - 60000);
      const expiresAt = new Date(visibleAt.getTime() + 86400000);
      const campaign = await db.campaign.create({
        data: {
          tenantId,
          enterpriseId,
          title: "人工复核隔离活动",
          prompt: "隔离回归测试",
          contentDirection: "门店日常",
          imageStyle: "实拍",
          createdBy: administratorId,
          approvedBy: administratorId,
          approvedAt: new Date(),
          audienceCount: 1,
          generatedCount: 1,
          imageCount: 1,
          status: "ACTIVE",
          visibleAt,
          expiresAt,
        },
      });
      campaignId = campaign.id;
      const snapshot = await db.campaignAudienceSnapshot.create({
        data: {
          tenantId,
          enterpriseId,
          campaignId,
          membershipId,
          employeeName: "回读隔离员工",
          employeePhone: "13800000989",
        },
      });
      const content = await db.employeeContent.create({
        data: {
          tenantId,
          enterpriseId,
          campaignId,
          membershipId,
          audienceSnapshotId: snapshot.id,
          title: "门店的一天",
          body: "我已确认这些是本人实际经历。",
          hashtags: [],
          imagePrompt: "无需生成图片",
          contentFingerprint: randomUUID(),
          riskAssessment: { passed: true },
          status: "APPROVED",
          synthetic: false,
        },
      });
      const task = await db.distributionTask.create({
        data: {
          tenantId,
          enterpriseId,
          campaignId,
          membershipId,
          employeeContentId: content.id,
          status: "AVAILABLE",
          visibleAt,
          expiresAt,
          factsConfirmedAt: new Date(),
          factsConfirmedRevision: content.revision,
        },
      });
      const principal = { userId: administratorId, scope: { type: "PLATFORM" } };
      access = {
        requireSaasAdmin: () => principal,
        requireEmployee: () => ({ userId: employeeId, membershipIds: [membershipId] }),
      } as unknown as RequestAccessContext;
      const crypto = new PlatformSettingCrypto();
      const reader = new PlatformSettingsReader(db, crypto);
      configuration = new PublicationReadbackConfigurationService(db, access, reader, crypto);
      const verifier = new PlatformPublicationVerificationService(
        db,
        access,
        reader,
        configuration,
      );
      publication = new PublicationService(
        db,
        access,
        {} as TenantCapabilityService,
        { reconcileEmployeeTasks: async () => undefined } as unknown as CampaignService,
        { signImages: async (images: unknown[]) => images } as unknown as ImageDeliveryService,
        verifier,
        reader,
        {} as PublicationCollectorService,
      );
      readback = new PublicationReadbackService(
        db,
        access,
        {} as TenantCapabilityService,
        configuration,
      );
      const submitted = await publication.submitEmployeePublication(task.id, {
        url: "https://www.xiaohongshu.com/explore/000000000000000000000001",
      });
      submissionId = submitted.submissionId;
      vi.mocked(fetchNoteDetail).mockResolvedValue({
        status: "AVAILABLE",
        note: {
          noteId: "000000000000000000000001",
          title: "门店的一天",
          body: "我已确认这些是本人实际经历。",
          authorId: null,
          publishedAt: null,
          imageCount: 0,
          hashtags: [],
          likes: 0,
          comments: 0,
          favorites: 0,
        },
      });
    });

    afterAll(async () => {
      await db?.$disconnect();
      vi.unstubAllEnvs();
      if (
        directory &&
        resolve(directory) === directory &&
        basename(directory).startsWith("qisheng-readback-api-")
      )
        rmSync(directory, { recursive: true });
    });

    it("stores a real link directly for manual review without a supplier call or automatic verification", async () => {
      expect(await configuration.configuration()).toMatchObject({
        enabled: false,
        endpoint: "",
        tokenConfigured: false,
        verified: false,
      });
      await expect(
        configuration.test("000000000000000000000001", "拒绝未配置的样本验证"),
      ).rejects.toThrow("请先保存笔记详情接口和 Token");
      const submission = await db.publishSubmission.findUniqueOrThrow({
        where: { id: submissionId },
        include: { task: true, collectionJobs: true },
      });
      expect(submission.status).toBe("MANUAL_REVIEW");
      expect(submission.verifiedAt).toBeNull();
      expect(submission.task.status).toBe("VERIFYING");
      expect(submission.collectionJobs).toEqual([]);
      expect(fetchNoteDetail).not.toHaveBeenCalled();
    });

    it("encrypts the provider credential and enables only after a matching sample", async () => {
      const saved = await configuration.save({
        enabled: false,
        endpoint,
        token: providerToken,
        reason: "隔离回读配置",
      });
      expect(saved.tokenConfigured).toBe(true);
      expect(JSON.stringify(saved)).not.toContain(providerToken);
      const credential = await db.platformSetting.findUniqueOrThrow({
        where: { key: "publication.readback_token" },
      });
      expect(credential.value).toBeNull();
      expect(credential.ciphertext?.byteLength).toBeGreaterThan(0);
      await expect(
        configuration.save({ enabled: true, endpoint, reason: "隔离测试启用" }),
      ).rejects.toThrow("样本验证");
      expect((await configuration.test("000000000000000000000001", "隔离样本验证")).success).toBe(
        true,
      );
      expect(
        await configuration.save({ enabled: true, endpoint, reason: "隔离测试启用" }),
      ).toMatchObject({ enabled: true, verified: true });
    });

    it("authenticates the real managed signature and keeps credentials off an external-node route", async () => {
      const guard = new PublicationReadbackGuard(db);
      const requestId = randomUUID();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = Buffer.from('{"limit":1}');
      const originalUrl = "/integrations/v1/publication-readback/claim-managed";
      const signed = [
        "POST",
        originalUrl,
        timestamp,
        requestId,
        createHash("sha256").update(body).digest("hex"),
      ].join("\n");
      const request = {
        method: "POST",
        originalUrl,
        rawBody: body,
        headers: {
          "x-collector-id": "selfhost-readback",
          "x-collector-timestamp": timestamp,
          "x-collector-request-id": requestId,
          "x-collector-signature": createHmac("sha256", managedKey).update(signed).digest("hex"),
        },
      };
      const context = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;
      expect(await guard.canActivate(context)).toBe(true);
      await expect(guard.canActivate(context)).rejects.toThrow("已处理");
      await expect(readback.claimManaged("external-node")).rejects.toThrow("同机回读节点");
      await db.publishSubmission.update({
        where: { id: submissionId },
        data: { status: "VERIFYING" },
      });
      await db.publicationCollectionJob.create({
        data: {
          kind: "READBACK",
          submissionId,
          dueAt: new Date(Date.now() - 60000),
          windowHours: 24,
        },
      });
      const claimed = await readback.claimManaged("selfhost-readback");
      expect(claimed.job).not.toBeNull();
      expect(claimed.provider?.token).toBe(providerToken);
      expect(JSON.stringify(await readback.operations())).not.toContain(providerToken);
      expect(await readback.claim("external-node")).not.toHaveProperty("provider");
    });

    it("returns queued jobs to manual review, preserves delivered leases and refunds a late losing claim", async () => {
      const original = await db.publishSubmission.findUniqueOrThrow({
        where: { id: submissionId },
      });
      const { id: _id, ...data } = original;
      const leased = await db.publicationCollectionJob.findFirstOrThrow({
        where: { submissionId, status: "LEASED" },
      });
      const queuedSubmission = await db.publishSubmission.create({
        data: { ...data, verificationAttempt: 2, status: "VERIFYING" },
      });
      const queued = await db.publicationCollectionJob.create({
        data: {
          submissionId: queuedSubmission.id,
          kind: "READBACK",
          windowHours: 24,
          dueAt: new Date(Date.now() - 60000),
        },
      });
      await configuration.save({ enabled: false, endpoint, reason: "切换人工复核测试" });
      expect(
        await db.publicationCollectionJob.findUniqueOrThrow({ where: { id: leased.id } }),
      ).toEqual(leased);
      expect(
        (await db.publicationCollectionJob.findUniqueOrThrow({ where: { id: queued.id } })).status,
      ).toBe("NEEDS_REVIEW");
      expect(
        (await db.publishSubmission.findUniqueOrThrow({ where: { id: queuedSubmission.id } }))
          .status,
      ).toBe("MANUAL_REVIEW");
      await configuration.save({ enabled: true, endpoint, reason: "恢复回读测试并发" });
      const lateSubmission = await db.publishSubmission.create({
        data: { ...data, verificationAttempt: 3, status: "VERIFYING" },
      });
      await db.publicationCollectionJob.create({
        data: {
          submissionId: lateSubmission.id,
          kind: "READBACK",
          windowHours: 24,
          dueAt: new Date(Date.now() - 60000),
        },
      });
      const day = new Date().toISOString().slice(0, 10);
      const budget = await db.publicationReadbackBudget.findUniqueOrThrow({ where: { day } });
      const contender = new PrismaService();
      try {
        const transaction = contender.$transaction.bind(contender);
        vi.spyOn(contender, "$transaction").mockImplementationOnce(async (callback) => {
          await configuration.save({ enabled: false, endpoint, reason: "先停用再竞争领取" });
          return transaction(callback);
        });
        const late = new PublicationReadbackService(
          contender,
          access,
          {} as TenantCapabilityService,
          configuration,
        );
        expect((await late.claim("external-node")).job).toBeNull();
      } finally {
        await contender.$disconnect();
      }
      expect((await db.publicationReadbackBudget.findUniqueOrThrow({ where: { day } })).used).toBe(
        budget.used,
      );
      expect(
        (await db.publishSubmission.findUniqueOrThrow({ where: { id: lateSubmission.id } })).status,
      ).toBe("MANUAL_REVIEW");
    });

    it("settles a delivered failure into manual review after disabling without another paid attempt", async () => {
      const leased = await db.publicationCollectionJob.findFirstOrThrow({
        where: { submissionId, status: "LEASED" },
      });
      const budget = await db.publicationReadbackBudget.findMany();
      expect(
        await readback.result(leased.leaseOwner ?? "", leased.id, {
          leaseToken: leased.leaseToken ?? "",
          status: "AUTH_ERROR",
          code: "HTTP_AUTH",
          source: "TEST_PROVIDER",
        }),
      ).toEqual({ status: "NEEDS_REVIEW" });
      expect(
        (await db.publicationCollectionJob.findUniqueOrThrow({ where: { id: leased.id } })).status,
      ).toBe("NEEDS_REVIEW");
      expect(
        (await db.publishSubmission.findUniqueOrThrow({ where: { id: submissionId } })).status,
      ).toBe("MANUAL_REVIEW");
      expect(await db.publicationReadbackBudget.findMany()).toEqual(budget);
      expect(
        (await db.publicationCollectorState.findUnique({ where: { id: "distributed-readback" } }))
          ?.pauseReason,
      ).not.toBe("PROVIDER_AUTH_ERROR");
    });

    it("recovers expired leases in the normal scoped manual-review list while preserving active leases", async () => {
      const { id: _id, ...base } = await db.publishSubmission.findUniqueOrThrow({
        where: { id: submissionId },
      });
      const expiredSubmission = await db.publishSubmission.create({
        data: { ...base, verificationAttempt: 4, status: "VERIFYING" },
      });
      const activeSubmission = await db.publishSubmission.create({
        data: { ...base, verificationAttempt: 5, status: "VERIFYING" },
      });
      const createLease = async (id: string, expiresAt: Date) =>
        db.publicationCollectionJob.create({
          data: {
            submissionId: id,
            kind: "READBACK",
            status: "LEASED",
            windowHours: 24,
            attempts: 1,
            leaseOwner: "selfhost-readback",
            leaseToken: randomUUID(),
            leaseExpiresAt: expiresAt,
            dueAt: new Date(Date.now() - 60000),
          },
        });
      const expired = await createLease(expiredSubmission.id, new Date(Date.now() - 1000));
      const active = await createLease(activeSubmission.id, new Date(Date.now() + 300000));
      const context = vi.spyOn(access, "requireSaasAdmin");
      try {
        context.mockReturnValue({
          userId: administratorId,
          scope: { type: "ENTERPRISE", tenantId, enterpriseId: "unrelated-enterprise" },
        } as ReturnType<RequestAccessContext["requireSaasAdmin"]>);
        await publication.listManualReviews(
          { tenantId, enterpriseId: "unrelated-enterprise" },
          { limit: 100 },
        );
        expect(
          (await db.publicationCollectionJob.findUniqueOrThrow({ where: { id: expired.id } }))
            .status,
        ).toBe("LEASED");
        context.mockReturnValue({
          userId: administratorId,
          scope: { type: "ENTERPRISE", tenantId, enterpriseId },
        } as ReturnType<RequestAccessContext["requireSaasAdmin"]>);
        const page = await publication.listManualReviews(
          { tenantId, enterpriseId },
          { limit: 100 },
        );
        expect(
          page.items.some(
            (item) => item.id === expiredSubmission.id && item.status === "MANUAL_REVIEW",
          ),
        ).toBe(true);
        expect(
          (await db.publicationCollectionJob.findUniqueOrThrow({ where: { id: expired.id } }))
            .errorCode,
        ).toBe("LEASE_OUTCOME_UNKNOWN");
        expect(
          await db.publicationCollectionJob.findUniqueOrThrow({ where: { id: active.id } }),
        ).toEqual(active);
        await publication.listManualReviews({ tenantId, enterpriseId }, { limit: 100 });
        expect(
          await db.publicationCollectionJob.findUniqueOrThrow({ where: { id: active.id } }),
        ).toEqual(active);
      } finally {
        context.mockRestore();
      }
    });

    it("does not reuse a historical success after the same sample subsequently fails", async () => {
      vi.mocked(fetchNoteDetail).mockResolvedValueOnce({ status: "AUTH_ERROR", code: "HTTP_AUTH" });
      expect((await configuration.test("000000000000000000000001", "隔离失败样本")).success).toBe(
        false,
      );
      expect((await configuration.configuration()).verified).toBe(false);
      await expect(
        configuration.save({ enabled: true, endpoint, reason: "隔离失败后启用" }),
      ).rejects.toThrow("样本验证");
      await configuration.save({ enabled: false, endpoint, reason: "隔离测试停用" });
    });

    it("allows disabling an unreadable optional credential without exposing or overwriting it", async () => {
      const before = await db.platformSetting.update({
        where: { key: "publication.readback_token" },
        data: { ciphertext: new Uint8Array([1, 2, 3]) },
      });
      expect(
        await configuration.save({ enabled: false, endpoint, reason: "关闭损坏的回读配置" }),
      ).toMatchObject({ enabled: false, verified: false, tokenConfigured: true });
      const after = await db.platformSetting.findUniqueOrThrow({
        where: { key: "publication.readback_token" },
      });
      expect(after.ciphertext).toEqual(before.ciphertext);
      expect((await readback.status()).reason).toBe("READBACK_DISABLED");
    });
  },
);
