import "reflect-metadata";
import {
  copyStyleInstructions,
  defaultGenerationStyles,
  type GenerationStyleConfiguration,
  type GenerationStylePreset,
  type GenerationStyleSnapshot,
  imageStyleInstructions,
  readGenerationStyleSnapshot,
  upgradeBuiltInGenerationStyles,
} from "@xhs-agentic/ai-gateway";
import { describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import researchedConfiguration from "./fixtures/generation-style-researched.json";
import { GenerationStyleService } from "./generation-style.service";

// Fixed historical values keep restoration tests independent of the current factory.
function legacyConfiguration(): GenerationStyleConfiguration {
  const preset = (
    id: string,
    name: string,
    description: string,
    prompt: string,
    isDefault = false,
  ): GenerationStylePreset => ({ id, name, description, prompt, enabled: true, isDefault });
  return {
    copyBasePrompt:
      "采用自然、具体的小红书表达。标题突出一个清晰的信息点，开头从读者真实关心的问题切入。正文用短段落，每段只讲一个重点；必要时少量使用 Emoji 和列表。避免广告腔、夸张堆词、重复感叹号及生硬引导。只依据授权资料表达，不编造亲身体验、患者故事、效果、价格或资质。结尾给出与正文相关的实用建议，话题标签简洁且准确。",
    imageBasePrompt:
      "生成精致、自然且主题明确的竖版配图。主体突出，构图有层次，光线柔和，色彩协调，材质与细节可信，背景简洁，避免元素堆砌、过度锐化、塑料质感和不自然的人体结构。重要主体置于安全裁切区，统一一组图片的视觉气质。严格保持所选视觉风格，不在摄影与插画之间自行切换。",
    contentDirections: [
      preset(
        "direction-education",
        "专业科普",
        "用易懂的表达说明原理、适用条件与注意事项。",
        "以专业科普为内容方向，围绕一个核心问题解释原理、适用条件及注意事项。专业术语第一次出现时用日常语言解释，保留必要的限制条件，不把科普写成效果承诺。",
        true,
      ),
      preset(
        "direction-questions",
        "常见问题解答",
        "从读者关心的问题出发，逐项给出清楚回答。",
        "以常见问题解答为内容方向。选取与本次主题最相关的读者问题，用提问与简短回答组织内容。优先解答决策前需要知道的信息，区分已知事实与需要进一步咨询的情况。",
      ),
      preset(
        "direction-project",
        "项目与技术介绍",
        "介绍项目特点、技术信息及服务流程。",
        "以项目与技术介绍为内容方向，突出授权资料中有依据的特点，结合流程解释其实际意义。每个卖点都对应具体事实，避免空泛的先进、领先和绝对化比较。",
      ),
    ],
    imageStyles: [
      preset(
        "image-documentary",
        "真实场景摄影",
        "自然光影、真实空间与克制的纪实构图。",
        "采用真实场景摄影风格，以本次活动相关的专业空间、设备或自然交流为主体。自然柔和光线，真实材质与透视，克制的色彩和景深。画面具有纪实摄影质感，不使用插画、卡通或 3D 渲染风格，不将虚构人物表现为指定的真实专家。",
        true,
      ),
      preset(
        "image-minimal",
        "简约静物摄影",
        "简洁背景、精致材质与清晰的视觉焦点。",
        "采用简约静物摄影风格，以主题相关的物件、器材或空间细节为主体。使用低饱和背景、柔和侧光和适度留白，重视材质、轮廓与视觉秩序。不出现人物，不切换为插画或卡通。",
      ),
      preset(
        "image-illustration",
        "科技感插画",
        "用克制的插画和抽象元素表达技术主题。",
        "采用精致的科技感编辑插画，以简洁的几何形态、抽象技术元素和柔和立体层次表达本期主题。配色协调，画面轻盈有留白，不伪装成真实诊疗照片，不绘制流程图或带文字的信息图。",
      ),
    ],
  };
}

function fixture(configuration: GenerationStyleConfiguration | null) {
  const row = configuration ? { configuration, version: 7 } : null;
  const writes = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  const prisma = {
    generationStyleConfiguration: {
      findUnique: vi.fn().mockResolvedValue(row),
      create: writes[0],
      update: writes[1],
      updateMany: writes[2],
    },
    auditLog: { create: writes[3] },
    $transaction: writes[4],
  };
  const access = {
    requireSaasAdmin: vi.fn().mockReturnValue({ userId: "admin", scope: { type: "PLATFORM" } }),
  };
  return {
    service: new GenerationStyleService(
      prisma as unknown as PrismaService,
      access as unknown as RequestAccessContext,
    ),
    row,
    writes,
  };
}

function assertReadOnly(writes: ReturnType<typeof vi.fn>[]) {
  for (const write of writes) expect(write).not.toHaveBeenCalled();
}

describe("generation style defaults without database writes", () => {
  it("freezes only Xiaohongshu base prompts for campaigns without selecting presets", async () => {
    const defaults = defaultGenerationStyles();
    const frozenPreset = await fixture(defaults).service.snapshot({
      contentDirectionPresetId: "direction-questions",
      imageStylePresetId: "image-minimal",
    });
    const before = structuredClone(frozenPreset);
    const configuration = structuredClone(defaults);
    for (const preset of [...configuration.contentDirections, ...configuration.imageStyles])
      preset.enabled = false;
    const { service, writes } = fixture(configuration);
    const snapshot = await service.snapshot();
    expect(snapshot).toMatchObject({
      configurationVersion: 7,
      copyBasePrompt: defaults.copyBasePrompt,
      imageBasePrompt: defaults.imageBasePrompt,
      contentDirection: { id: "", name: "小红书分享", prompt: "" },
      imageStyle: { id: "", name: "小红书配图", prompt: "" },
    });
    expect(copyStyleInstructions(snapshot)).toBe(`文案基础要求：\n${defaults.copyBasePrompt}`);
    expect(imageStyleInstructions(snapshot)).toBe(`图片基础要求：\n${defaults.imageBasePrompt}`);
    expect(readGenerationStyleSnapshot(snapshot)).toEqual(snapshot);
    expect(readGenerationStyleSnapshot(frozenPreset)).toEqual(before);
    assertReadOnly(writes);
  });

  it.each(["researched", "previous", "current"])(
    "restores unchanged %s built-ins only for new snapshots",
    async (version) => {
      const configuration = structuredClone(researchedConfiguration);
      if (version !== "researched")
        configuration.imageBasePrompt = configuration.imageBasePrompt
          .replace(
            "严格保持用户已选图片风格，不能自行在摄影、插画和卡通之间切换。",
            "活动明确的视觉要求优先；未指定时，根据主题与授权素材形成自然、协调的小红书视觉表达，同组图片保持统一。",
          )
          .replace("按品牌、素材和选定风格选择", "按品牌、素材和活动要求选择");
      if (version === "current")
        configuration.imageBasePrompt = configuration.imageBasePrompt
          .replace("竖版笔记封面或品牌分享海报", "竖版品牌分享海报")
          .replace("留白充足", "适度留白，为主体身份与事实要点安排清楚的信息区")
          .replace(
            "需要文字时，仅用一个约 6–12 字的短主标题和至多一句简短辅助文案，必要时可少字或无字。",
            "默认展示一个简短主标题、一条准确主体身份及两三个有资料依据的短要点，形成清楚的海报信息层级。资料不足时减少要点，用户明确要求极简或无字时尊重该要求。",
          );
      const before = structuredClone(configuration);
      const { service, row, writes } = fixture(configuration);
      expect(await service.platformCurrent()).toEqual({ ...legacyConfiguration(), version: 7 });
      const next = await service.snapshot({});
      expect(next.copyBasePrompt).toBe(legacyConfiguration().copyBasePrompt);
      expect(next.imageBasePrompt).toBe(legacyConfiguration().imageBasePrompt);
      expect(row?.configuration).toEqual(before);
      assertReadOnly(writes);
      configuration.imageBasePrompt += "\n管理员补充：使用品牌暖色。";
      expect((await fixture(configuration).service.snapshot()).imageBasePrompt).toBe(
        configuration.imageBasePrompt,
      );
    },
  );

  it("uses the original generic defaults for new snapshots and keeps the stored version", async () => {
    const original = legacyConfiguration();
    const before = structuredClone(original);
    const { service, row, writes } = fixture(original);
    const defaults = defaultGenerationStyles();
    expect(defaults).toEqual(before);
    const current = await service.platformCurrent();
    const snapshot = await service.snapshot({});

    expect(current.version).toBe(7);
    expect(current.copyBasePrompt).toBe(defaults.copyBasePrompt);
    expect(current.imageBasePrompt).toBe(defaults.imageBasePrompt);
    expect(current.copyBasePrompt).toBe(before.copyBasePrompt);
    expect(current.imageBasePrompt).toBe(before.imageBasePrompt);
    for (const kind of ["contentDirections", "imageStyles"] as const) {
      expect(current[kind].map((preset) => preset.id)).toEqual(
        before[kind].map((preset) => preset.id),
      );
      for (const preset of current[kind]) {
        expect(preset.prompt).toBe(defaults[kind].find((entry) => entry.id === preset.id)?.prompt);
      }
    }
    expect(snapshot).toMatchObject({
      configurationVersion: 7,
      copyBasePrompt: defaults.copyBasePrompt,
      imageBasePrompt: defaults.imageBasePrompt,
      contentDirection: { prompt: defaults.contentDirections[0]?.prompt },
      imageStyle: { prompt: defaults.imageStyles[0]?.prompt },
    });
    expect(row).toEqual({ version: 7, configuration: before });
    assertReadOnly(writes);
  });

  it("preserves administrator prompts, ordering, enabled states and default choices", async () => {
    const custom = legacyConfiguration();
    custom.copyBasePrompt = "管理员自定义文案基础要求，使用品牌专属叙述。";
    custom.imageBasePrompt = "管理员自定义图片基础要求，使用品牌专属色彩。";
    for (const kind of ["contentDirections", "imageStyles"] as const) {
      custom[kind].reverse();
      custom[kind].forEach((preset, index) => {
        preset.prompt = `管理员自定义的 ${preset.id} 提示词，保持品牌表达。`;
        preset.enabled = index !== 2;
        preset.isDefault = index === 0;
      });
    }
    const before = structuredClone(custom);
    const { service, row, writes } = fixture(custom);

    expect(await service.platformCurrent()).toEqual({ ...before, version: 7 });
    expect(await service.snapshot({})).toMatchObject({
      configurationVersion: 7,
      copyBasePrompt: before.copyBasePrompt,
      imageBasePrompt: before.imageBasePrompt,
      contentDirection: {
        id: before.contentDirections[0]?.id,
        prompt: before.contentDirections[0]?.prompt,
      },
      imageStyle: { id: before.imageStyles[0]?.id, prompt: before.imageStyles[0]?.prompt },
    });
    expect(row).toEqual({ version: 7, configuration: before });
    assertReadOnly(writes);
  });

  it("leaves the text in already frozen researched snapshots unchanged", async () => {
    const original = structuredClone(researchedConfiguration);
    const direction = original.contentDirections[0];
    const imageStyle = original.imageStyles[0];
    if (!direction || !imageStyle) throw new Error("Missing legacy default preset");
    const frozen: GenerationStyleSnapshot = {
      schemaVersion: 1,
      configurationVersion: 7,
      copyBasePrompt: original.copyBasePrompt,
      imageBasePrompt: original.imageBasePrompt,
      contentDirection: { id: direction.id, name: direction.name, prompt: direction.prompt },
      imageStyle: { id: imageStyle.id, name: imageStyle.name, prompt: imageStyle.prompt },
    };
    const before = structuredClone(frozen);
    const { service, writes } = fixture(original);

    const next = await service.snapshot({});
    expect(next.copyBasePrompt).not.toBe(before.copyBasePrompt);
    expect(next.imageBasePrompt).not.toBe(before.imageBasePrompt);
    expect(readGenerationStyleSnapshot(frozen)).toEqual(before);
    expect(frozen).toEqual(before);
    assertReadOnly(writes);
  });

  it("restores fields independently and preserves presets with customized names or descriptions", async () => {
    const original = structuredClone(researchedConfiguration);
    original.copyBasePrompt = "管理员自定义文案要求：严肃正式，不要 Emoji，请保留完整内容。";
    const education = original.contentDirections.find(
      (preset) => preset.id === "direction-education",
    );
    const questions = original.contentDirections.find(
      (preset) => preset.id === "direction-questions",
    );
    if (!education || !questions) throw new Error("Missing legacy content presets");
    education.name = "品牌自定义科普";
    questions.description = "管理员自定义的内容方向说明。";
    original.imageStyles.reverse();
    original.imageStyles.forEach((preset, index) => {
      preset.enabled = index !== 2;
      preset.isDefault = index === 0;
    });
    const customId = researchedConfiguration.contentDirections[0];
    if (!customId) throw new Error("Missing content preset");
    original.contentDirections.push({ ...customId, id: "custom-education", isDefault: false });
    const before = structuredClone(original);
    const { service, row, writes } = fixture(original);
    const defaults = defaultGenerationStyles();
    const current = await service.platformCurrent();

    expect(current.copyBasePrompt).toBe(before.copyBasePrompt);
    expect(current.imageBasePrompt).toBe(defaults.imageBasePrompt);
    for (const id of ["direction-education", "direction-questions"]) {
      expect(current.contentDirections.find((preset) => preset.id === id)).toEqual(
        before.contentDirections.find((preset) => preset.id === id),
      );
    }
    expect(current.contentDirections.find((preset) => preset.id === "custom-education")).toEqual(
      before.contentDirections.find((preset) => preset.id === "custom-education"),
    );
    expect(
      current.contentDirections.find((preset) => preset.id === "direction-project")?.prompt,
    ).toBe(defaults.contentDirections.find((preset) => preset.id === "direction-project")?.prompt);
    const snapshot = await service.snapshot({ contentDirectionPresetId: "direction-project" });
    const instructions = copyStyleInstructions(snapshot);
    expect(instructions).toContain(before.copyBasePrompt);
    expect(snapshot.contentDirection.prompt).toBe(
      defaults.contentDirections.find((preset) => preset.id === "direction-project")?.prompt,
    );
    expect(current.imageStyles).toEqual(
      before.imageStyles.map((preset) => ({
        ...preset,
        prompt: defaults.imageStyles.find((entry) => entry.id === preset.id)?.prompt,
      })),
    );
    expect(row).toEqual({ version: 7, configuration: before });
    assertReadOnly(writes);
  });

  it("keeps persisted and restored configurations immutable across repeated reads", () => {
    const original = structuredClone(researchedConfiguration);
    const before = structuredClone(original);
    const upgraded = upgradeBuiltInGenerationStyles(original);
    const upgradedBefore = structuredClone(upgraded);

    expect(upgraded.copyBasePrompt).not.toBe(before.copyBasePrompt);
    expect(upgraded.imageBasePrompt).not.toBe(before.imageBasePrompt);
    expect(upgradeBuiltInGenerationStyles(upgraded)).toEqual(upgradedBefore);
    expect(upgraded).toEqual(upgradedBefore);
    expect(original).toEqual(before);
  });

  it("uses the new defaults when no platform configuration has been saved", async () => {
    const { service, writes } = fixture(null);
    expect(await service.platformCurrent()).toEqual({ ...defaultGenerationStyles(), version: 0 });
    expect(await service.snapshot({})).toMatchObject({ configurationVersion: 0 });
    assertReadOnly(writes);
  });
});
