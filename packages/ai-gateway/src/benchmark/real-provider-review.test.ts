import { describe, expect, it } from "vitest";
import {
  createRealProviderReviewTemplate,
  evaluateRealProviderReview,
  REAL_PROVIDER_REVIEW_CRITERIA_VERSION,
} from "./real-provider-review";

const firstMembershipId = "membership-001";
const secondMembershipId = "membership-002";
const membershipIds = [firstMembershipId, secondMembershipId];

describe("real provider manual review", () => {
  it("creates a pending non-synthetic review template", () => {
    const template = createRealProviderReviewTemplate("benchmark-1", [
      { employeeMembershipId: firstMembershipId, imagePath: "./001.png", title: "标题一" },
      { employeeMembershipId: secondMembershipId, imagePath: "./002.png", title: "标题二" },
    ]);

    expect(template).toMatchObject({
      benchmarkId: "benchmark-1",
      criteriaVersion: REAL_PROVIDER_REVIEW_CRITERIA_VERSION,
      schemaVersion: 1,
      synthetic: false,
    });
    expect(template.entries).toEqual([
      expect.objectContaining({ decision: "PENDING", employeeMembershipId: membershipIds[0] }),
      expect.objectContaining({ decision: "PENDING", employeeMembershipId: membershipIds[1] }),
    ]);
  });

  it("accepts a complete approved review above the configured pass rate", () => {
    const evaluation = evaluateRealProviderReview(
      completeReview([
        reviewEntry(firstMembershipId, "PASS"),
        reviewEntry(secondMembershipId, "PASS"),
      ]),
      "benchmark-1",
      membershipIds,
      0.9,
    );

    expect(evaluation).toMatchObject({
      accepted: true,
      complete: true,
      failCount: 0,
      passCount: 2,
      passRate: 1,
      pendingCount: 0,
    });
  });

  it("rejects incomplete reviews and reports missing entries", () => {
    const evaluation = evaluateRealProviderReview(
      completeReview([reviewEntry(firstMembershipId, "PASS")]),
      "benchmark-1",
      membershipIds,
      0.9,
    );

    expect(evaluation.accepted).toBe(false);
    expect(evaluation.complete).toBe(false);
    expect(evaluation.errors).toContain(`review is missing entry: ${membershipIds[1]}`);
    expect(evaluation.pendingCount).toBe(1);
  });

  it("rejects hard safety failures even when the reviewer approves the batch", () => {
    const evaluation = evaluateRealProviderReview(
      completeReview([
        reviewEntry(firstMembershipId, "PASS"),
        {
          decision: "FAIL",
          employeeMembershipId: membershipIds[1],
          issues: ["IMAGE_SAFETY"],
          notes: "包含不合规医疗效果表达",
        },
      ]),
      "benchmark-1",
      membershipIds,
      0.5,
    );

    expect(evaluation).toMatchObject({
      accepted: false,
      complete: true,
      hardFailureCount: 1,
      passRate: 0.5,
    });
  });
});

function completeReview(entries: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    benchmarkId: "benchmark-1",
    conclusion: { decision: "APPROVED", notes: "可用于试点" },
    criteriaVersion: REAL_PROVIDER_REVIEW_CRITERIA_VERSION,
    entries,
    reviewedAt: "2026-08-28T12:00:00.000Z",
    reviewer: "测试复核员",
    schemaVersion: 1,
    synthetic: false,
  };
}

function reviewEntry(
  employeeMembershipId: string,
  decision: "PASS" | "FAIL",
): Record<string, unknown> {
  return { decision, employeeMembershipId, issues: [], notes: "" };
}
