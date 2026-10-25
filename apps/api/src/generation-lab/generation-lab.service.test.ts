import { ConflictException, ForbiddenException } from "@nestjs/common";
import { defaultGenerationStyles } from "@xhs-agentic/ai-gateway";
import { describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import type { MedicalPlanningService } from "../campaign/medical-planning.service";
import type { ContentService } from "../content/content.service";
import type { MaterialRetrievalService } from "../content/material-retrieval.service";
import type { PrismaService } from "../database/prisma.service";
import type { ModelConfigurationService } from "../model-configuration/model-configuration.service";
import type { GenerationStyleService } from "../platform-settings/generation-style.service";
import type { PlatformObjectStorageService } from "../platform-settings/platform-object-storage.service";
import { GenerationLabService } from "./generation-lab.service";

function fixture() {
  const config = { ...defaultGenerationStyles(), version: 3 };
  const style = {
    configurationVersion: 3,
    copyBasePrompt: config.copyBasePrompt,
    imageBasePrompt: config.imageBasePrompt,
    contentDirection: config.contentDirections[0],
    imageStyle: config.imageStyles[0],
  };
  const row = {
    id: "run",
    title: "测试",
    createdBy: "admin",
    tenantId: "tenant",
    enterpriseId: "enterprise",
    status: "DRAFT",
    reviewStatus: "NONE",
    input: {
      generationStyle: style,
      imageAssets: [],
      brief: "这是活动需求",
      keywords: "",
      seed: "fixed",
      retrieval: { images: [] },
    },
    result: {
      copy: { title: "完成文案", body: "已完成正文", imagePrompt: "图片提示词", hashtags: [] },
    },
    assets: [{ kind: "POSTER", id: "poster" }],
    calls: [],
  };
  const updateMany = vi.fn().mockImplementation(async ({ where, data }) => {
    if (
      (typeof where.status === "string" && row.status !== where.status) ||
      (where.reviewStatus === "NONE" && row.reviewStatus !== "NONE")
    )
      return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  const prisma = {
    industry: {
      findUnique: vi.fn().mockResolvedValue({
        name: "医疗健康",
        generationGuidance: "医疗行业原规则",
        updatedAt: new Date("2026-10-10T00:00:00Z"),
      }),
    },
    enterprise: {
      findFirst: vi.fn().mockResolvedValue({ id: "enterprise", tenantId: "tenant", name: "企业" }),
    },
    generationLabRun: {
      findUnique: vi.fn().mockImplementation(async () => structuredClone(row)),
      updateMany,
      update: vi.fn().mockImplementation(async ({ data }) => Object.assign(row, data)),
      create: vi.fn().mockImplementation(async ({ data }) => data),
    },
    generationLabAsset: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    generationLabCall: {
      create: vi.fn().mockResolvedValue({ id: "call" }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
  const access = {
    requireSaasAdmin: vi.fn().mockReturnValue({
      userId: "admin",
      scope: { type: "PLATFORM" },
      permissions: ["platform.model.manage", "platform.settings.manage"],
    }),
  };
  const retrieval = {
    selectImageAssets: vi.fn().mockResolvedValue([]),
    retrieve: vi.fn().mockResolvedValue({
      query: "检索词",
      hits: [],
      images: [],
      contextCharacters: 0,
      strategyVersion: "v1",
      embeddingUsage: {
        providerId: "p",
        modelId: "embedding",
        inputUnits: 20,
        estimatedCost: 0.00001,
      },
    }),
  };
  const content = {
    generationContext: vi
      .fn()
      .mockResolvedValue({ materials: [], sensitiveRules: [], geoEntities: [] }),
  };
  const models = {
    freezeGenerationRoute: vi.fn().mockResolvedValue({
      synthetic: false,
      maxAttemptsPerModel: 3,
      text: { primary: {}, fallbacks: [{}] },
      image: { primary: {}, fallbacks: [{}] },
    }),
  };
  const styles = {
    platformCurrent: vi.fn().mockResolvedValue(config),
    save: vi.fn().mockResolvedValue({ version: 4 }),
    snapshot: vi.fn().mockResolvedValue(style),
  };
  const medicalPlanning = {
    resolve: vi.fn().mockResolvedValue(null),
    assertCurrent: vi.fn().mockResolvedValue(undefined),
  };
  const service = new GenerationLabService(
    prisma as unknown as PrismaService,
    access as unknown as RequestAccessContext,
    retrieval as unknown as MaterialRetrievalService,
    content as unknown as ContentService,
    styles as unknown as GenerationStyleService,
    models as unknown as ModelConfigurationService,
    {} as PlatformObjectStorageService,
    medicalPlanning as unknown as MedicalPlanningService,
  );
  const execute = {
    action: "COPY" as const,
    referenceArtifactIds: [],
    logoArtifactId: "",
    copyBasePrompt: "基础文案提示",
    imageBasePrompt: "基础图片提示",
    contentDirectionPrompt: "调整内容方向",
    imageStylePrompt: "调整图片风格",
  };
  return { service, row, prisma, retrieval, access, styles, execute, models, medicalPlanning };
}

describe("platform generation lab isolation", () => {
  it("freezes the enterprise industry rules in the initial test snapshot", async () => {
    const f = fixture();
    f.prisma.enterprise.findFirst.mockResolvedValue({
      id: "enterprise",
      tenantId: "tenant",
      name: "企业",
      industry: "医疗健康",
    });
    f.prisma.generationLabRun.create.mockImplementation(async ({ data }) =>
      Object.assign(f.row, data),
    );
    const run = await f.service.check({
      enterpriseId: "enterprise",
      title: "海报测试",
      brief: "分享门店日常",
      contentDirectionPresetId: "direction-project",
      imageStylePresetId: "image-minimal",
    });
    expect(run.input).toMatchObject({
      industryGuidance: {
        name: "医疗健康",
        generationGuidance: "医疗行业原规则",
        updatedAt: "2026-10-10T00:00:00.000Z",
      },
    });
    expect(run.input).not.toHaveProperty("medicalPlan");
    expect(f.styles.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        contentDirectionPresetId: "direction-project",
        imageStylePresetId: "image-minimal",
      }),
    );
    expect(f.models.freezeGenerationRoute).toHaveBeenCalledWith("tenant", "enterprise", true);
    expect(f.prisma.industry.findUnique).toHaveBeenCalledOnce();
  });
  it("checks the real route before any paid retrieval and persists successful embedding usage", async () => {
    const f = fixture();
    f.prisma.generationLabRun.create.mockImplementation(async ({ data }) =>
      Object.assign(f.row, data),
    );
    const run = await f.service.check({
      enterpriseId: "enterprise",
      title: "文案测试",
      brief: "生成一篇科普",
      keywords: "科普",
    });
    expect(run.status).toBe("DRAFT");
    expect(f.prisma.generationLabCall.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelId: "embedding",
          usage: expect.objectContaining({ inputUnits: 20, estimatedCost: 0.00001 }),
        }),
      }),
    );
    expect(f.prisma.generationLabRun.create.mock.invocationCallOrder[0]).toBeLessThan(
      f.retrieval.retrieve.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it("keeps failed retrieval history and prevents forking an incomplete material snapshot", async () => {
    const f = fixture();
    f.prisma.generationLabRun.create.mockImplementation(async ({ data }) =>
      Object.assign(f.row, data),
    );
    f.retrieval.retrieve.mockRejectedValue(new Error("sensitive-provider-error"));
    const run = await f.service.check({
      enterpriseId: "enterprise",
      title: "文案测试",
      brief: "生成一篇科普",
      keywords: "科普",
    });
    expect(run.status).toBe("FAILED");
    expect(JSON.stringify(run)).not.toContain("sensitive-provider-error");
    expect(f.prisma.generationLabCall.updateMany).toHaveBeenCalledOnce();
    await expect(f.service.fork("run")).rejects.toThrow("素材检查未完成");
  });
  it("does not bill retrieval on a synthetic route", async () => {
    const f = fixture();
    f.models.freezeGenerationRoute.mockResolvedValue({ synthetic: true });
    await expect(
      f.service.check({
        enterpriseId: "enterprise",
        title: "文案测试",
        brief: "生成一篇科普",
        keywords: "科普",
      }),
    ).rejects.toThrow("真实模型");
    expect(f.retrieval.retrieve).not.toHaveBeenCalled();
  });
  it("rejects tenant scope before reading any test data", async () => {
    const f = fixture();
    f.access.requireSaasAdmin.mockReturnValue({
      userId: "admin",
      scope: { type: "TENANT" },
      permissions: ["platform.model.manage"],
    });
    await expect(f.service.get("run")).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.generationLabRun.findUnique).not.toHaveBeenCalled();
  });
  it("submits an immutable draft once, with no campaign mutations", async () => {
    const f = fixture();
    const outcomes = await Promise.allSettled([
      f.service.execute("run", f.execute),
      f.service.execute("run", f.execute),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(f.row.status).toBe("QUEUED");
    expect(f.row.input.generationStyle.copyBasePrompt).toBe("基础文案提示");
    await expect(f.service.execute("run", f.execute)).rejects.toBeInstanceOf(ConflictException);
  });
  it("requires existing copy for image-only runs", async () => {
    const f = fixture();
    await expect(f.service.execute("run", { ...f.execute, action: "IMAGE" })).rejects.toThrow(
      "文案",
    );
    expect(f.prisma.generationLabRun.updateMany).not.toHaveBeenCalled();
  });
  it("revalidates image scope and does not queue inaccessible references", async () => {
    const f = fixture();
    f.retrieval.selectImageAssets.mockRejectedValue(new ConflictException("不可用"));
    await expect(
      f.service.execute("run", { ...f.execute, referenceArtifactIds: ["other-enterprise-image"] }),
    ).rejects.toThrow("不可用");
    expect(f.retrieval.selectImageAssets).toHaveBeenCalledWith(
      { tenantId: "tenant", enterpriseId: "enterprise" },
      "这是活动需求",
      ["other-enterprise-image"],
      undefined,
      false,
    );
    expect(f.prisma.generationLabRun.updateMany).not.toHaveBeenCalled();
  });
  it("allows only one explicitly requested review of a complete immutable result", async () => {
    const f = fixture();
    f.row.status = "SUCCEEDED";
    await f.service.review("run");
    await expect(f.service.review("run")).rejects.toThrow("已提交过审核");
    expect(f.row.reviewStatus).toBe("QUEUED");
  });
  it("forks with frozen inputs and edited copy, not the poster or review result", async () => {
    const f = fixture();
    f.row.status = "SUCCEEDED";
    const copied = await f.service.fork("run");
    expect(copied).toMatchObject({
      parentId: "run",
      input: { seed: "fixed", copy: { body: "已完成正文" } },
    });
    expect(copied).not.toHaveProperty("result");
    expect(copied).not.toHaveProperty("review");
  });
  it("does not silently overwrite global prompts or accept stale version promotion", async () => {
    const f = fixture();
    f.row.status = "SUCCEEDED";
    await expect(
      f.service.promote("run", { kind: "GLOBAL", name: "新提示词", version: 2 }),
    ).rejects.toThrow("配置已更新");
    expect(f.styles.save).not.toHaveBeenCalled();
    await f.service.promote("run", { kind: "GLOBAL", name: "新提示词", version: 3 });
    expect(f.styles.save).toHaveBeenCalledOnce();
  });
  it("requires settings permission to publish test prompts", async () => {
    const f = fixture();
    f.access.requireSaasAdmin.mockReturnValue({
      userId: "admin",
      scope: { type: "PLATFORM" },
      permissions: ["platform.model.manage"],
    });
    await expect(
      f.service.promote("run", { kind: "GLOBAL", name: "新提示词", version: 3 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.styles.save).not.toHaveBeenCalled();
  });
});
