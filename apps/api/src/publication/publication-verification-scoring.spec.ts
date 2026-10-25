import { describe, expect, it } from "vitest";
import { evaluatePublicationEvidence } from "./publication-verification-scoring";

const expected = {
  body: "全飞秒 Pro 需要规范术前评估，设备扫描时间约 10 秒，效果存在个体差异。",
  hashtags: ["全飞秒Pro", "近视手术"],
  images: [
    {
      checksum: "a".repeat(64),
      imageUrl: "https://assets.example.test/employee.png",
      perceptualHash: "0123456789abcdef",
    },
  ],
  title: "理性了解全飞秒 Pro",
} as const;

const policy = {
  imageSimilarityThreshold: 0.8,
  manualReviewMargin: 0.1,
  requireImageMatch: true,
  textSimilarityThreshold: 0.55,
} as const;

describe("publication evidence scoring", () => {
  it("passes matching copy and an exact employee image", () => {
    const evaluation = evaluatePublicationEvidence({
      actual: {
        ...expected,
        images: [{ checksum: "a".repeat(64), perceptualHash: null, url: null }],
      },
      expected,
      policy,
    });

    expect(evaluation).toMatchObject({
      decision: "VALID",
      factScore: 1,
      imageScore: 1,
      textScore: 1,
    });
  });

  it("uses perceptual hashes for compressed or transformed public images", () => {
    const evaluation = evaluatePublicationEvidence({
      actual: {
        ...expected,
        images: [{ checksum: null, perceptualHash: "0123456789abcdee", url: null }],
      },
      expected,
      policy,
    });

    expect(evaluation.decision).toBe("VALID");
    expect(evaluation.imageScore).toBeGreaterThan(0.9);
  });

  it("sends otherwise matching content with missing image evidence to review", () => {
    const evaluation = evaluatePublicationEvidence({
      actual: { ...expected, images: [] },
      expected,
      policy,
    });

    expect(evaluation).toMatchObject({ decision: "MANUAL_REVIEW", imageScore: null });
  });

  it("rejects unrelated content and does not let a matching image hide the mismatch", () => {
    const evaluation = evaluatePublicationEvidence({
      actual: {
        body: "今天分享一家咖啡店的甜品和环境。",
        hashtags: ["咖啡"],
        images: [{ checksum: "a".repeat(64), perceptualHash: null, url: null }],
        title: "周末探店",
      },
      expected,
      policy,
    });

    expect(evaluation.decision).toBe("INVALID");
    expect(evaluation.textScore).toBeLessThan(policy.textSimilarityThreshold);
  });

  it("does not auto-pass changed numeric facts", () => {
    const evaluation = evaluatePublicationEvidence({
      actual: {
        ...expected,
        body: "全飞秒 Pro 需要规范术前评估，设备扫描时间约 30 秒，效果存在个体差异。",
        images: [{ checksum: "a".repeat(64), perceptualHash: null, url: null }],
      },
      expected,
      policy,
    });

    expect(evaluation.decision).not.toBe("VALID");
    expect(evaluation.factScore).toBe(0);
  });

  it("does not mark a copied title as a full post even when the employee image matches", () => {
    const noNumericFacts = {
      ...expected,
      body: "选择手术方式前，应先进行眼部检查。医生会结合角膜情况、日常用眼需求和其他评估结果，介绍适合的方案及潜在限制。",
    };
    const evaluation = evaluatePublicationEvidence({
      actual: {
        body: "",
        hashtags: [],
        images: [{ checksum: "a".repeat(64), perceptualHash: null, url: null }],
        title: noNumericFacts.title,
      },
      expected: noNumericFacts,
      policy,
    });

    expect(evaluation.textScore).toBeLessThan(policy.textSimilarityThreshold);
    expect(evaluation.decision).toBe("INVALID");
  });
});
