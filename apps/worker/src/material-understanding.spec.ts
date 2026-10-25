import { describe, expect, it } from "vitest";
import {
  parseMaterialAnalysis,
  type UnderstandingInput,
  understandingPrompt,
} from "./material-understanding";

const input: UnderstandingInput = {
  tenantId: "tenant",
  enterpriseId: "enterprise",
  materialId: "material",
  type: "IMAGE_REFERENCE",
  text: "",
  fileName: "IMG_0042.jpg",
  supplement: "",
  imageBytes: new Uint8Array([1]),
};
const response = {
  title: "人物照片",
  summary: "一位人物的肖像。",
  keywords: ["人物", "照片"],
  entities: [],
  suggestedUses: [],
  missingInformation: [],
  personFocused: true,
  visualDescription: "一位穿白色外套的人物。",
  recognizedText: "",
};

describe("material understanding evidence and clarification", () => {
  it("organizes medical answers around the question and source without default expert requirements", () => {
    const prompt = understandingPrompt({
      ...input,
      type: "TEXT",
      imageBytes: undefined,
      text: "初诊请携带已有检查结果。",
      medicalMaterial: {
        schemaVersion: "medical-material-v1",
        purpose: "ANSWER_EVIDENCE",
        question: "初诊带什么？",
        sourceNote: "企业已核对的初诊流程",
      },
    });
    expect(prompt).toContain('"question":"初诊带什么？"');
    expect(prompt).toContain('"sourceNote":"企业已核对的初诊流程"');
    expect(prompt).toContain("不要求无关医生姓名、职称、履历、设备型号或配图");
    expect(prompt).not.toContain("例如林院长、全飞秒");
  });
  it("accepts an explicit environment purpose without demanding names, titles or written descriptions", () => {
    const sceneInput: UnderstandingInput = {
      ...input,
      medicalMaterial: {
        schemaVersion: "medical-material-v1",
        purpose: "REAL_SCENE",
        sceneType: "ENVIRONMENT",
        privacyConfirmed: true,
      },
    };
    const result = parseMaterialAnalysis(
      JSON.stringify({
        ...response,
        personFocused: false,
        identityRequired: false,
        title: "大厅实拍",
        summary: "画面展示室内大厅。",
        keywords: [],
        visualDescription: "室内有座椅和通道。",
      }),
      sceneInput,
    );
    expect(result.missingInformation).toEqual([]);
    expect(understandingPrompt(sceneInput)).toContain("环境照片不能证明医疗效果、医生资质");
  });
  it("still asks for a concrete purpose for an unspecified OTHER scene", () => {
    const result = parseMaterialAnalysis(JSON.stringify({ ...response, personFocused: false }), {
      ...input,
      medicalMaterial: {
        schemaVersion: "medical-material-v1",
        purpose: "REAL_SCENE",
        sceneType: "OTHER",
        privacyConfirmed: true,
      },
    });
    expect(result.missingInformation).toContain("请补充这份资料的具体主题、主体或用途。");
  });
  it("retains identity clarification when a medical image actually needs a specific person", () => {
    const result = parseMaterialAnalysis(
      JSON.stringify({ ...response, identityRequired: true, keywords: ["肖像"] }),
      {
        ...input,
        medicalMaterial: {
          schemaVersion: "medical-material-v1",
          purpose: "REAL_SCENE",
          sceneType: "WORKSPACE",
          privacyConfirmed: true,
        },
      },
    );
    expect(result.missingInformation).toContain(
      "请确认是否需要指代照片中的具体人物；需要时补充身份与使用场景。",
    );
    expect(result.missingInformation.join(" ")).not.toContain("林院长");
  });
  it("classifies malformed model JSON without echoing the model response", () => {
    expect(() => parseMaterialAnalysis("sk-private uploaded confidential material", input)).toThrow(
      "MATERIAL_ANALYSIS_INVALID_OUTPUT",
    );
  });
  it("does not require a separate group document when the hospital introduction names the group", () => {
    const result = parseMaterialAnalysis(
      JSON.stringify({
        ...response,
        personFocused: false,
        title: "示例测试眼科医院介绍",
        summary: "介绍医院及其集团背景。",
        keywords: ["示例测试眼科医院", "示例眼科集团"],
        entities: [
          {
            name: "示例眼科集团",
            aliases: [],
            kind: "BRAND",
            source: "CONTENT",
            evidence: "医院是示例眼科集团的成员单位。",
          },
        ],
      }),
      {
        ...input,
        type: "TEXT",
        imageBytes: undefined,
        text: "示例测试眼科医院隶属于声名远扬的示例眼科集团。",
      },
    );
    expect(result.missingInformation).toEqual([]);
    expect(result.entities[0]?.evidence).toBe("示例眼科集团");
  });
  it("tolerates full-width punctuation and whitespace without changing factual meaning", () => {
    const result = parseMaterialAnalysis(
      JSON.stringify({
        ...response,
        personFocused: false,
        title: "技术资料",
        summary: "原文介绍项目。",
        keywords: ["项目A"],
        entities: [
          {
            name: "项目A",
            aliases: [],
            kind: "PROJECT",
            source: "CONTENT",
            evidence: "项目A（不适用于未成年人）",
          },
        ],
      }),
      { ...input, imageBytes: undefined, text: "项目A (不适用于未成年人)" },
    );
    expect(result.entities).toHaveLength(1);
    expect(result.missingInformation).toEqual([]);
  });
  it("drops an invented extra entity and its keyword instead of demanding unrelated user documents", () => {
    const result = parseMaterialAnalysis(
      JSON.stringify({
        ...response,
        personFocused: false,
        title: "门店介绍",
        summary: "门店位于郑州。",
        keywords: ["郑州门店", "虚构集团"],
        entities: [
          { name: "虚构集团", aliases: [], kind: "BRAND", source: "CONTENT", evidence: "虚构集团" },
        ],
      }),
      { ...input, imageBytes: undefined, text: "郑州门店位于郑州。" },
    );
    expect(result.entities).toEqual([]);
    expect(result.keywords).toEqual(["郑州门店"]);
    expect(result.missingInformation).toEqual([]);
  });
  it("does not publish an invented entity in the AI summary", () => {
    expect(() =>
      parseMaterialAnalysis(
        JSON.stringify({
          ...response,
          personFocused: false,
          title: "门店介绍",
          summary: "门店属于虚构集团。",
          keywords: ["郑州门店", "虚构集团"],
          entities: [
            {
              name: "虚构集团",
              aliases: [],
              kind: "BRAND",
              source: "CONTENT",
              evidence: "虚构集团",
            },
          ],
        }),
        { ...input, imageBytes: undefined, text: "郑州门店位于郑州。" },
      ),
    ).toThrow("MATERIAL_ANALYSIS_UNGROUNDED_SUMMARY");
  });
  it("blocks an ambiguous portrait even if the model claims it is complete", () => {
    const result = parseMaterialAnalysis(JSON.stringify(response), input);
    expect(result.missingInformation.some((question) => question.includes("人物"))).toBe(true);
  });
  it("does not establish identity from a filename", () => {
    const result = parseMaterialAnalysis(
      JSON.stringify({
        ...response,
        keywords: ["林院长"],
        entities: [
          { name: "林院长", aliases: [], kind: "PERSON", source: "FILENAME", evidence: "林院长" },
        ],
      }),
      { ...input, fileName: "林院长.jpg" },
    );
    expect(result.missingInformation.length).toBeGreaterThan(0);
  });
  it("retains supported person and procedure keywords after a concrete supplement", () => {
    const supplement = "照片中是本院林院长，用于林院长全飞秒手术介绍。";
    const result = parseMaterialAnalysis(
      JSON.stringify({
        ...response,
        title: "林院长介绍照片",
        keywords: ["林院长", "全飞秒"],
        entities: [
          {
            name: "林院长",
            aliases: [],
            kind: "PERSON",
            source: "SUPPLEMENT",
            evidence: "本院林院长",
          },
        ],
      }),
      { ...input, supplement },
    );
    expect(result.missingInformation).toEqual([]);
    expect(result.keywords).toEqual(["林院长", "全飞秒"]);
  });
  it("rejects ungrounded entity evidence and refuses malformed output", () => {
    const result = parseMaterialAnalysis(
      JSON.stringify({
        ...response,
        keywords: ["林院长"],
        entities: [
          { name: "林院长", aliases: [], kind: "PERSON", source: "CONTENT", evidence: "林院长" },
        ],
      }),
      input,
    );
    expect(result.entities).toEqual([]);
    expect(result.missingInformation.length).toBeGreaterThan(0);
    expect(() => parseMaterialAnalysis('{"title":"看似成功"}', input)).toThrow();
  });
  it("does not require a meaningful filename when image text supports the subject", () => {
    const result = parseMaterialAnalysis(
      JSON.stringify({
        ...response,
        personFocused: false,
        title: "全飞秒设备",
        keywords: ["全飞秒", "设备"],
        recognizedText: "全飞秒设备",
        entities: [
          {
            name: "全飞秒",
            aliases: [],
            kind: "PROJECT",
            source: "IMAGE_TEXT",
            evidence: "全飞秒设备",
          },
        ],
      }),
      input,
    );
    expect(result.missingInformation).toEqual([]);
  });
});
