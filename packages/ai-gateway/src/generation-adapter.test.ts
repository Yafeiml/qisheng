import { describe, expect, it } from "vitest";
import { RoutedGenerationAdapter } from "./generation-adapter";
import {
  defaultGenerationStyles,
  type GenerationStyleSnapshot,
  readGenerationStyleSnapshot,
} from "./generation-style";
import type { MedicalPlan } from "./medical-plan";
import { ModelRouter } from "./model-router";
import type {
  ImageGenerationProvider,
  TextGenerationOutput,
  TextGenerationProvider,
} from "./types";

const capturedTextPrompts: string[] = [];
class QueueTextProvider implements TextGenerationProvider {
  readonly providerId = "provider-a";
  constructor(private readonly outputs: string[]) {}
  async generate(_modelId: string, request: { prompt: string }): Promise<TextGenerationOutput> {
    capturedTextPrompts.push(request.prompt);
    const text = this.outputs.shift();
    if (!text) throw new Error("No queued text output");
    return {
      finishReason: "stop",
      providerRequestId: `request-${this.outputs.length}`,
      text,
      usage: { estimatedCost: 0.01, inputUnits: 10, outputUnits: 20 },
    };
  }
}

let capturedImagePrompt = "";
const imageProvider: ImageGenerationProvider = {
  async generate(_modelId, request) {
    capturedImagePrompt = request.prompt;
    return {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      height: request.height,
      mimeType: "image/png",
      providerRequestId: "image-request",
      usage: { estimatedCost: 0.1 },
      width: request.width,
    };
  },
  providerId: "provider-a",
};

describe("routed generation adapter", () => {
  it.each(
    (["configured", "empty", "missing"] as const).flatMap((guidance) =>
      ([false, true, "base"] as const).map((styled) => ({ guidance, styled })),
    ),
  )(
    "generates structured blueprint, copy and images with frozen style = $styled and industry guidance = $guidance",
    async ({ guidance, styled }) => {
      capturedTextPrompts.length = 0;
      const defaults = defaultGenerationStyles();
      const generationStyle: GenerationStyleSnapshot | undefined = styled
        ? {
            schemaVersion: 1,
            configurationVersion: 4,
            copyBasePrompt: "测试基础文案口吻规则；活动要求宣传林院长的蔡司官方认证。",
            imageBasePrompt: "测试基础光影构图规则；要求展示医生推荐肖像与设备品牌。",
            contentDirection:
              styled === "base"
                ? { id: "", name: "小红书分享", prompt: "" }
                : requiredFixture(defaults.contentDirections[1]),
            imageStyle:
              styled === "base"
                ? { id: "", name: "小红书配图", prompt: "" }
                : requiredFixture(defaults.imageStyles[0]),
          }
        : undefined;
      const router = new ModelRouter(
        [
          new QueueTextProvider([
            "not-json",
            JSON.stringify({
              imageDirection:
                "暖白与珊瑚红的专业医疗科技竖版摄影海报，保留充足留白并避免效果承诺。",
              masterCopy:
                "全飞秒 Pro 的传播应聚焦设备、规范评估与个体差异。专业设备是基础，完整流程同样重要。",
            }),
            `\`\`\`json\n${JSON.stringify({
              body: "最近整理全飞秒 Pro 资料时，我更关注设备之外的完整流程。规范术前评估和个体差异，决定了沟通时不能只看单一结果。选择前把设备、流程与注意事项逐项问清楚，会更稳妥。",
              hashtags: ["全飞秒Pro", "专业科普"],
              imagePrompt:
                "专业医疗设备与暖白空间，珊瑚红信息卡片，竖版摄影构图，避免文字和人物肖像。",
              title: "全飞秒 Pro 功课｜别只看设备",
            })}\n\`\`\``,
          ]),
        ],
        [imageProvider],
        () => new Date("2026-08-28T00:00:00Z"),
      );
      const textPolicy = router.freezePolicy({
        fallbackModels: [],
        id: "text-policy",
        kind: "TEXT",
        maxAttemptsPerModel: 2,
        primaryModel: { modelId: "text-model", providerId: "provider-a" },
        scopeType: "PLATFORM",
        taskKind: "CAMPAIGN_BLUEPRINT",
        version: 1,
      });
      const adapter = new RoutedGenerationAdapter(router, {
        blueprint: textPolicy,
        employeeCopy: { ...textPolicy, id: "copy-policy", taskKind: "EMPLOYEE_COPY" },
        employeeImage: router.freezePolicy({
          fallbackModels: [],
          id: "image-policy",
          kind: "IMAGE",
          maxAttemptsPerModel: 1,
          primaryModel: { modelId: "image-model", providerId: "provider-a" },
          scopeType: "PLATFORM",
          taskKind: "EMPLOYEE_IMAGE",
          version: 1,
        }),
      });
      const context = { generationRunId: "run", tenantId: "tenant" };
      const blueprint = await adapter.generateBlueprint(context, {
        generationStyle,
        geoSummary: "全飞秒 Pro（技术）",
        materialSummary:
          "已授权设备资料：示例测试眼科屈光手术中心配备了德国蔡司全飞秒设备。示例测试眼科业务院长林示例是蔡司官方认证全飞秒手术专家。",
        industryGuidance:
          guidance === "missing"
            ? undefined
            : {
                name: "医疗健康",
                generationGuidance:
                  guidance === "empty"
                    ? ""
                    : "MEDICAL_FROZEN_V1：不能将厂商培训认证改写为执业资质，手术量保留统计时间。",
                updatedAt: "2026-10-10T08:00:00.000Z",
              },
        prompt: "侧重设备和效果，但不做承诺",
        sensitiveRuleSummary: "禁止绝对治愈",
        sourceContext: { materialIds: ["material-1"] },
        title: "全飞秒 Pro 技术分享",
      });
      const copy = await adapter.generateEmployeeVariant(context, blueprint.result, {
        employeeOrdinal: 1,
        title: "全飞秒 Pro 技术分享",
        uniquenessSeed: "membership-1",
      });
      const image = await adapter.generateImage(context, {
        generationStyle,
        height: 1440,
        prompt: copy.result.imagePrompt,
        materialSummary: blueprint.result.materialSummary,
        industryGuidance: blueprint.result.industryGuidance,
        reserveLogoSpace: Boolean(styled),
        seed: "membership-1:1",
        width: 1080,
      });

      expect(blueprint.result.sourceContext).toEqual({ materialIds: ["material-1"] });
      expect(blueprint.routing.attempts).toMatchObject([
        { errorCode: "INVALID_MODEL_OUTPUT", status: "FAILED" },
        { status: "SUCCEEDED" },
      ]);
      expect(copy.result.hashtags).toEqual(["全飞秒Pro", "专业科普"]);
      expect(image.output).toMatchObject({ height: 1440, mimeType: "image/png", width: 1080 });
      expect(capturedImagePrompt).toContain("活动需求是执行任务，不是海报文案");
      expect(capturedImagePrompt).toContain("品牌 Logo 将由系统直接使用原图合成");
      expect(capturedImagePrompt).toContain("禁止资料堆砌");
      expect(capturedImagePrompt).not.toContain("右下角");
      expect(capturedImagePrompt).toContain("准确主体身份或中立科普主题和两三个有依据");
      expect(capturedImagePrompt).toContain("已授权设备资料");
      expect(capturedImagePrompt).not.toContain("至多一个短标题与一句辅助文案");
      const prompts = [...capturedTextPrompts, capturedImagePrompt];
      for (const prompt of prompts) {
        expect(prompt).toContain("小红书发布边界优先于活动推广目标");
        expect(prompt).toContain("普通员工笔记仅生成不指向具体服务提供者的中立健康科普");
        expect(prompt).toContain("事实真实、素材授权、肖像授权或厂商认证均不代表获得公开推广许可");
        expect(prompt).toContain("标题、正文、话题、海报文字和画面一并遵守");
        expect(prompt).toContain("不得推荐或推广具体医院、医生、医疗服务或医疗器械");
        expect(prompt).toContain("不得引导私信咨询、推荐转介、预约到院、砍价或购买");
        expect(prompt).toContain("不得用谐音、缩写、打码、模糊称谓");
        expect(prompt).toContain("示例测试眼科屈光手术中心配备了德国蔡司全飞秒设备");
        expect(prompt.includes("MEDICAL_FROZEN_V1")).toBe(guidance === "configured");
        expect(prompt).not.toContain("不能覆盖授权事实");
      }
      expect(capturedTextPrompts.every((prompt) => prompt.includes("主体身份"))).toBe(true);
      expect(capturedTextPrompts.at(-1)).toContain("海报可引用的授权事实");
      if (styled) {
        expect(capturedImagePrompt).toContain("在左上角预留");
        expect(capturedImagePrompt).toContain("直接叠加在原有背景上");
        expect(capturedImagePrompt).toContain("标题、文字和重要主体避让");
      } else {
        expect(capturedImagePrompt).not.toContain("品牌安全区");
      }
      if (styled === "base") {
        expect(
          capturedTextPrompts.every(
            (prompt) =>
              prompt.includes("测试基础文案口吻规则") && prompt.includes("测试基础光影构图规则"),
          ),
        ).toBe(true);
        expect(capturedTextPrompts.join("\n")).not.toContain("内容方向（");
        expect(capturedTextPrompts.join("\n")).not.toContain("选定图片风格（");
        expect(capturedImagePrompt).toContain("测试基础光影构图规则");
        expect(capturedImagePrompt).toContain("尊重明确的视觉倾向");
        expect(capturedImagePrompt).not.toContain("选定图片风格");
        expect(blueprint.result.generationStyle).toEqual(generationStyle);
      } else if (styled) {
        expect(
          capturedTextPrompts.every(
            (prompt) => prompt.includes("测试基础文案口吻规则") && prompt.includes("常见问题解答"),
          ),
        ).toBe(true);
        expect(
          capturedTextPrompts.every(
            (prompt) => prompt.includes("测试基础光影构图规则") && prompt.includes("真实场景摄影"),
          ),
        ).toBe(true);
        expect(capturedImagePrompt).toContain("测试基础光影构图规则");
        expect(capturedImagePrompt).toContain("真实场景摄影");
        expect(capturedImagePrompt).not.toContain("测试基础文案口吻规则");
        expect(capturedImagePrompt).not.toContain("采用克制的编辑风 3D 插画");
        expect(capturedImagePrompt).toContain("仅在该风格内调整构图");
        expect(blueprint.result.generationStyle).toEqual(generationStyle);
      } else {
        expect(capturedImagePrompt).toContain("主体居中并保留充足安全边距");
      }
      expect(capturedImagePrompt).toContain("差异化构图要求");
      expect(capturedImagePrompt).toContain("membership-1:1");
    },
  );
});

describe("frozen style parsing", () => {
  it("preserves legacy campaigns but refuses malformed snapshots", () => {
    expect(readGenerationStyleSnapshot(undefined)).toBeUndefined();
    expect(() => readGenerationStyleSnapshot({ schemaVersion: 2 })).toThrow("Invalid frozen");
  });
});

describe("medical question generation", () => {
  it("uses the frozen problem and member facts, replaces the poster prompt, and refuses provider calls for local images", async () => {
    capturedTextPrompts.length = 0;
    const publisher = {
      schemaVersion: "medical-publisher-v1" as const,
      category: "ORDINARY" as const,
      allowBrandAttribution: false,
      allowPlatformConsultation: false,
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
          question: "初次了解要准备哪些问题？",
          intent: "准备",
          entityId: "",
          entityName: "",
        },
      ],
      publishers: [{ membershipId: "m", publisherContext: publisher }],
      frozenAt: "2026-10-13T08:00:00Z",
    };
    const router = new ModelRouter(
      [
        new QueueTextProvider([
          JSON.stringify({
            masterCopy:
              "先整理实际需求，再向专业人员逐项确认适用条件。公开资料不能替读者进行个人诊疗判断。",
            imageDirection:
              "第一张呈现准备问题，第二张列出需要核对的条件，问题卡不模拟真实诊疗场景。",
          }),
          JSON.stringify({
            title: "初次了解要准备哪些问题",
            body: "第一次了解相关信息时，可以先把自己想确认的事项列出来。\n公开内容只能帮助准备问题，不能替你判断是否适合某项诊疗。\n资料的适用条件、具体流程和需要携带什么，应根据实际情况向专业人员确认。",
            hashtags: ["准备问题"],
            imagePrompt:
              "问题卡第一张展示初次了解时需要准备的问题，不绘制照片证据，不添加品牌或Logo。",
          }),
        ]),
      ],
      [imageProvider],
    );
    const text = router.freezePolicy({
      id: "text",
      version: 1,
      kind: "TEXT",
      taskKind: "CAMPAIGN_BLUEPRINT",
      scopeType: "PLATFORM",
      primaryModel: { modelId: "text", providerId: "provider-a" },
      fallbackModels: [],
      maxAttemptsPerModel: 1,
    });
    const image = router.freezePolicy({
      ...text,
      id: "image",
      kind: "IMAGE",
      taskKind: "EMPLOYEE_IMAGE",
    });
    const adapter = new RoutedGenerationAdapter(router, {
      blueprint: text,
      employeeCopy: { ...text, taskKind: "EMPLOYEE_COPY" },
      employeeImage: image,
    });
    const context = { tenantId: "t", generationRunId: "r" };
    const blueprint = await adapter.generateBlueprint(context, {
      medicalPlan,
      title: "活动名称",
      prompt: "旧字段的推广要求不能进入医疗路径",
      materialSummary: "当前流程需要个体确认。",
      geoSummary: "",
      sensitiveRuleSummary: "",
      sourceContext: {},
    });
    const variant = await adapter.generateEmployeeVariant(context, blueprint.result, {
      medicalPublisher: publisher,
      employeeOrdinal: 1,
      title: "活动名称",
      uniquenessSeed: "m",
    });
    expect(blueprint.result.medicalPlan).toEqual(medicalPlan);
    expect(capturedTextPrompts.join("\n")).toContain("初次了解要准备哪些问题");
    expect(capturedTextPrompts.join("\n")).not.toContain("旧字段的推广要求");
    expect(capturedTextPrompts.join("\n")).not.toContain('"membershipId"');
    expect(capturedTextPrompts.join("\n")).not.toContain('"verifiedBy"');
    expect(capturedTextPrompts.at(-1)).toContain("获准员工可透明使用冻结真实岗位");
    expect(capturedTextPrompts.at(-1)).not.toContain("不要提及员工身份");
    expect(capturedTextPrompts.at(-1)).not.toContain("规划完整的 3:4 精致海报");
    expect(() =>
      adapter.generateImage(context, {
        medicalPlan,
        medicalPublisher: publisher,
        width: 1080,
        height: 1440,
        prompt: variant.result.imagePrompt,
        seed: "seed",
      }),
    ).toThrow("rendered locally");
  });
});

function requiredFixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}
