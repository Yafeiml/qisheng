import "reflect-metadata";

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module";
import { configureApplication } from "../configure-application";
import { PrismaService } from "../database/prisma.service";
import { GenerationQueueService } from "./generation-queue.service";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

describe("campaign planning templates and drafts", { concurrent: false }, () => {
  const marker = `planning-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const adminPhone = `137${marker.replace(/\D/gu, "").slice(-8).padStart(8, "0")}`;
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let platformToken: string;
  let adminToken: string;
  let tenantId: string;
  let enterpriseAId: string;
  let enterpriseBId: string;
  let promptTemplateId: string;
  let campaignTemplateId: string;
  let campaignAId: string;
  let campaignBId: string;

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
  });

  afterAll(async () => {
    if (!prisma) return;
    const tenant = await prisma.tenant.findFirst({ where: { name: `${marker}-tenant` } });
    if (tenant) {
      const user = await prisma.adminUser.findUnique({ where: { phone: adminPhone } });
      await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.managementAction.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.campaignDraft.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.publishSubmission.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.distributionTask.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.generationWorkItem.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.generationRun.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.campaignBlueprint.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.employeeContent.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.campaignAudienceSnapshot.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.enterpriseMembership.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.campaign.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.campaignTemplate.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.promptTemplate.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.roleBinding.deleteMany({
        where: user
          ? { OR: [{ tenantId: tenant.id }, { userId: user.id }] }
          : { tenantId: tenant.id },
      });
      await prisma.customerContract.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.enterprise.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.tenant.delete({ where: { id: tenant.id } });
      if (user) await prisma.adminUser.delete({ where: { id: user.id } });
    }
    await app.close();
  });

  it("creates an isolated tenant workspace", async () => {
    platformToken = stringField(
      (
        await request("/auth/dev/admin-token", {
          body: { phone: process.env.DEV_PLATFORM_ADMIN_PHONE },
          method: "POST",
        })
      ).body,
      "accessToken",
    );
    const tenant = await request("/platform/tenants", {
      body: { customerType: "GROUP", name: `${marker}-tenant` },
      method: "POST",
      token: platformToken,
    });
    expect(tenant.status).toBe(201);
    tenantId = stringField(tenant.body, "id");
    const [enterpriseA, enterpriseB] = await Promise.all([
      request(`/platform/tenants/${tenantId}/enterprises`, {
        body: { code: `${marker}-a`, name: "模板企业 A" },
        method: "POST",
        token: platformToken,
      }),
      request(`/platform/tenants/${tenantId}/enterprises`, {
        body: { code: `${marker}-b`, name: "模板企业 B" },
        method: "POST",
        token: platformToken,
      }),
    ]);
    enterpriseAId = stringField(enterpriseA.body, "id");
    enterpriseBId = stringField(enterpriseB.body, "id");
    await prisma.enterprise.update({
      where: { id: enterpriseAId },
      data: { industry: "眼科医疗" },
    });
    await request(`/platform/tenants/${tenantId}/admins`, {
      body: { phone: adminPhone, reason: "模板与草稿集成测试" },
      method: "POST",
      token: platformToken,
    });
    const token = await request("/auth/dev/admin-token", {
      body: { phone: adminPhone },
      method: "POST",
    });
    adminToken = stringField(token.body, "accessToken");
  });

  it("exposes only public style choices and protects editable platform prompts", async () => {
    const choices = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/campaign-planning/generation-styles`,
      { token: adminToken },
    );
    expect(choices.status).toBe(200);
    const options = choices.body as {
      contentDirections: Array<{ id: string }>;
      imageStyles: Array<{ id: string }>;
    };
    expect(options.contentDirections.length).toBeGreaterThan(0);
    expect(JSON.stringify(choices.body)).not.toContain('"prompt"');
    expect(JSON.stringify(choices.body)).not.toContain("BasePrompt");
    expect((await request("/platform/generation-styles", { token: adminToken })).status).toBe(403);
    expect((await request("/platform/generation-styles", { token: platformToken })).status).toBe(
      200,
    );
    const draft = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/campaign-planning/draft`,
      {
        token: adminToken,
        method: "POST",
        body: {
          step: 1,
          contentDirectionPresetId: options.contentDirections[0]?.id,
          imageStylePresetId: options.imageStyles[0]?.id,
        },
      },
    );
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({
      payload: {
        contentDirectionPresetId: options.contentDirections[0]?.id,
        imageStylePresetId: options.imageStyles[0]?.id,
      },
    });
  });

  it("creates reusable prompt and campaign templates", async () => {
    const base = `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/campaign-planning`;
    const prompt = await request(`${base}/prompt-templates`, {
      body: {
        content: "围绕专业设备、真实服务过程和规范评估生成小红书风格内容",
        contentDirection: "设备与规范流程",
        name: "专业设备传播口径",
      },
      method: "POST",
      token: adminToken,
    });
    expect(prompt.status).toBe(201);
    promptTemplateId = stringField(prompt.body, "id");
    const campaign = await request(`${base}/campaign-templates`, {
      body: {
        contentDirection: "设备与规范流程",
        imageCount: 1,
        imageStyle: "真实诊室纪实",
        name: "设备技术月度传播",
        prompt: "围绕专业设备、真实服务过程和规范评估生成小红书风格内容",
        promptTemplateId,
        reminderOffsetsHours: [18, 6, 6],
        title: "本月设备技术分享",
      },
      method: "POST",
      token: adminToken,
    });
    expect(campaign.status).toBe(201);
    campaignTemplateId = stringField(campaign.body, "id");
    expect(campaign.body).toMatchObject({ reminderOffsetsHours: [6, 18] });
  });

  it("keeps templates isolated by enterprise and rejects duplicate names", async () => {
    const baseA = `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/campaign-planning`;
    const baseB = `/console/tenants/${tenantId}/enterprises/${enterpriseBId}/campaign-planning`;
    const [templatesA, templatesB] = await Promise.all([
      request(`${baseA}/campaign-templates`, { token: adminToken }),
      request(`${baseB}/campaign-templates`, { token: adminToken }),
    ]);
    expect(JSON.stringify(templatesA.body)).toContain(campaignTemplateId);
    expect(JSON.stringify(templatesB.body)).not.toContain(campaignTemplateId);
    const duplicate = await request(`${baseA}/prompt-templates`, {
      body: {
        content: "另一个内容",
        name: "专业设备传播口径",
      },
      method: "POST",
      token: adminToken,
    });
    expect(duplicate.status).toBe(409);
  });

  it("autosaves one recoverable draft per operator and enterprise", async () => {
    const baseA = `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/campaign-planning`;
    const saved = await request(`${baseA}/draft`, {
      body: {
        focusEntityIds: ["focus-a"],
        audienceMode: "ALL",
        campaignTemplateId,
        contentDirection: "设备与规范流程",
        imageCount: 1,
        imageStyle: "真实诊室纪实",
        prompt: "草稿中的传播要求",
        promptTemplateId,
        reminderOffsetsHours: [6, 18],
        step: 2,
        title: "尚未完成的活动",
        visibleAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      method: "POST",
      token: adminToken,
    });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({
      payload: { focusEntityIds: ["focus-a"] },
    });
    const draftId = stringField(saved.body, "id");
    const updated = await request(`${baseA}/draft`, {
      body: {
        prompt: "更新后的草稿",
        step: 3,
        title: "尚未完成的活动",
        focusEntityIds: [],
      },
      method: "POST",
      token: adminToken,
    });
    expect(stringField(updated.body, "id")).toBe(draftId);
    expect(updated.body).toMatchObject({ payload: { focusEntityIds: [] } });
    const [draftA, draftB] = await Promise.all([
      request(`${baseA}/draft`, { token: adminToken }),
      request(`/console/tenants/${tenantId}/enterprises/${enterpriseBId}/campaign-planning/draft`, {
        token: adminToken,
      }),
    ]);
    expect(JSON.stringify(draftA.body)).toContain("更新后的草稿");
    expect(draftA.body).toMatchObject({
      draft: { payload: { prompt: "更新后的草稿", focusEntityIds: [] } },
    });
    expect(draftB.body).toMatchObject({ draft: null });
    expect((await request(`${baseA}/draft`, { token: adminToken })).body).toMatchObject({
      draft: { payload: { prompt: "更新后的草稿", focusEntityIds: [] } },
    });
  });

  it("compares periods, enterprises and content strategies without leaking enterprise scope", async () => {
    const user = await prisma.adminUser.findUniqueOrThrow({ where: { phone: adminPhone } });
    const now = new Date();
    const campaigns = await Promise.all([
      prisma.campaign.create({
        data: {
          contentDirection: "设备科普",
          createdBy: user.id,
          enterpriseId: enterpriseAId,
          expiresAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
          imageStyle: "真实纪实",
          prompt: "当前周期企业 A",
          status: "DRAFT",
          tenantId,
          title: "当前 A 活动",
          visibleAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
        },
      }),
      prisma.campaign.create({
        data: {
          contentDirection: "服务体验",
          createdBy: user.id,
          enterpriseId: enterpriseBId,
          expiresAt: now,
          imageStyle: "生活方式",
          prompt: "当前周期企业 B",
          status: "DRAFT",
          tenantId,
          title: "当前 B 活动",
          visibleAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        },
      }),
      prisma.campaign.create({
        data: {
          contentDirection: "设备科普",
          createdBy: user.id,
          enterpriseId: enterpriseAId,
          expiresAt: new Date(now.getTime() - 9 * 24 * 60 * 60 * 1000),
          imageStyle: "真实纪实",
          prompt: "上周期企业 A",
          status: "DRAFT",
          tenantId,
          title: "上周期 A 活动",
          visibleAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
        },
      }),
    ]);
    campaignAId = campaigns[0].id;
    campaignBId = campaigns[1].id;
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = now.toISOString();
    const query = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const tenantDashboard = await request(`/console/tenants/${tenantId}/dashboard${query}`, {
      token: adminToken,
    });
    expect(tenantDashboard.status).toBe(200);
    expect(tenantDashboard.body).toMatchObject({
      previousSummary: { campaignCount: 1 },
      summary: { campaignCount: 2 },
      summaryChanges: { taskCount: 0, verifiedCount: 0, views: null },
    });
    expect(JSON.stringify(tenantDashboard.body)).toContain("设备科普");
    expect(JSON.stringify(tenantDashboard.body)).toContain("服务体验");
    expect(arrayField(tenantDashboard.body, "enterpriseComparisons")).toHaveLength(2);

    const enterpriseDashboard = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/dashboard${query}`,
      { token: adminToken },
    );
    expect(JSON.stringify(enterpriseDashboard.body)).toContain("当前 A 活动");
    expect(JSON.stringify(enterpriseDashboard.body)).not.toContain("当前 B 活动");

    const csv = await request(`/console/tenants/${tenantId}/dashboard.csv${query}`, {
      token: adminToken,
    });
    expect(csv.status).toBe(200);
    expect(csv.body).toContain("企业对比");
    expect(csv.body).toContain("内容表现维度");
  });

  it("counts every matching status independently of the selected tab and cursor", async () => {
    const user = await prisma.adminUser.findUniqueOrThrow({ where: { phone: adminPhone } });
    const countTitle = `${marker}-tab-count`;
    const common = {
      createdBy: user.id,
      tenantId,
      enterpriseId: enterpriseAId,
      title: countTitle,
      prompt: "标签数量测试",
      visibleAt: new Date(Date.now() + 86400000),
      expiresAt: new Date(Date.now() + 172800000),
    };
    await prisma.campaign.createMany({
      data: [
        ...Array.from({ length: 24 }, () => ({ ...common, status: "CANCELLED" as const })),
        { ...common, status: "DRAFT" },
        { ...common, status: "CANCELLED", archivedAt: new Date() },
        { ...common, enterpriseId: enterpriseBId, status: "CANCELLED" },
      ],
    });
    const base = `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/campaigns?search=${encodeURIComponent(countTitle)}&status=CANCELLED&limit=5`;
    const first = await request(base, { token: adminToken });
    expect(first.status).toBe(200);
    expect(arrayField(first.body, "items")).toHaveLength(5);
    expect(first.body).toMatchObject({ statusCounts: { CANCELLED: 24, DRAFT: 1 } });
    const cursor = (first.body as { pageInfo: { nextCursor: string } }).pageInfo.nextCursor;
    const next = await request(`${base}&cursor=${encodeURIComponent(cursor)}`, {
      token: adminToken,
    });
    expect(next.body).toMatchObject({ statusCounts: { CANCELLED: 24, DRAFT: 1 } });
    expect((await request(`${base}&archive=ARCHIVED`, { token: adminToken })).body).toMatchObject({
      statusCounts: { CANCELLED: 1 },
    });
    expect((await request(`${base}&archive=ALL`, { token: adminToken })).body).toMatchObject({
      statusCounts: { CANCELLED: 25, DRAFT: 1 },
    });
  });

  it("opens completed publication records for one task without exposing another enterprise", async () => {
    const tasks: string[] = [];
    for (const [index, enterpriseId] of [enterpriseAId, enterpriseAId, enterpriseBId].entries()) {
      const campaignId = enterpriseId === enterpriseAId ? campaignAId : campaignBId;
      const member = await prisma.enterpriseMembership.create({
        data: {
          tenantId,
          enterpriseId,
          name: `发布记录员工${index}`,
          phone: `1390000000${index}`,
          status: "ACTIVE",
          seatStatus: "ENABLED",
          seatEnabledAt: new Date(),
        },
      });
      const snapshot = await prisma.campaignAudienceSnapshot.create({
        data: {
          tenantId,
          enterpriseId,
          campaignId,
          membershipId: member.id,
          employeeName: member.name,
          employeePhone: member.phone,
        },
      });
      const content = await prisma.employeeContent.create({
        data: {
          tenantId,
          enterpriseId,
          campaignId,
          membershipId: member.id,
          audienceSnapshotId: snapshot.id,
          title: "专属图文",
          body: "仅供发布记录查询测试",
          imagePrompt: "不调用生成服务",
          contentFingerprint: randomUUID(),
          riskAssessment: { passed: true },
        },
      });
      const task = await prisma.distributionTask.create({
        data: {
          tenantId,
          enterpriseId,
          campaignId,
          membershipId: member.id,
          employeeContentId: content.id,
          status: index === 1 ? "AVAILABLE" : "COMPLETED",
          submittedAt: index === 1 ? null : new Date(),
          verifiedAt: index === 1 ? null : new Date(),
          visibleAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      tasks.push(task.id);
      await prisma.publishSubmission.create({
        data: {
          taskId: task.id,
          tenantId,
          verifier: "query-fixture",
          canonicalKey: `${marker}-${index}`,
          rawUrl: "https://example.test/note",
          normalizedUrl: "https://example.test/note",
          status: index === 1 ? "MANUAL_REVIEW" : "VALID",
          verifiedAt: index === 1 ? null : new Date(),
        },
      });
    }
    await prisma.publishSubmission.create({
      data: {
        taskId: tasks[0] as string,
        tenantId,
        verifier: "query-fixture",
        canonicalKey: `${marker}-old`,
        rawUrl: "https://example.test/old",
        normalizedUrl: "https://example.test/old",
        status: "SUPERSEDED",
        submittedAt: new Date(Date.now() - 60000),
      },
    });
    const base = `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/publication-reviews`;
    const queue = await request(base, { token: adminToken });
    expect(arrayField(queue.body, "items")).toHaveLength(1);
    const records = await request(`${base}?taskId=${tasks[0]}&limit=1`, { token: adminToken });
    expect(records.status).toBe(200);
    expect(arrayField(records.body, "items")).toMatchObject([
      { taskId: tasks[0], status: "VALID" },
    ]);
    const cursor = (records.body as { pageInfo: { nextCursor: string } }).pageInfo.nextCursor;
    const older = await request(`${base}?taskId=${tasks[0]}&cursor=${encodeURIComponent(cursor)}`, {
      token: adminToken,
    });
    expect(arrayField(older.body, "items")).toMatchObject([{ status: "SUPERSEDED" }]);
    expect(
      arrayField(
        (await request(`${base}?taskId=${tasks[2]}`, { token: adminToken })).body,
        "items",
      ),
    ).toHaveLength(0);
    expect((await request(`${base}?taskId=${"x".repeat(65)}`, { token: adminToken })).status).toBe(
      400,
    );
  });

  it.each(["COPY", "IMAGE", "BOTH"] as const)(
    "queues %s regeneration exactly once, atomically",
    async (target) => {
      const scheduleBase = Date.now();
      const member = await prisma.enterpriseMembership.create({
        data: {
          tenantId,
          enterpriseId: enterpriseAId,
          name: `重生成${target}`,
          phone: `136${randomUUID().replace(/\D/gu, "").slice(0, 8).padEnd(8, "0")}`,
          status: "ACTIVE",
          seatStatus: "ENABLED",
          seatEnabledAt: new Date(),
        },
      });
      const campaign = await prisma.campaign.create({
        data: {
          tenantId,
          enterpriseId: enterpriseAId,
          title: `重生成${target}`,
          prompt: "规范介绍技术",
          createdBy: "planning-fixture",
          status: "REVIEW_PENDING",
          audienceCount: 1,
          generatedCount: 1,
          imageCount: 1,
          visibleAt: new Date(scheduleBase + 86400000),
          expiresAt: new Date(scheduleBase + 172800000),
        },
      });
      const snapshot = await prisma.campaignAudienceSnapshot.create({
        data: {
          tenantId,
          enterpriseId: enterpriseAId,
          campaignId: campaign.id,
          membershipId: member.id,
          employeeName: member.name,
          employeePhone: member.phone,
        },
      });
      const originalInput = {
        campaignBrief: "已冻结的要求",
        imageAssets: [],
        sourceContext: { materialIds: ["frozen-material"] },
      };
      const run = await prisma.generationRun.create({
        data: {
          tenantId,
          campaignId: campaign.id,
          status: "SUCCEEDED",
          requestedCount: 1,
          completedCount: 1,
          startedAt: new Date(),
          finishedAt: new Date(),
          provider: "isolated-test",
          textModel: "isolated-test",
          imageModel: "isolated-test",
          generationInput: originalInput,
          routingPolicy: {},
        },
      });
      const item = await prisma.generationWorkItem.create({
        data: {
          tenantId,
          enterpriseId: enterpriseAId,
          campaignId: campaign.id,
          generationRunId: run.id,
          audienceSnapshotId: snapshot.id,
          membershipId: member.id,
          status: "SUCCEEDED",
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      const content = await prisma.employeeContent.create({
        data: {
          tenantId,
          enterpriseId: enterpriseAId,
          campaignId: campaign.id,
          audienceSnapshotId: snapshot.id,
          membershipId: member.id,
          title: "原文案",
          body: "原正文完整保留",
          hashtags: ["技术"],
          imagePrompt: "原图片要求",
          contentFingerprint: `${marker}-${target}`,
          status: target === "IMAGE" ? "REVIEW_BLOCKED" : "GENERATED",
          riskAssessment: { passed: target !== "IMAGE", warnings: [] },
        },
      });
      const queue = vi
        .spyOn(app.get(GenerationQueueService), "enqueueWorkItem")
        .mockResolvedValue(undefined);
      const path = `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/campaigns/${campaign.id}/contents/${content.id}/regenerate`;
      try {
        if (target === "COPY") {
          for (const body of [
            { feedback: "明确修改要求" },
            { target: "UNKNOWN", feedback: "明确修改要求" },
            { target, feedback: "太短" },
          ]) {
            expect((await request(path, { token: adminToken, method: "POST", body })).status).toBe(
              400,
            );
          }
          expect(
            (
              await request(path.replace(enterpriseAId, enterpriseBId), {
                token: adminToken,
                method: "POST",
                body: { target, feedback: "明确修改要求" },
              })
            ).status,
          ).toBe(404);
          expect(queue).not.toHaveBeenCalled();
        }
        const submit = () =>
          request(path, {
            token: adminToken,
            method: "POST",
            body: { target, feedback: "补充清晰具体的信息" },
          });
        const attempts =
          target === "COPY" ? await Promise.all([submit(), submit()]) : [await submit()];
        expect(attempts.map(({ status }) => status).sort()).toEqual(
          target === "COPY" ? [201, 409] : [201],
        );
        const result = attempts.find(({ status }) => status === 201);
        if (!result) throw new Error("Expected one accepted regeneration request");
        expect(result.status).toBe(201);
        expect(result.body).toMatchObject({ status: "GENERATING" });
        expect(await prisma.employeeContent.findUnique({ where: { id: content.id } })).toEqual(
          content,
        );
        expect(await prisma.generationRun.findUnique({ where: { id: run.id } })).toMatchObject({
          generationInput: { ...originalInput, regenerationTargets: { [item.id]: target } },
        });
        expect(
          await prisma.generationWorkItem.findUnique({ where: { id: item.id } }),
        ).toMatchObject({
          status: "QUEUED",
          reservationVersion: 2,
          reviewFeedback: "补充清晰具体的信息",
        });
        expect(queue).toHaveBeenCalledTimes(1);
        await prisma.campaignBlueprint.create({
          data: {
            campaignId: campaign.id,
            tenantId,
            masterCopy: "已冻结母版",
            imageDirection: "已冻结视觉方向",
            sourceContext: {},
            generationPolicy: {},
          },
        });
        await prisma.$transaction(async (transaction) => {
          await transaction.generationWorkItem.update({
            where: { id: item.id },
            data: {
              status: "FAILED",
              attemptCount: 3,
              startedAt: new Date(),
              finishedAt: new Date(),
            },
          });
          await transaction.generationRun.update({
            where: { id: run.id },
            data: { status: "FAILED", failedCount: 1, finishedAt: new Date() },
          });
          await transaction.campaign.update({
            where: { id: campaign.id },
            data: { status: "GENERATION_FAILED" },
          });
        });
        const retry = await request(
          `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/campaigns/${campaign.id}/retry-failed`,
          { token: adminToken, method: "POST" },
        );
        expect(retry.status).toBe(201);
        expect(
          await prisma.generationWorkItem.findUnique({ where: { id: item.id } }),
        ).toMatchObject({
          status: "QUEUED",
          reviewFeedback: "补充清晰具体的信息",
          reservationVersion: 3,
          attemptCount: 0,
        });
        expect(await prisma.generationRun.findUnique({ where: { id: run.id } })).toMatchObject({
          generationInput: { ...originalInput, regenerationTargets: { [item.id]: target } },
        });
        expect(queue).toHaveBeenCalledTimes(2);
        expect(
          (
            await request(path, {
              token: adminToken,
              method: "POST",
              body: { target, feedback: "补充清晰具体的信息" },
            })
          ).status,
        ).toBe(409);
        expect(queue).toHaveBeenCalledTimes(2);
      } finally {
        queue.mockRestore();
      }
    },
  );

  it("turns an abnormal conclusion into an owned management action", async () => {
    const base = `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/management-actions`;
    const created = await request(base, {
      body: {
        assignee: "内容运营负责人",
        campaignId: campaignAId,
        description: "复盘设备科普内容的执行情况",
        dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        title: "跟进本期未完成员工",
      },
      method: "POST",
      token: adminToken,
    });
    expect(created.status).toBe(201);
    const actionId = stringField(created.body, "id");
    expect(created.body).toMatchObject({ status: "OPEN" });
    const updated = await request(`${base}/${actionId}`, {
      body: {
        note: "已与部门负责人确认原因，下期提前提醒",
        status: "RESOLVED",
      },
      method: "POST",
      token: adminToken,
    });
    expect(updated.body).toMatchObject({
      note: "已与部门负责人确认原因，下期提前提醒",
      resolvedAt: expect.any(String),
      status: "RESOLVED",
    });

    const invalidCampaign = await request(base, {
      body: { campaignId: campaignBId, title: "越权关联其他企业活动" },
      method: "POST",
      token: adminToken,
    });
    expect(invalidCampaign.status).toBe(404);
  });

  it("disables templates without deleting historical identities and clears drafts", async () => {
    const base = `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/campaign-planning`;
    const disabled = await request(`${base}/campaign-templates/${campaignTemplateId}/disable`, {
      body: { reason: "传播口径已经更新" },
      method: "POST",
      token: adminToken,
    });
    expect(disabled.body).toMatchObject({ status: "DISABLED" });
    const list = await request(`${base}/campaign-templates`, { token: adminToken });
    expect(JSON.stringify(list.body)).not.toContain(campaignTemplateId);
    const cleared = await request(`${base}/draft/clear`, {
      method: "POST",
      token: adminToken,
    });
    expect(cleared.body).toMatchObject({ cleared: true });
  });

  async function request(
    path: string,
    options: Readonly<{ token?: string; method?: "GET" | "POST"; body?: unknown }> = {},
  ): Promise<Readonly<{ body: unknown; status: number }>> {
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
    const isJson = response.headers.get("content-type")?.includes("application/json");
    return { body: text ? (isJson ? JSON.parse(text) : text) : null, status: response.status };
  }
});

function stringField(value: unknown, field: string): string {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as Record<string, unknown>)[field] !== "string"
  ) {
    throw new Error(`Expected string field: ${field}`);
  }
  return (value as Record<string, string>)[field] as string;
}

function arrayField(value: unknown, field: string): unknown[] {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as Record<string, unknown>)[field])
  ) {
    throw new Error(`Expected array field: ${field}`);
  }
  return (value as Record<string, unknown[]>)[field] as unknown[];
}

function assertDevelopmentDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname.replace(/^\//u, "") !== "dev_xhs_agentic") {
    throw new Error("Campaign planning integration test requires dev_xhs_agentic");
  }
}
