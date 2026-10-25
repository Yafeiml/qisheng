import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  defaultGenerationStyles,
  type GenerationStyleSnapshot,
  type MedicalPlan,
  ModelCredentialCipher,
  modelCredentialAssociatedData,
  modelCredentialLastFour,
} from "@xhs-agentic/ai-gateway";
import { ContentSafetyInvocationError } from "@xhs-agentic/content-safety";
import { type Prisma, PrismaClient } from "@xhs-agentic/database";
import { MemoryObjectStorage } from "@xhs-agentic/object-storage";
import * as observability from "@xhs-agentic/observability";
import type { Queue } from "bullmq";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { classifyGenerationError, GenerationLeaseLostError } from "./generation-execution";
import {
  type EmployeeJob,
  GenerationReconciler,
  type OrchestrateJob,
} from "./generation-reconciler";
import { GenerationRuntime } from "./generation-runtime";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

const TEST_API_KEY = "local-worker-protocol-test-key";

describe("real provider generation runtime", { concurrent: false }, () => {
  it("executes frozen medical question cards for two employees, shares truthful rendered assets, and makes no image-model invocation", async () => {
    assertDevelopmentDatabase();
    const marker = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    const prisma = new PrismaClient();
    const provider = await startProtocolProvider();
    await prisma.$connect();
    try {
      const fixture = await createFixture(prisma, marker, provider.baseUrl);
      const run = await prisma.generationRun.findUniqueOrThrow({
        where: { id: fixture.generationRunId },
      });
      const workItems = await prisma.generationWorkItem.findMany({
        where: { generationRunId: run.id },
        orderBy: { createdAt: "asc" },
      });
      const medicalPlan: MedicalPlan = {
        schemaVersion: "medical-selection-v1",
        executionVersion: "medical-plan-v1",
        objective: "GEO_AND_TRANSACTION",
        priority: "BALANCED",
        topicIds: ["q"],
        readerSituation: "FIRST_UNDERSTANDING",
        noteForm: "QUESTION_LIST",
        imageMode: "QUESTION_CARD",
        conversionPath: "NONE",
        topics: [
          {
            id: "q",
            seriesId: "s",
            version: 1,
            question: "初次了解要确认哪些问题？",
            intent: "准备",
            entityId: "",
            entityName: "",
          },
        ],
        publishers: workItems.map((item) => ({
          membershipId: item.membershipId,
          publisherContext: {
            schemaVersion: "medical-publisher-v1",
            category: "ORDINARY",
            allowBrandAttribution: false,
            allowPlatformConsultation: false,
          },
        })),
        frozenAt: new Date().toISOString(),
      };
      await prisma.generationRun.update({
        where: { id: run.id },
        data: {
          generationInput: {
            ...asRecord(run.generationInput),
            medicalPlan,
          } as Prisma.InputJsonValue,
        },
      });
      await prisma.campaign.update({
        where: { id: fixture.campaignId },
        data: { imageCount: 5, selectionSnapshot: medicalPlan as unknown as Prisma.InputJsonValue },
      });
      const frozenRoute = asRecord(run.routingPolicy);
      const imageModelId = String(asRecord(asRecord(frozenRoute.image).primary).modelId);
      await prisma.modelDefinition.update({
        where: { id: imageModelId },
        data: { status: "DISABLED" },
      });
      const scan = vi.fn().mockImplementation(async () => ({
        decision: "PASS",
        categories: [],
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
        provider: "local-test",
        providerRequestId: randomUUID(),
      }));
      const runtime = new GenerationRuntime(prisma, new MemoryObjectStorage(), {
        contentSafetyScanner: { scan },
        requireContentSafety: true,
      });
      const runLease = await runtime.claimRun(run.id, fixture.tenantId, 1, "medical-test");
      expect(runLease).not.toBeNull();
      await runtime.prepareRun(requiredFixture(runLease ?? undefined));
      for (const item of workItems) {
        const lease = await runtime.claimWorkItem(item.id, fixture.tenantId, 1, "medical-test");
        await runtime.generateWorkItem(requiredFixture(lease ?? undefined));
      }
      expect(provider.requests.filter((request) => request.path.includes("/images/"))).toHaveLength(
        0,
      );
      const imageCalls = await prisma.modelInvocation.count({
        where: { generationRunId: run.id, kind: "EMPLOYEE_IMAGE" },
      });
      expect(imageCalls).toBe(0);
      const images = await prisma.generatedImage.findMany({
        where: { campaignId: fixture.campaignId },
      });
      expect(images).toHaveLength(6);
      expect(
        images.every((image) => image.provider === "LOCAL" && image.model === "QUESTION_CARD"),
      ).toBe(true);
      const covers = images.filter((image) => image.sequence === 1);
      expect(covers[0]?.checksum).toBe(covers[1]?.checksum);
      expect(new Set(images.map((image) => image.checksum)).size).toBe(3);
      expect(scan).toHaveBeenCalledTimes(2);
      expect(scan.mock.calls[0]?.[0]).toMatchObject({
        publishingContext: { category: "ORDINARY", verified: false, conversionPath: "NONE" },
        images: [{ checksum: covers[0]?.checksum }, { sequence: 2 }, { sequence: 3 }],
      });
    } finally {
      try {
        await cleanupFixture(prisma, marker);
      } finally {
        await prisma.$disconnect();
        await provider.close();
      }
    }
  });

  it.each([false, true])(
    "passes references but not logos to image edits, then reviews once; automatic logo = %s",
    async (multipleLogos) => {
      assertDevelopmentDatabase();
      const marker = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
      const prisma = new PrismaClient();
      const provider = await startProtocolProvider();
      await prisma.$connect();
      try {
        const fixture = await createFixture(prisma, marker, provider.baseUrl);
        const storage = new MemoryObjectStorage();
        const material = await prisma.material.create({
          data: {
            tenantId: fixture.tenantId,
            scopeKey: "__tenant__",
            title: "品牌图片",
            content: "测试参考图",
            type: "IMAGE_REFERENCE",
            createdBy: "runtime-test",
            authorizationStatus: "AUTHORIZED",
          },
        });
        const imageAssets = [];
        const sources = [
          { usage: "REFERENCE" as const, background: "#194fce" },
          ...(multipleLogos ? [{ usage: "LOGO" as const, background: "#00000000" }] : []),
          { usage: "LOGO" as const, background: "#17a465" },
        ];
        for (const [index, { usage, background }] of sources.entries()) {
          const bytes = await sharp({
            create: {
              width: 12,
              height: 8,
              channels: 4,
              background,
            },
          })
            .png()
            .toBuffer();
          const checksum = createHash("sha256").update(bytes).digest("hex");
          const objectKey = `test/${fixture.tenantId}/${usage}-${index}.png`;
          await storage.put({ key: objectKey, bytes, checksum, mimeType: "image/png" });
          const artifact = await prisma.materialArtifact.create({
            data: {
              materialId: material.id,
              tenantId: fixture.tenantId,
              scopeKey: "__tenant__",
              kind: "IMAGE_SOURCE",
              status: "VERIFIED",
              mimeType: "image/png",
              byteSize: bytes.length,
              checksum,
              objectKey,
            },
          });
          imageAssets.push({
            artifactId: artifact.id,
            materialId: material.id,
            checksum,
            objectKey,
            mimeType: "image/png",
            description: usage === "LOGO" ? "原始企业标识" : "真实参考图",
            usage,
          });
        }
        const run = await prisma.generationRun.findUniqueOrThrow({
          where: { id: fixture.generationRunId },
        });
        await prisma.generationRun.update({
          where: { id: run.id },
          data: {
            generationInput: {
              ...asRecord(run.generationInput),
              imageAssets,
            } as Prisma.InputJsonValue,
          },
        });
        let reviews = 0;
        let reviewedPixel: number[] = [];
        let reviewedImageCount = 0;
        const runtime = new GenerationRuntime(prisma, storage, {
          contentSafetyScanner: {
            async scan(input) {
              reviews++;
              reviewedImageCount = input.images.length;
              const pixels = await sharp(input.images[0]?.bytes)
                .extract({ left: 43, top: 58, width: 12, height: 8 })
                .removeAlpha()
                .raw()
                .toBuffer();
              reviewedPixel = [...pixels.subarray(0, 3)];
              throw new Error("审核接口暂不可用");
            },
          },
        });
        const runLease = await runtime.claimRun(run.id, fixture.tenantId, 1, "poster-test");
        if (!runLease) throw new Error("Missing run lease");
        const work = (await runtime.prepareRun(runLease))[0];
        if (!work) throw new Error("Missing work item");
        const lease = await runtime.claimWorkItem(
          work.id,
          fixture.tenantId,
          work.queueVersion,
          "poster-test",
        );
        if (!lease) throw new Error("Missing work lease");
        await runtime.generateWorkItem(lease).catch((error: unknown) => {
          throw new Error(
            JSON.stringify({
              attempts: asRecord(error).attempts,
              requests: provider.requests.map(({ path, referenceCount }) => ({
                path,
                referenceCount,
              })),
            }),
          );
        });
        expect(reviews).toBe(1);
        expect(reviewedImageCount).toBe(1);
        expect(reviewedPixel).toEqual([23, 164, 101]);
        expect(
          provider.requests.filter((request) => request.path === "/v1/images/edits"),
        ).toHaveLength(1);
        expect(
          provider.requests.find((request) => request.path === "/v1/images/edits")?.referenceCount,
        ).toBe(1);
        expect(provider.requests.some((request) => request.path === "/v1/images/generations")).toBe(
          false,
        );
        expect(
          await prisma.employeeContent.findFirstOrThrow({
            where: { campaignId: fixture.campaignId },
          }),
        ).toMatchObject({ status: "REVIEW_BLOCKED" });
        expect(
          await prisma.generationWorkItem.findUniqueOrThrow({ where: { id: work.id } }),
        ).toMatchObject({ status: "SUCCEEDED", attemptCount: 1 });
      } finally {
        try {
          await cleanupFixture(prisma, marker);
        } finally {
          await Promise.all([provider.close(), prisma.$disconnect()]);
        }
      }
    },
    30000,
  );

  it.each([
    [false, "BOTH"],
    [true, "COPY"],
    [true, "IMAGE"],
  ] as const)(
    "executes a database-frozen route with style = %s and paid %s regeneration",
    async (styled, target) => {
      const defaults = defaultGenerationStyles();
      const generationStyle: GenerationStyleSnapshot | undefined = styled
        ? {
            schemaVersion: 1,
            configurationVersion: 7,
            copyBasePrompt: "FROZEN_COPY_V1 文案基础风格",
            imageBasePrompt: "FROZEN_IMAGE_V1 图片基础风格",
            contentDirection: requiredFixture(defaults.contentDirections[0]),
            imageStyle: requiredFixture(defaults.imageStyles[0]),
          }
        : undefined;
      assertDevelopmentDatabase();
      const marker = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
      const prisma = new PrismaClient();
      const provider = await startProtocolProvider();
      await prisma.$connect();
      try {
        const fixture = await createFixture(prisma, marker, provider.baseUrl, generationStyle);
        if (generationStyle) {
          generationStyle.copyBasePrompt = "UPDATED_COPY_V2";
          generationStyle.imageBasePrompt = "UPDATED_IMAGE_V2";
        }
        const storage = new MemoryObjectStorage();
        const safetyRequests: string[] = [];
        const safetyImageChecksums: string[][] = [];
        const runtime = new GenerationRuntime(prisma, storage, {
          contentSafetyScanner: {
            async scan(input) {
              safetyRequests.push(input.requestId);
              safetyImageChecksums.push(input.images.map(({ checksum }) => checksum));
              const review = safetyRequests.length === 1;
              return {
                categories: review
                  ? [
                      {
                        code: "MEDICAL_CLAIM",
                        decision: "REVIEW" as const,
                        message: "需要人工确认医疗表述",
                        score: 0.78,
                      },
                    ]
                  : [],
                checkedAt: new Date().toISOString(),
                decision: review ? ("REVIEW" as const) : ("PASS" as const),
                latencyMs: 2,
                model: "test-multimodal-safety-v1",
                provider: "TEST_CONTENT_SAFETY",
                providerRequestId: `safety-${safetyRequests.length}`,
              };
            },
          },
        });

        await expect(
          runtime.claimRun(randomUUID(), fixture.tenantId, 1, "runtime-test"),
        ).resolves.toBeNull();
        await expect(
          runtime.claimRun(fixture.generationRunId, "foreign-tenant", 1, "runtime-test"),
        ).rejects.toThrow("not found in its tenant");
        const runLease = await runtime.claimRun(
          fixture.generationRunId,
          fixture.tenantId,
          1,
          "runtime-test",
        );
        if (!runLease) throw new Error("Expected the generation run lease");
        const workItems = await runtime.prepareRun(runLease);
        expect(workItems).toHaveLength(2);
        for (const workItem of workItems) {
          const workLease = await runtime.claimWorkItem(
            workItem.id,
            fixture.tenantId,
            workItem.queueVersion,
            "runtime-test",
          );
          if (!workLease) throw new Error("Expected the generation work item lease");
          await runtime.generateWorkItem(workLease);
        }

        const [campaign, run, contents, images, tasks, invocations] = await Promise.all([
          prisma.campaign.findUniqueOrThrow({ where: { id: fixture.campaignId } }),
          prisma.generationRun.findUniqueOrThrow({ where: { id: fixture.generationRunId } }),
          prisma.employeeContent.findMany({
            orderBy: { createdAt: "asc" },
            where: { campaignId: fixture.campaignId },
          }),
          prisma.generatedImage.findMany({
            orderBy: { createdAt: "asc" },
            where: { campaignId: fixture.campaignId },
          }),
          prisma.distributionTask.findMany({ where: { campaignId: fixture.campaignId } }),
          prisma.modelInvocation.findMany({
            orderBy: { createdAt: "asc" },
            where: { generationRunId: fixture.generationRunId },
          }),
        ]);

        expect(campaign).toMatchObject({ generatedCount: 2, status: "REVIEW_PENDING" });
        expect(run).toMatchObject({
          completedCount: 2,
          failedCount: 0,
          status: "SUCCEEDED",
          synthetic: false,
        });
        expect(contents).toHaveLength(2);
        expect(contents.every((content) => !content.synthetic)).toBe(true);
        expect(contents.every((content) => !content.body.includes("绝对治愈"))).toBe(true);
        expect(
          contents.map(
            (content) =>
              (content.riskAssessment as { contentSafety?: { decision?: string } }).contentSafety
                ?.decision,
          ),
        ).toEqual(["REVIEW", "PASS"]);
        expect(contents.map(({ status }) => status)).toEqual(["REVIEW_BLOCKED", "GENERATED"]);
        expect(safetyRequests).toHaveLength(2);
        expect(new Set(contents.map((content) => content.contentFingerprint)).size).toBe(2);
        expect(images).toHaveLength(2);
        expect(images.every((image) => !image.synthetic)).toBe(true);
        expect(images.every((image) => image.mimeType === "image/png")).toBe(true);
        expect(images.every((image) => image.width === 1080 && image.height === 1440)).toBe(true);
        expect(new Set(images.map((image) => image.checksum)).size).toBe(2);
        expect(new Set(images.map((image) => image.perceptualHash)).size).toBe(2);
        expect(tasks).toHaveLength(2);
        expect(tasks.every((task) => task.status === "LOCKED")).toBe(true);

        expect(invocations).toHaveLength(5);
        expect(invocations.every((invocation) => invocation.status === "SUCCEEDED")).toBe(true);
        expect(invocations.map((invocation) => invocation.kind)).toEqual([
          "CAMPAIGN_BLUEPRINT",
          "EMPLOYEE_COPY",
          "EMPLOYEE_IMAGE",
          "EMPLOYEE_COPY",
          "EMPLOYEE_IMAGE",
        ]);
        expect(
          invocations.every((invocation) => invocation.provider === fixture.providerCode),
        ).toBe(true);
        expect(invocations.every((invocation) => Boolean(invocation.providerRequestId))).toBe(true);
        expect(JSON.stringify(invocations)).not.toContain(TEST_API_KEY);
        expect(provider.requests).toHaveLength(5);
        expect(
          provider.requests.every((request) => request.authorization === `Bearer ${TEST_API_KEY}`),
        ).toBe(true);

        for (const image of images) {
          if (!image.storageKey) throw new Error("Expected a private storage key");
          expect(image.storageKey).not.toContain(fixture.employeePhonePrefix);
          const bytes = await storage.get(image.storageKey);
          if (!bytes) throw new Error("Expected generated image bytes in object storage");
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(image.checksum);
        }

        const succeededItem = await prisma.generationWorkItem.findFirstOrThrow({
          where: { generationRunId: fixture.generationRunId, status: "SUCCEEDED" },
        });
        const beforeReplay = await replaySnapshot(prisma, fixture.campaignId, fixture.tenantId);
        await expect(
          runtime.claimWorkItem(
            succeededItem.id,
            fixture.tenantId,
            succeededItem.queueVersion,
            "runtime-test-replay",
          ),
        ).resolves.toBeNull();
        const afterReplay = await replaySnapshot(prisma, fixture.campaignId, fixture.tenantId);
        expect(afterReplay).toEqual(beforeReplay);
        expect(provider.requests).toHaveLength(5);

        const contentBeforeReview = await prisma.employeeContent.findFirstOrThrow({
          include: { images: { orderBy: { sequence: "asc" } } },
          where: { membershipId: succeededItem.membershipId },
        });
        const reviewItem = await prepareReviewRegeneration(prisma, succeededItem.id, target);
        await prisma.employeeContent.update({
          data: {
            riskAssessment: {
              notices: [],
              passed: false,
              replacedBlocks: [],
              warnings: ["审核测试警告"],
            },
            status: "REVIEW_BLOCKED",
          },
          where: { id: contentBeforeReview.id },
        });
        const reviewLease = await runtime.claimWorkItem(
          reviewItem.id,
          fixture.tenantId,
          reviewItem.queueVersion,
          "runtime-review-regeneration",
        );
        if (!reviewLease) throw new Error("Expected review regeneration work item lease");
        await runtime.generateWorkItem(reviewLease);

        const [contentAfterReview, revision, tasksAfterReview] = await Promise.all([
          prisma.employeeContent.findUniqueOrThrow({
            include: { images: { orderBy: { sequence: "asc" } } },
            where: { id: contentBeforeReview.id },
          }),
          prisma.employeeContentRevision.findFirstOrThrow({
            where: { employeeContentId: contentBeforeReview.id },
          }),
          prisma.distributionTask.count({ where: { campaignId: fixture.campaignId } }),
        ]);
        expect(contentAfterReview).toMatchObject({ revision: 2, status: "GENERATED" });
        if (target === "IMAGE") {
          expect(contentAfterReview).toMatchObject({
            title: contentBeforeReview.title,
            body: contentBeforeReview.body,
            hashtags: contentBeforeReview.hashtags,
            contentFingerprint: contentBeforeReview.contentFingerprint,
          });
        } else expect(contentAfterReview.body).toContain("审核意见已落实");
        if (target === "COPY") {
          expect(contentAfterReview.images).toEqual(contentBeforeReview.images);
          expect(contentAfterReview.imagePrompt).toBe(contentBeforeReview.imagePrompt);
        } else {
          expect(contentAfterReview.images[0]?.checksum).not.toBe(
            contentBeforeReview.images[0]?.checksum,
          );
          expect(provider.requests.at(-1)?.prompt).toContain("本次图片修改要求");
        }
        expect(revision).toMatchObject({
          reviewFeedback: "减少技术承诺，补充术前评估和个体差异说明",
          revision: 1,
        });
        expect(tasksAfterReview).toBe(2);
        expect(provider.requests).toHaveLength(target === "BOTH" ? 7 : 6);
        expect(provider.requests.slice(5).map(({ path }) => path)).toEqual(
          target === "COPY"
            ? ["/v1/chat/completions"]
            : target === "IMAGE"
              ? ["/v1/images/generations"]
              : ["/v1/chat/completions", "/v1/images/generations"],
        );
        if (styled) {
          for (const request of provider.requests) {
            expect(request.prompt).toContain("FROZEN_INDUSTRY_V1");
            expect(request.prompt).toContain("专业设备和规范术前评估是已授权事实");
            expect(request.prompt).toContain(
              request.path.includes("chat/completions") ? "FROZEN_COPY_V1" : "FROZEN_IMAGE_V1",
            );
            expect(request.prompt).not.toContain("UPDATED_");
            expect(request.prompt).toContain("真实场景摄影");
          }
        }
        expect(safetyRequests).toHaveLength(3);
        expect(safetyImageChecksums.at(-1)).toEqual(
          contentAfterReview.images.map(({ checksum }) => checksum),
        );
        await expect(
          runtime.claimWorkItem(
            reviewItem.id,
            fixture.tenantId,
            reviewItem.queueVersion,
            "regeneration-replay",
          ),
        ).resolves.toBeNull();

        const failedReviewItem = await prepareReviewRegeneration(prisma, succeededItem.id, target);
        const failedLease = await runtime.claimWorkItem(
          failedReviewItem.id,
          fixture.tenantId,
          failedReviewItem.queueVersion,
          "regeneration-final-failure",
        );
        if (!failedLease) throw new Error("Expected failure test lease");
        await runtime.failWorkItem(failedLease, {
          code: "GENERATION_INPUT_INVALID",
          message: "Isolated final failure",
          retryable: false,
        });
        expect(
          await prisma.employeeContent.findUniqueOrThrow({
            include: { images: { orderBy: { sequence: "asc" } } },
            where: { id: contentBeforeReview.id },
          }),
        ).toEqual(contentAfterReview);
        await expect(
          runtime.failWorkItem(failedLease, {
            code: "GENERATION_INPUT_INVALID",
            message: "Failure replay",
            retryable: false,
          }),
        ).rejects.toBeInstanceOf(GenerationLeaseLostError);
      } finally {
        try {
          await cleanupFixture(prisma, marker);
        } finally {
          await Promise.all([provider.close(), prisma.$disconnect()]);
        }
      }
    },
    30_000,
  );

  it.each([
    "CONTENT_SAFETY_TIMEOUT",
    "CONTENT_SAFETY_INVALID_RESPONSE",
    "CONTENT_SAFETY_UNEXPECTED",
  ])(
    "records %s while preserving generated content without another paid request",
    async (code) => {
      assertDevelopmentDatabase();
      const marker = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
      const prisma = new PrismaClient();
      const provider = await startProtocolProvider();
      const log = vi.spyOn(observability, "writeStructuredLog").mockImplementation(() => {});
      await prisma.$connect();
      try {
        const fixture = await createFixture(prisma, marker, provider.baseUrl);
        const scan = vi.fn(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 8));
          if (code === "CONTENT_SAFETY_UNEXPECTED") throw new Error("private response body");
          throw new ContentSafetyInvocationError("审核未完成", code, code.endsWith("TIMEOUT"), {
            httpStatus: code.endsWith("TIMEOUT") ? undefined : 200,
            model: "review-model",
            provider: "REVIEW_VENDOR",
            providerRequestId: "review-receipt",
          });
        });
        const runtime = new GenerationRuntime(prisma, new MemoryObjectStorage(), {
          contentSafetyScanner: { scan },
          requireContentSafety: true,
        });
        const runLease = await runtime.claimRun(
          fixture.generationRunId,
          fixture.tenantId,
          1,
          "review-failure-test",
        );
        if (!runLease) throw new Error("Expected generation run lease");
        const items = await runtime.prepareRun(runLease);
        for (const item of items) {
          const lease = await runtime.claimWorkItem(
            item.id,
            fixture.tenantId,
            item.queueVersion,
            "review-failure-test",
          );
          if (!lease) throw new Error("Expected generation work item lease");
          await runtime.generateWorkItem(lease);
        }
        const contents = await prisma.employeeContent.findMany({
          where: { campaignId: fixture.campaignId },
          include: { images: true },
        });
        expect(contents).toHaveLength(2);
        for (const content of contents) {
          expect(content.status).toBe("REVIEW_BLOCKED");
          expect(content.images).toHaveLength(1);
          const risk = content.riskAssessment as {
            passed: boolean;
            warnings: string[];
            contentSafety: { latencyMs: number };
          };
          expect(risk.passed).toBe(false);
          expect(risk.warnings).toHaveLength(1);
          expect(risk.warnings[0]).toContain("REVIEW_UNAVAILABLE");
          expect(risk.contentSafety.latencyMs).toBeGreaterThan(0);
          expect(JSON.stringify(risk)).not.toContain(code);
          expect(JSON.stringify(risk)).not.toContain("private response body");
        }
        expect(scan).toHaveBeenCalledTimes(2);
        expect(provider.requests).toHaveLength(5);
        expect(log).toHaveBeenCalledTimes(2);
        expect(log.mock.calls[0]?.[0]).toMatchObject({
          event: "content-safety.review-unavailable",
          level: "warn",
          service: "worker",
          fields: {
            errorCode: code,
            attemptCount: 1,
            reservationVersion: 1,
            workItemId: items[0]?.id,
            requestId: expect.stringContaining(`work:${items[0]?.id}:v1:attempt:1:`),
          },
        });
        if (code !== "CONTENT_SAFETY_UNEXPECTED")
          expect(log.mock.calls[0]?.[0].fields).toMatchObject({
            model: "review-model",
            provider: "REVIEW_VENDOR",
            providerRequestId: "review-receipt",
          });
        expect(JSON.stringify(log.mock.calls)).not.toContain("private response body");
        expect(
          await prisma.campaign.findUniqueOrThrow({ where: { id: fixture.campaignId } }),
        ).toMatchObject({ status: "REVIEW_PENDING" });
      } finally {
        log.mockRestore();
        try {
          await cleanupFixture(prisma, marker);
        } finally {
          await Promise.all([provider.close(), prisma.$disconnect()]);
        }
      }
    },
    30_000,
  );

  it("fences an expired worker, recovers its durable item and settles quota only once", async () => {
    assertDevelopmentDatabase();
    const marker = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    const prisma = new PrismaClient();
    const provider = await startProtocolProvider();
    await prisma.$connect();
    try {
      const fixture = await createFixture(prisma, marker, provider.baseUrl);
      const storage = new MemoryObjectStorage();
      const runtime = new GenerationRuntime(prisma, storage, { leaseDurationMs: 60_000 });
      const runLease = await runtime.claimRun(
        fixture.generationRunId,
        fixture.tenantId,
        1,
        "worker-before-crash",
      );
      if (!runLease) throw new Error("Expected generation run lease");
      const workItems = await runtime.prepareRun(runLease);
      const first = workItems[0];
      if (!first) throw new Error("Expected generation work item");
      const staleLease = await runtime.claimWorkItem(
        first.id,
        fixture.tenantId,
        first.queueVersion,
        "worker-before-crash",
      );
      if (!staleLease) throw new Error("Expected initial work item lease");
      await prisma.generationWorkItem.update({
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
        where: { id: first.id },
      });

      const queuedJobs = new Map<string, unknown>();
      const queue = {
        add: async (_name: string, data: unknown, options: { jobId?: string }) => {
          if (options.jobId) queuedJobs.set(options.jobId, data);
          return {};
        },
        getJob: async (jobId: string) =>
          queuedJobs.has(jobId) ? { getState: async () => "waiting" } : null,
      } as unknown as Queue<OrchestrateJob | EmployeeJob>;
      const reconciler = new GenerationReconciler(prisma, queue, runtime);
      await expect(reconciler.reconcile()).resolves.toMatchObject({
        compensatedWorkItems: 2,
        recoveredWorkItems: 1,
      });

      await expect(runtime.generateWorkItem(staleLease)).rejects.toBeInstanceOf(
        GenerationLeaseLostError,
      );
      expect(provider.requests).toHaveLength(1);

      const recovered = await prisma.generationWorkItem.findUniqueOrThrow({
        where: { id: first.id },
      });
      const replacementLease = await runtime.claimWorkItem(
        first.id,
        fixture.tenantId,
        recovered.queueVersion,
        "worker-after-recovery",
      );
      if (!replacementLease) throw new Error("Expected replacement work item lease");
      await runtime.generateWorkItem(replacementLease);

      await expect(runtime.generateWorkItem(staleLease)).rejects.toBeInstanceOf(
        GenerationLeaseLostError,
      );
      const [contents, tasks, recoveredItem] = await Promise.all([
        prisma.employeeContent.count({
          where: { audienceSnapshotId: recovered.audienceSnapshotId },
        }),
        prisma.distributionTask.count({ where: { campaignId: fixture.campaignId } }),
        prisma.generationWorkItem.findUniqueOrThrow({ where: { id: first.id } }),
      ]);
      expect(contents).toBe(1);
      expect(tasks).toBe(1);
      expect(recoveredItem).toMatchObject({
        attemptCount: 2,
        queueVersion: 2,
        recoveryCount: 1,
        status: "SUCCEEDED",
      });
      expect(provider.requests).toHaveLength(3);

      const exhausted = workItems[1];
      if (!exhausted) throw new Error("Expected second generation work item");
      await prisma.generationWorkItem.update({
        data: { attemptCount: 6, maxAttempts: 6 },
        where: { id: exhausted.id },
      });
      await reconciler.reconcile();
      const [exhaustedItem, terminalRun] = await Promise.all([
        prisma.generationWorkItem.findUniqueOrThrow({ where: { id: exhausted.id } }),
        prisma.generationRun.findUniqueOrThrow({ where: { id: fixture.generationRunId } }),
      ]);
      expect(exhaustedItem).toMatchObject({
        errorCode: "MAX_ATTEMPTS_EXHAUSTED",
        status: "FAILED",
      });
      expect(terminalRun).toMatchObject({ completedCount: 1, failedCount: 1, status: "FAILED" });

      const recoveryAudit = await prisma.auditLog.findFirst({
        where: {
          action: "generation.work-item.lease-recovered",
          resourceId: first.id,
        },
      });
      expect(recoveryAudit).not.toBeNull();
    } finally {
      try {
        await cleanupFixture(prisma, marker);
      } finally {
        await Promise.all([provider.close(), prisma.$disconnect()]);
      }
    }
  }, 30_000);

  it("turns synthetic run and work-item execution into non-retryable production failures", async () => {
    assertDevelopmentDatabase();
    const prepareMarker = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    const workMarker = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    const prisma = new PrismaClient();
    const provider = await startProtocolProvider();
    const beforeMode = process.env.GENERATION_DELIVERY_MODE;
    await prisma.$connect();
    try {
      const prepareFixture = await createFixture(prisma, prepareMarker, provider.baseUrl);
      await prisma.generationRun.update({
        data: { synthetic: true },
        where: { id: prepareFixture.generationRunId },
      });
      const prepareRuntime = new GenerationRuntime(prisma, new MemoryObjectStorage());
      process.env.GENERATION_DELIVERY_MODE = "PRODUCTION";
      const runLease = await prepareRuntime.claimRun(
        prepareFixture.generationRunId,
        prepareFixture.tenantId,
        1,
        "production-boundary-run",
      );
      if (!runLease) throw new Error("Expected synthetic run lease");
      const runError = await captureError(() => prepareRuntime.prepareRun(runLease));
      const runFailure = classifyGenerationError(runError);
      expect(runFailure).toMatchObject({
        code: "SYNTHETIC_ROUTE_FORBIDDEN",
        retryable: false,
      });
      await prepareRuntime.failRun(runLease, runFailure);
      await expect(
        prisma.generationRun.findUniqueOrThrow({ where: { id: prepareFixture.generationRunId } }),
      ).resolves.toMatchObject({
        errorCode: "SYNTHETIC_ROUTE_FORBIDDEN",
        errorRetryable: false,
        status: "FAILED",
      });

      const workFixture = await createFixture(prisma, workMarker, provider.baseUrl);
      await prisma.generationRun.update({
        data: { synthetic: true },
        where: { id: workFixture.generationRunId },
      });
      const workRuntime = new GenerationRuntime(prisma, new MemoryObjectStorage());
      process.env.GENERATION_DELIVERY_MODE = "DEVELOPMENT";
      const preparationLease = await workRuntime.claimRun(
        workFixture.generationRunId,
        workFixture.tenantId,
        1,
        "development-prepare",
      );
      if (!preparationLease) throw new Error("Expected development preparation lease");
      const workItems = await workRuntime.prepareRun(preparationLease);
      const workItem = workItems[0];
      if (!workItem) throw new Error("Expected synthetic work item");

      process.env.GENERATION_DELIVERY_MODE = "PRODUCTION";
      const workLease = await workRuntime.claimWorkItem(
        workItem.id,
        workFixture.tenantId,
        workItem.queueVersion,
        "production-boundary-work-item",
      );
      if (!workLease) throw new Error("Expected synthetic work-item lease");
      const workError = await captureError(() => workRuntime.generateWorkItem(workLease));
      const workFailure = classifyGenerationError(workError);
      expect(workFailure).toMatchObject({
        code: "SYNTHETIC_ROUTE_FORBIDDEN",
        retryable: false,
      });
      await workRuntime.failWorkItem(workLease, workFailure);
      await expect(
        prisma.generationWorkItem.findUniqueOrThrow({ where: { id: workItem.id } }),
      ).resolves.toMatchObject({
        errorCode: "SYNTHETIC_ROUTE_FORBIDDEN",
        errorRetryable: false,
        status: "FAILED",
      });
      expect(provider.requests).toHaveLength(0);
    } finally {
      if (beforeMode === undefined) delete process.env.GENERATION_DELIVERY_MODE;
      else process.env.GENERATION_DELIVERY_MODE = beforeMode;
      try {
        await cleanupFixture(prisma, prepareMarker);
        await cleanupFixture(prisma, workMarker);
      } finally {
        await Promise.all([provider.close(), prisma.$disconnect()]);
      }
    }
  }, 30_000);
});

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}

async function createFixture(
  prisma: PrismaClient,
  marker: string,
  baseUrl: string,
  generationStyle?: GenerationStyleSnapshot,
) {
  const now = new Date();
  const tenant = await prisma.tenant.create({
    data: { customerType: "SINGLE_ENTERPRISE", name: `runtime-real-${marker}` },
  });
  const enterprise = await prisma.enterprise.create({
    data: {
      code: `REAL_${marker}`,
      name: `Runtime Real ${marker}`,
      tenantId: tenant.id,
    },
  });
  await prisma.tenantCapabilityPolicy.create({
    data: { storageLimitBytes: 100_000_000n, tenantId: tenant.id },
  });
  const employeePhonePrefix = `18${marker.replace(/\D/gu, "").padEnd(7, "0").slice(0, 7)}`;
  const memberships = await Promise.all(
    [1, 2].map((ordinal) =>
      prisma.enterpriseMembership.create({
        data: {
          employeeNo: `REAL-${ordinal}`,
          enterpriseId: enterprise.id,
          name: `真实路由测试员工 ${ordinal}`,
          phone: `${employeePhonePrefix}${ordinal}`,
          seatEnabledAt: now,
          seatStatus: "ENABLED",
          tenantId: tenant.id,
        },
      }),
    ),
  );
  const providerCode = `REAL_${marker}`;
  const modelProvider = await prisma.modelProvider.create({
    data: {
      baseUrl,
      code: providerCode,
      name: `Runtime Provider ${marker}`,
      protocol: "OPENAI_COMPATIBLE",
      synthetic: false,
      timeoutMs: 10_000,
    },
  });
  const credentialId = randomUUID();
  const encryptedCredential = ModelCredentialCipher.fromEnvironment().encrypt(
    TEST_API_KEY,
    modelCredentialAssociatedData(modelProvider.id, credentialId),
  );
  await prisma.modelProviderCredential.create({
    data: {
      authenticationTag: Buffer.from(encryptedCredential.authenticationTag),
      ciphertext: Buffer.from(encryptedCredential.ciphertext),
      createdBy: "runtime-integration-test",
      id: credentialId,
      initializationVector: Buffer.from(encryptedCredential.initializationVector),
      keyVersion: encryptedCredential.keyVersion,
      lastFour: modelCredentialLastFour(TEST_API_KEY),
      providerId: modelProvider.id,
    },
  });
  await prisma.modelProvider.update({
    data: { activeCredentialId: credentialId },
    where: { id: modelProvider.id },
  });
  const [textModel, imageModel] = await Promise.all([
    prisma.modelDefinition.create({
      data: {
        capabilities: ["TEXT"],
        code: `TEXT_${marker}`,
        displayName: "Runtime Text",
        externalModelId: `runtime-text-${marker.toLowerCase()}`,
        metadata: {
          inputCostPerMillionUnits: 1,
          outputCostPerMillionUnits: 2,
          tier: "STANDARD",
        },
        providerId: modelProvider.id,
        synthetic: false,
      },
    }),
    prisma.modelDefinition.create({
      data: {
        capabilities: ["IMAGE"],
        code: `IMAGE_${marker}`,
        displayName: "Runtime Image",
        externalModelId: `runtime-image-${marker.toLowerCase()}`,
        metadata: { imageCost: 0.12, tier: "STANDARD" },
        providerId: modelProvider.id,
        synthetic: false,
      },
    }),
  ]);
  const route = await prisma.modelRoute.create({
    data: {
      createdBy: "runtime-integration-test",
      enterpriseId: enterprise.id,
      imageModelId: imageModel.id,
      scopeId: enterprise.id,
      scopeType: "ENTERPRISE",
      tenantId: tenant.id,
      textModelId: textModel.id,
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      audienceCount: memberships.length,
      createdBy: "runtime-integration-test",
      enterpriseId: enterprise.id,
      expiresAt: new Date(now.getTime() + 25 * 60 * 60_000),
      imageCount: 1,
      prompt: "生成全飞秒 Pro 小红书风格科普，侧重设备和规范评估。",
      status: "GENERATING",
      tenantId: tenant.id,
      title: "真实 Provider 系统路径测试",
      visibleAt: new Date(now.getTime() + 60 * 60_000),
    },
  });
  const modelSnapshot = (model: typeof textModel) => ({
    externalModelId: model.externalModelId,
    modelId: model.id,
    modelUpdatedAt: model.updatedAt.toISOString(),
    providerCode,
    providerId: modelProvider.id,
    providerProtocol: modelProvider.protocol,
    providerUpdatedAt: modelProvider.updatedAt.toISOString(),
    synthetic: false,
    tier: "STANDARD",
  });
  const generationRun = await prisma.generationRun.create({
    data: {
      campaignId: campaign.id,
      generationInput: {
        ...(generationStyle
          ? {
              generationStyle,
              industryGuidance: {
                name: "医疗健康",
                generationGuidance:
                  "FROZEN_INDUSTRY_V1 核对准确身份与两三个事实，不扩大手术量口径。",
                updatedAt: now.toISOString(),
              },
            }
          : {}),
        geoSummary: "全飞秒 Pro 技术；规范评估服务",
        materialSummary: "专业设备和规范术前评估是已授权事实。",
        sensitiveRuleSummary: "禁止绝对治愈等绝对化承诺。",
        sensitiveRules: [
          {
            replacementSuggestion: "规范改善",
            riskType: "医疗绝对化",
            severity: "BLOCK",
            term: "绝对治愈",
          },
        ],
        sourceContext: { integrationTest: true },
      } as Prisma.InputJsonValue,
      imageModel: imageModel.externalModelId,
      imageProvider: providerCode,
      provider: providerCode,
      requestedCount: memberships.length,
      routingPolicy: {
        frozenAt: now.toISOString(),
        image: { fallbacks: [], primary: modelSnapshot(imageModel) },
        maxAttemptsPerModel: 2,
        routeId: route.id,
        routeUpdatedAt: route.updatedAt.toISOString(),
        scopeId: enterprise.id,
        scopeType: "ENTERPRISE",
        synthetic: false,
        text: { fallbacks: [], primary: modelSnapshot(textModel) },
      } as Prisma.InputJsonValue,
      status: "QUEUED",
      synthetic: false,
      tenantId: tenant.id,
      textModel: textModel.externalModelId,
      textProvider: providerCode,
    },
  });
  const snapshots = await Promise.all(
    memberships.map((membership) =>
      prisma.campaignAudienceSnapshot.create({
        data: {
          campaignId: campaign.id,
          employeeName: membership.name,
          employeePhone: membership.phone,
          enterpriseId: enterprise.id,
          membershipId: membership.id,
          tenantId: tenant.id,
        },
      }),
    ),
  );
  await prisma.generationWorkItem.createMany({
    data: snapshots.map((snapshot) => ({
      audienceSnapshotId: snapshot.id,
      campaignId: campaign.id,
      enterpriseId: enterprise.id,
      generationRunId: generationRun.id,
      membershipId: snapshot.membershipId,
      tenantId: tenant.id,
    })),
  });
  return {
    campaignId: campaign.id,
    employeePhonePrefix,
    generationRunId: generationRun.id,
    providerCode,
    tenantId: tenant.id,
  };
}

async function replaySnapshot(prisma: PrismaClient, campaignId: string, tenantId: string) {
  const [contents, images, tasks] = await Promise.all([
    prisma.employeeContent.count({ where: { campaignId, tenantId } }),
    prisma.generatedImage.count({ where: { campaignId, tenantId } }),
    prisma.distributionTask.count({ where: { campaignId, tenantId } }),
  ]);
  return {
    contents,
    images,
    tasks,
  };
}

async function prepareReviewRegeneration(
  prisma: PrismaClient,
  itemId: string,
  target: "COPY" | "IMAGE" | "BOTH",
) {
  return prisma.$transaction(async (transaction) => {
    const before = await transaction.generationWorkItem.findUniqueOrThrow({
      include: { generationRun: true },
      where: { id: itemId },
    });
    const item = await transaction.generationWorkItem.update({
      where: { id: itemId },
      data: {
        attemptCount: 0,
        finishedAt: null,
        queueVersion: { increment: 1 },
        reservationVersion: { increment: 1 },
        reviewFeedback: "减少技术承诺，补充术前评估和个体差异说明",
        reviewRegenerationCount: { increment: 1 },
        startedAt: null,
        status: "QUEUED",
      },
    });
    const generationInput = before.generationRun.generationInput as Prisma.JsonObject;
    await transaction.generationRun.update({
      where: { id: before.generationRunId },
      data: {
        completedCount: 1,
        finishedAt: null,
        status: "RUNNING",
        generationInput: {
          ...generationInput,
          regenerationTargets: {
            ...((generationInput.regenerationTargets as Prisma.JsonObject) ?? {}),
            [itemId]: target,
          },
        } as Prisma.InputJsonValue,
      },
    });
    await transaction.campaign.update({
      where: { id: before.campaignId },
      data: { generatedCount: 1, status: "GENERATING" },
    });
    return item;
  });
}

async function cleanupFixture(prisma: PrismaClient, marker: string): Promise<void> {
  const tenant = await prisma.tenant.findFirst({ where: { name: `runtime-real-${marker}` } });
  if (tenant) {
    await prisma.storageUsageLedger.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.storageReservation.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.tenantStorageAccount.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.modelInvocation.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.generatedImage.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.distributionTask.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.employeeContentRevision.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.employeeContent.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.generationWorkItem.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.generationRun.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.campaignBlueprint.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.campaignAudienceSnapshot.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.campaignPreflightSnapshot.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.campaign.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.materialArtifact.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.material.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.modelRouteQualification.deleteMany({
      where: { route: { tenantId: tenant.id } },
    });
    await prisma.modelRoute.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.enterpriseMembership.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.enterprise.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.tenantCapabilityPolicy.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.tenant.delete({ where: { id: tenant.id } });
  }
  const provider = await prisma.modelProvider.findUnique({ where: { code: `REAL_${marker}` } });
  if (provider) {
    await prisma.modelProviderInvocationLease.deleteMany({ where: { providerId: provider.id } });
    await prisma.modelDefinition.deleteMany({ where: { providerId: provider.id } });
    await prisma.modelProvider.update({
      data: { activeCredentialId: null },
      where: { id: provider.id },
    });
    await prisma.modelProviderCredential.deleteMany({ where: { providerId: provider.id } });
    await prisma.modelProvider.delete({ where: { id: provider.id } });
  }
}

async function startProtocolProvider(): Promise<{
  baseUrl: string;
  close(): Promise<void>;
  requests: Array<{
    authorization: string | undefined;
    path: string;
    prompt?: string;
    referenceCount?: number;
  }>;
}> {
  const requests: Array<{
    authorization: string | undefined;
    path: string;
    prompt?: string;
    referenceCount?: number;
  }> = [];
  const server = createServer((request, response) => {
    void handleProviderRequest(request, response, requests).catch((error: unknown) => {
      requests.push({ authorization: undefined, path: `fixture-error:${safeError(error)}` });
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { message: safeError(error) } }));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Protocol provider did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    requests,
  };
}

async function handleProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: Array<{
    authorization: string | undefined;
    path: string;
    prompt?: string;
    referenceCount?: number;
  }>,
): Promise<void> {
  const authorization = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization;
  const path = request.url ?? "";
  const captured: {
    authorization: string | undefined;
    path: string;
    prompt?: string;
    referenceCount?: number;
  } = {
    authorization,
    path,
  };
  requests.push(captured);
  if (authorization !== `Bearer ${TEST_API_KEY}`) {
    writeProviderJson(response, 401, { error: { code: "invalid_api_key" } });
    return;
  }
  if (request.method === "POST" && path === "/v1/images/edits") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const form = await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": request.headers["content-type"] ?? "" },
    }).formData();
    captured.prompt = String(form.get("prompt"));
    captured.referenceCount = form.getAll("image[]").length;
    writeProviderJson(response, 200, {
      data: [{ b64_json: (await imageForPrompt(captured.prompt)).toString("base64") }],
    });
    return;
  }
  const body = asRecord(JSON.parse(await readBody(request)) as unknown);
  if (request.method === "POST" && path === "/v1/chat/completions") {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const prompt = stringField(asRecord(messages[0]), "content");
    captured.prompt = prompt;
    const output =
      prompt.includes("活动母版生成器") || prompt.includes("医疗问题内容规划器")
        ? {
            imageDirection:
              "暖白与珊瑚红的小红书竖版技术科普海报，突出专业设备和规范评估，不展示患者个人信息。",
            masterCopy:
              "全飞秒 Pro 是值得理性了解的技术方向。传播时应说明专业设备、规范术前评估和个体差异，具体方案需要结合专业检查判断，不作绝对效果承诺。",
          }
        : employeeVariant(prompt);
    writeProviderJson(response, 200, {
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
      id: `text-${randomUUID()}`,
      usage: { completion_tokens: 80, prompt_tokens: 240 },
    });
    return;
  }
  if (request.method === "POST" && path === "/v1/images/generations") {
    const prompt = stringField(body, "prompt");
    captured.prompt = prompt;
    const bytes = await imageForPrompt(prompt);
    writeProviderJson(response, 200, {
      data: [{ b64_json: bytes.toString("base64") }],
      id: `image-${randomUUID()}`,
    });
    return;
  }
  writeProviderJson(response, 404, { error: { code: "not_found" } });
}

function employeeVariant(prompt: string) {
  if (prompt.includes("本成员主要问题"))
    return {
      title: "初次了解要确认哪些问题",
      body: "第一次了解相关信息时，可以先整理自己的问题。\n公开内容只能帮助准备问题，不能替你判断某项诊疗是否适合。\n实际资料、流程和需要携带什么，要按自身情况向专业人员确认。\n没有真实经历时不把准备清单写成已经发生的治疗故事。",
      hashtags: ["准备问题"],
      imagePrompt: "问题卡呈现初次了解时需要核对的事项，不绘制诊疗证据，不添加品牌或Logo。",
    };
  const ordinal = /成员序号：(\d+)/u.exec(prompt)?.[1] ?? "0";
  const reviewFeedback = /审核修订要求（必须落实）：([^\n]+)/u.exec(prompt)?.[1];
  return {
    body: `这是第 ${ordinal} 份独立科普内容。了解全飞秒 Pro 时，可以先关注专业设备、规范术前检查、完整操作流程和个体差异。技术信息应帮助读者理性决策，具体适用情况仍需经过专业评估，不作夸大或绝对效果承诺。${reviewFeedback ? `审核意见已落实：${reviewFeedback}。` : ""}`,
    hashtags: ["全飞秒Pro", "专业设备", `理性科普${ordinal}`],
    imagePrompt: `小红书竖版专业技术科普海报，第 ${ordinal} 组独立构图，暖白与珊瑚红配色，突出设备与规范评估。`,
    title: `全飞秒 Pro 理性了解 ${ordinal}`,
  };
}

async function imageForPrompt(prompt: string): Promise<Buffer> {
  const code = createHash("sha256").update(prompt).digest().readBigUInt64BE();
  const pixels = Buffer.alloc(9 * 8);
  for (let row = 0; row < 8; row += 1) {
    let value = 128;
    pixels[row * 9] = value;
    for (let column = 0; column < 8; column += 1) {
      const bit = row * 8 + column;
      value += (code & (1n << BigInt(bit))) === 0n ? 4 : -4;
      pixels[row * 9 + column + 1] = value;
    }
  }
  return sharp(pixels, { raw: { channels: 1, height: 8, width: 9 } })
    .resize(1080, 1440, { kernel: "nearest" })
    .png()
    .toBuffer();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function writeProviderJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string") throw new Error(`Expected string field: ${field}`);
  return result;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown protocol provider error").slice(0, 300);
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
    throw new Error("Real provider runtime test requires an approved local development database");
  }
}

function requiredFixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}
