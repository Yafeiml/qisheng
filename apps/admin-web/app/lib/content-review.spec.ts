import { describe, expect, it } from "vitest";
import { contentReviewSummary } from "./content-review";

const unavailable = {
  passed: false,
  warnings: ["REVIEW_UNAVAILABLE: 本次整体审核未完成，请人工确认；未自动重复生成或审核。"],
  notices: [],
  replacedBlocks: [],
  unresolvedBlocks: [],
};

describe("customer content review explanation", () => {
  it("separates an incomplete service check from a content warning", () => {
    expect(contentReviewSummary(unavailable)).toMatchObject({
      unavailable: true,
      label: "自动审核未完成",
      tone: "warning",
      warningCount: 0,
      messages: [],
      canConfirm: true,
    });
  });
  it("keeps real findings visible and does not allow acceptance of blocked content", () => {
    expect(
      contentReviewSummary({
        ...unavailable,
        warnings: [...unavailable.warnings, "MEDICAL_CLAIM (0.8): 请核对是否存在效果承诺"],
        unresolvedBlocks: ["BLOCKED: 请修改不准确的表述"],
      }),
    ).toMatchObject({
      unavailable: true,
      label: "内容需要修改",
      warningCount: 1,
      messages: ["请修改不准确的表述", "请核对是否存在效果承诺"],
      canConfirm: false,
    });
  });
  it("does not present manual acceptance as an automatic pass", () => {
    expect(
      contentReviewSummary({
        ...unavailable,
        passed: true,
        reviewDisposition: { type: "WARNING_ACCEPTED" },
      }),
    ).toMatchObject({
      manuallyConfirmed: true,
      label: "已人工确认可用",
      tone: "success",
      canConfirm: false,
    });
  });
  it("recognizes historical plain-language service notices", () => {
    expect(
      contentReviewSummary({ ...unavailable, warnings: ["本次整体审核未完成，请人工确认"] }),
    ).toMatchObject({ unavailable: true, warningCount: 0, messages: [] });
    expect(
      contentReviewSummary({
        ...unavailable,
        warnings: [" REVIEW_UNAVAILABLE (0.5): 自动审核未完成"],
      }),
    ).toMatchObject({ unavailable: true, warningCount: 0, messages: [] });
  });
  it("preserves ordinary review findings and normal passed content", () => {
    expect(
      contentReviewSummary({ ...unavailable, warnings: ["医疗表述: 快速见效"] }),
    ).toMatchObject({
      unavailable: false,
      warningCount: 1,
      messages: ["医疗表述: 快速见效"],
      canConfirm: true,
    });
    expect(contentReviewSummary({ ...unavailable, passed: true, warnings: [] })).toMatchObject({
      label: "自动检查通过",
      tone: "success",
      unavailable: false,
      canConfirm: false,
    });
  });
});
