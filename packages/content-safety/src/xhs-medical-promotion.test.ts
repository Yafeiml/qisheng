import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HttpContentSafetyScanner } from "./http-content-safety";
import {
  CONTENT_SAFETY_INSTRUCTIONS,
  CONTENT_SAFETY_POLICY_VERSION,
  ModelContentSafetyScanner,
} from "./model-content-safety";
import type { ContentSafetyText } from "./types";
import { medicalPromotionCategories } from "./xhs-medical-promotion";

const bytes = Buffer.from("image-fixture");
const promotion =
  "示例测试眼科屈光手术中心配备了德国蔡司全飞秒设备，在硬件层面提供了稳定支持。示例测试眼科业务院长林示例是蔡司官方认证全飞秒手术专家。";
const options = {
  apiKey: "live-safety-key-123",
  endpoint: "https://safety.example.test/v1",
  model: "vision-model",
  provider: "TEST_SAFETY",
};

describe.each(["MODEL", "HTTP"] as const)("%s XHS medical promotion floor", (mode) => {
  function fixture(decision = "PASS", categories: unknown[] = []) {
    const result = { decision, categories, reviewedImages: [1] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify(
          mode === "MODEL"
            ? {
                choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
              }
            : result,
        ),
      ),
    );
    const scanner =
      mode === "MODEL"
        ? new ModelContentSafetyScanner({ ...options, fetch: fetcher })
        : new HttpContentSafetyScanner({ ...options, fetch: fetcher });
    const scan = (text: ContentSafetyText, sourceFacts?: string) =>
      scanner.scan({
        text,
        sourceFacts,
        requestId: "medical-repro",
        images: [
          {
            bytes,
            checksum: createHash("sha256").update(bytes).digest("hex"),
            sequence: 1,
            mimeType: "image/png",
          },
        ],
      });
    return { scan, fetcher };
  }

  it.each([
    promotion,
    "示例测试眼科配备德国蔡司全飞秒设备。",
    "林示例是蔡司官方认证全飞秒手术专家。",
    "眼科林院长曾获蔡司全飞秒卓越奖。",
    `${promotion}不保证疗效，个体存在差异。`,
    `不要把这当成广告，${promotion}`,
    "林示例是蔡司官方认证全飞秒手术专家并非蔡司代理商。",
    "林示例并非蔡司代理商但是蔡司官方认证全飞秒手术专家。",
    "林示例是蔡司官方认证全飞秒手术专家另一位医生并非蔡司官方认证专家。",
    "林示例并非蔡司官方认证专家另一位全飞秒医生是蔡司官方认证专家。",
  ])("blocks a factual promotional statement despite provider PASS: %s", async (body) => {
    const { scan, fetcher } = fixture();
    expect(await scan({ title: "摘镜做功课", body, hashtags: [] }, body)).toMatchObject({
      decision: "BLOCK",
      categories: [{ code: "XHS_MEDICAL_PROMOTION", decision: "BLOCK" }],
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    "全飞秒手术是否适合自己，需要结合角膜条件和专业评估，具体风险因人而异。",
    "示例测试眼科的林医生介绍全飞秒原理及适用条件。",
    "蔡司全飞秒设备的名称不是判断自己是否适合手术的依据。",
    "不要因为示例测试眼科配备德国蔡司全飞秒设备就认定更安全。",
    "不应将林示例是蔡司官方认证全飞秒手术专家作为推荐医生的依据。",
    "示例测试眼科没有配备蔡司全飞秒设备。",
    "林示例并非蔡司官方认证全飞秒手术专家。",
    "眼科医生提醒，蔡司设备的产品认证与个人手术适应条件是两回事。",
    "这家商场配备蔡司摄影设备，推荐摄影爱好者体验。",
  ])("preserves neutral or negated education: %s", async (body) => {
    expect(await fixture().scan({ title: "知识介绍", body, hashtags: [] })).toMatchObject({
      decision: "PASS",
      categories: [],
    });
  });

  it("reviews specific service recommendations with unknown platform eligibility", async () => {
    expect(
      await fixture().scan({
        title: "近视手术准备",
        body: "推荐示例测试眼科，预约全飞秒手术咨询。",
        hashtags: [],
      }),
    ).toMatchObject({ decision: "REVIEW" });
  });

  it("checks title and hashtags, while medical source facts alone do not trigger a risk", async () => {
    for (const text of [
      { title: promotion, body: "正文", hashtags: [] },
      { title: "标题", body: "正文", hashtags: [promotion] },
    ])
      expect((await fixture().scan(text)).decision).toBe("BLOCK");
    expect(
      (await fixture().scan({ title: "健康科普", body: "认识术前检查。", hashtags: [] }, promotion))
        .decision,
    ).toBe("PASS");
  });

  it("honors a blocking category even when the provider top-level decision says PASS", async () => {
    expect(
      await fixture("PASS", [{ code: "MEDICAL", decision: "BLOCK", message: "推广风险" }]).scan({
        title: "标题",
        body: "正文",
        hashtags: [],
      }),
    ).toMatchObject({ decision: "BLOCK" });
  });
});

it("exports a pure text detector and binds factual-truth exceptions to the updated policy", () => {
  expect(
    medicalPromotionCategories({ title: "标题", body: promotion, hashtags: [] }),
  ).toMatchObject([{ code: "XHS_MEDICAL_PROMOTION", decision: "BLOCK" }]);
  expect(CONTENT_SAFETY_POLICY_VERSION).toBe("xhs-employee-medical-publishing-v3");
  expect(CONTENT_SAFETY_INSTRUCTIONS).toContain("事实真实");
  expect(CONTENT_SAFETY_INSTRUCTIONS).toContain("白大褂医生肖像");
  expect(CONTENT_SAFETY_INSTRUCTIONS).not.toContain("允许普通健康科普、合法医疗机构和医生介绍");
});
