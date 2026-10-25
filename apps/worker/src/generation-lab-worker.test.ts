import { createHash } from "node:crypto";
import type { MedicalPlan } from "@xhs-agentic/ai-gateway";
import type { PrismaClient } from "@xhs-agentic/database";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvocationObserver } from "./routed-generation";

const mocks = vi.hoisted(() => ({
  adapter: { generateBlueprint: vi.fn(), generateEmployeeVariant: vi.fn(), generateImage: vi.fn() },
  routed: vi.fn(),
  assets: vi.fn(),
  scanner: vi.fn(),
  settings: vi.fn(),
}));
vi.mock("./routed-generation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createRoutedAdapter: mocks.routed,
}));
vi.mock("./poster-assets", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadPosterAssets: mocks.assets,
}));
vi.mock("./platform-settings", () => ({ loadWorkerPlatformSettings: mocks.settings }));
vi.mock("@xhs-agentic/content-safety", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createContentSafetyScanner: () => ({ scan: mocks.scanner }),
}));

import { labError, processLabTick } from "./generation-lab-worker";

const copy = {
  title: "专家科普知识",
  body: "明确的事实依据与理性宣传文案",
  hashtags: ["科普"],
  imagePrompt: "突出主体，简洁留白，不堆砌文字",
};
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
      question: "第一次了解要确认哪些问题？",
      intent: "准备",
      entityId: "",
      entityName: "",
    },
  ],
  publishers: [
    {
      membershipId: "member",
      publisherContext: {
        schemaVersion: "medical-publisher-v1",
        category: "ORDINARY",
        allowBrandAttribution: false,
        allowPlatformConsultation: false,
      },
    },
  ],
  frozenAt: "2026-10-13T08:00:00Z",
};
function fixture(action = "FULL", reviewStatus = "NONE") {
  const row = {
    id: "lab-test",
    status: reviewStatus === "QUEUED" ? "SUCCEEDED" : "QUEUED",
    reviewStatus,
    action,
    tenantId: "t",
    enterpriseId: "e",
    title: "测试",
    heartbeatAt: new Date(),
    leaseToken: null as string | null,
    input: {
      brief: "活动需求",
      materialSummary: "事实依据",
      geoSummary: "",
      sensitiveRuleSummary: "",
      sensitiveRules: [],
      sourceContext: {},
      imageAssets: [],
      seed: "fixed",
      copy,
      route: {
        synthetic: false,
        maxAttemptsPerModel: 9,
        text: { primary: {}, fallbacks: [{}] },
        image: { primary: {}, fallbacks: [{}] },
      },
    },
    result: { copy },
    error: null as string | null,
  };
  const assets: {
    kind: string;
    bytes: Uint8Array;
    checksum: string;
    id: string;
    description: string;
    mimeType: string;
  }[] = [];
  const updateMany = vi.fn().mockImplementation(async ({ where, data }) => {
    if (
      (where.id && where.id !== row.id) ||
      (where.leaseToken && where.leaseToken !== row.leaseToken) ||
      (where.status && where.status !== row.status) ||
      (where.reviewStatus && where.reviewStatus !== row.reviewStatus) ||
      (where.heartbeatAt?.lt && row.heartbeatAt >= where.heartbeatAt.lt)
    )
      return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  const calls: Record<string, unknown>[] = [];
  const prisma = {
    enterprise: { findFirst: vi.fn().mockResolvedValue({ id: "e" }) },
    modelDefinition: {
      findFirst: vi.fn().mockResolvedValue({
        metadata: { inputCostPerMillionUnits: 2, outputCostPerMillionUnits: 5 },
      }),
    },
    generationLabRun: {
      findFirst: vi
        .fn()
        .mockImplementation(async () =>
          row.status === "QUEUED" || row.reviewStatus === "QUEUED" ? structuredClone(row) : null,
        ),
      updateMany,
    },
    generationLabAsset: {
      findMany: vi.fn().mockImplementation(async () => assets),
      create: vi.fn().mockImplementation(async ({ data }) => {
        assets.push({ id: "poster", ...data });
        return data;
      }),
    },
    generationLabCall: {
      create: vi.fn().mockImplementation(async ({ data }) => {
        const call = { id: `call-${calls.length}`, ...data };
        calls.push(call);
        return call;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }) => {
        Object.assign(calls.find((c) => c.id === where.id) ?? {}, data);
      }),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
  return {
    row,
    assets,
    calls,
    prisma,
    tick: () => processLabTick(prisma as unknown as PrismaClient),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({
    storage: {
      endpoint: "http://127.0.0.1:9000",
      region: "test",
      bucket: "lab",
      accessKeyId: "test",
      secretAccessKey: "test",
    },
    contentSafety: {
      mode: "MODEL",
      verified: true,
      provider: "provider",
      model: "review-model",
      apiKey: "never-stored",
      endpoint: "https://example.test",
    },
  });
  mocks.assets.mockResolvedValue([]);
  mocks.routed.mockResolvedValue({ adapter: mocks.adapter });
  mocks.adapter.generateBlueprint.mockResolvedValue({
    result: { masterCopy: "事实依据", imageDirection: "简洁海报" },
  });
  mocks.adapter.generateEmployeeVariant.mockResolvedValue({ result: copy });
  mocks.scanner.mockResolvedValue({
    decision: "PASS",
    categories: [],
    usage: { inputUnits: 100, outputUnits: 10 },
  });
});

describe("generation lab background execution", () => {
  it.each(["QUESTION_CARD", "ORIGINAL_EDIT"] as const)(
    "makes medical %s locally with zero image-provider calls and reviews the final image",
    async (imageMode) => {
      const f = fixture("IMAGE");
      Object.assign(f.row.input, {
        medicalPlan: {
          ...medicalPlan,
          imageMode,
          originalImageConfirmed: imageMode === "ORIGINAL_EDIT",
        },
      });
      const bytes = await sharp({
        create: { width: 40, height: 60, channels: 3, background: "#234567" },
      })
        .png()
        .toBuffer();
      mocks.assets.mockResolvedValue([
        {
          usage: "REFERENCE",
          bytes,
          artifactId: "original",
          checksum: "original-hash",
          authorizationConfirmed: true,
          privacyConfirmed: true,
        },
      ]);
      await f.tick();
      expect(f.row.status).toBe("SUCCEEDED");
      expect(mocks.adapter.generateImage).not.toHaveBeenCalled();
      expect(mocks.adapter.generateBlueprint).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(0);
      expect(f.row.result).toMatchObject({
        productionMode: imageMode,
        imageProviderCalled: false,
        imageProviderCost: 0,
        logo: null,
      });
      expect(f.assets).toHaveLength(1);
      f.row.reviewStatus = "QUEUED";
      await f.tick();
      expect(mocks.scanner).toHaveBeenCalledOnce();
      expect(mocks.scanner.mock.calls[0]?.[0]).toMatchObject({
        publishingContext: { category: "ORDINARY", verified: false, conversionPath: "NONE" },
        images: [{ checksum: f.assets[0]?.checksum }],
      });
      expect(mocks.scanner.mock.calls[0]?.[0].images[0].bytes).toEqual(f.assets[0]?.bytes);
    },
  );

  it("does not fall back to image generation when original authorization is absent", async () => {
    const f = fixture("IMAGE");
    Object.assign(f.row.input, {
      medicalPlan: { ...medicalPlan, imageMode: "ORIGINAL_EDIT", originalImageConfirmed: true },
    });
    await f.tick();
    expect(f.row.status).toBe("FAILED");
    expect(mocks.adapter.generateImage).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
    expect(f.assets).toHaveLength(0);
  });

  it("generates one composed image, never sends the logo to a provider, and never auto-reviews", async () => {
    const f = fixture();
    const bytes = await sharp({
      create: { width: 16, height: 16, channels: 4, background: "#16a366" },
    })
      .png()
      .toBuffer();
    mocks.assets.mockResolvedValue([
      { usage: "LOGO", bytes, artifactId: "logo", checksum: "logo-hash" },
      {
        usage: "REFERENCE",
        bytes,
        mimeType: "image/png",
        checksum: "ref-hash",
        description: "主体参考图",
      },
    ]);
    mocks.adapter.generateImage.mockResolvedValue({ output: { bytes } });
    await Promise.all([f.tick(), f.tick()]);
    expect(f.row.status).toBe("SUCCEEDED");
    expect(mocks.adapter.generateImage).toHaveBeenCalledOnce();
    const request = mocks.adapter.generateImage.mock.calls[0]?.[1];
    expect(request.referenceImages).toHaveLength(1);
    expect(request.referenceImages[0].description).toBe("主体参考图");
    expect(request.reserveLogoSpace).toBe(true);
    expect(request.finalCopy).toEqual(copy);
    expect(f.assets).toHaveLength(1);
    expect(mocks.scanner).not.toHaveBeenCalled();
    expect(f.row.input.route.maxAttemptsPerModel).toBe(9); // Original persisted input is immutable.
    expect(mocks.routed.mock.calls[0]?.[2]).toMatchObject({
      maxAttemptsPerModel: 1,
      text: { fallbacks: [] },
      image: { fallbacks: [] },
    });
  });
  it("image-only tests reuse edited copy without any text generation", async () => {
    const f = fixture("IMAGE");
    mocks.adapter.generateImage.mockResolvedValue({
      output: {
        bytes: await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } })
          .png()
          .toBuffer(),
      },
    });
    await f.tick();
    expect(f.row.status).toBe("SUCCEEDED");
    expect(mocks.adapter.generateBlueprint).not.toHaveBeenCalled();
    expect(mocks.adapter.generateEmployeeVariant).not.toHaveBeenCalled();
    expect(mocks.adapter.generateImage.mock.calls[0]?.[1].finalCopy).toEqual(copy);
  });
  it("keeps completed copy after image failure and never retries a paid call", async () => {
    const f = fixture();
    mocks.adapter.generateImage.mockRejectedValue(new Error("secret sk-sensitive-token"));
    await f.tick();
    await f.tick();
    expect(f.row.status).toBe("FAILED");
    expect(f.row.result.copy).toEqual(copy);
    expect(mocks.adapter.generateImage).toHaveBeenCalledOnce();
    expect(f.row.error).not.toContain("sensitive-token");
  });
  it("terminates abandoned claims without resubmitting provider requests", async () => {
    const f = fixture();
    f.row.status = "RUNNING";
    f.row.heartbeatAt = new Date(0);
    await f.tick();
    expect(f.row.status).toBe("INTERRUPTED");
    expect(mocks.routed).not.toHaveBeenCalled();
  });
  it("reviews a selected complete result only once and records token usage", async () => {
    const f = fixture("FULL", "QUEUED");
    const bytes = new Uint8Array([1, 2, 3]);
    f.assets.push({
      kind: "POSTER",
      id: "poster",
      bytes,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      description: "测试",
      mimeType: "image/png",
    });
    await f.tick();
    await f.tick();
    expect(f.row.reviewStatus).toBe("DONE");
    expect(mocks.scanner).toHaveBeenCalledOnce();
    expect(mocks.routed).not.toHaveBeenCalled();
    expect(f.calls[0]).toMatchObject({
      status: "SUCCEEDED",
      usage: { inputUnits: 100, outputUnits: 10, estimatedCost: 0.00025 },
    });
    expect(JSON.stringify(f.calls)).not.toContain("never-stored");
  });
  it("persists actual prompts and reference hashes without image bytes", async () => {
    const f = fixture("COPY");
    mocks.routed.mockImplementation(async (_db, _id, _route, observer: InvocationObserver) => ({
      adapter: {
        ...mocks.adapter,
        generateBlueprint: async () => {
          await observer(
            {
              kind: "TEXT",
              modelId: "text-model",
              providerId: "p",
              pricing: {},
              request: {
                context: { generationRunId: "lab-test", tenantId: "t" },
                prompt: "实际发送提示词",
              },
            },
            async () => ({ usage: { inputUnits: 25, outputUnits: 30 }, text: "模型原始响应" }),
          );
          return { result: { masterCopy: "母版", imageDirection: "方向" } };
        },
      },
    }));
    await f.tick();
    expect(f.calls[0]).toMatchObject({
      request: { prompt: "实际发送提示词" },
      usage: { estimatedCost: null, inputUnits: 25, text: "模型原始响应" },
    });
    expect(f.row.status).toBe("SUCCEEDED");
  });
  it("never stores raw supplier exceptions", () => {
    expect(labError(new Error("Authorization Bearer top-secret"))).not.toContain("top-secret");
  });
});
