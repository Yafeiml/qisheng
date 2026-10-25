export const REAL_PROVIDER_REVIEW_SCHEMA_VERSION = 1;
export const REAL_PROVIDER_REVIEW_CRITERIA_VERSION = "xhs-pilot-quality-v1";

export const REAL_PROVIDER_REVIEW_ISSUES = [
  "FACTUAL_ACCURACY",
  "COPY_STYLE",
  "IMAGE_RELEVANCE",
  "IMAGE_QUALITY",
  "IMAGE_SAFETY",
  "IMAGE_DUPLICATION",
  "OTHER",
] as const;

export type RealProviderReviewIssue = (typeof REAL_PROVIDER_REVIEW_ISSUES)[number];

export interface RealProviderReviewTarget {
  employeeMembershipId: string;
  imagePath: string;
  title: string;
}

export interface RealProviderReviewEvaluation {
  accepted: boolean;
  complete: boolean;
  errors: readonly string[];
  failCount: number;
  hardFailureCount: number;
  passCount: number;
  passRate: number;
  pendingCount: number;
  reviewedCount: number;
}

export function createRealProviderReviewTemplate(
  benchmarkId: string,
  targets: readonly RealProviderReviewTarget[],
): Record<string, unknown> {
  return {
    benchmarkId,
    conclusion: {
      decision: "PENDING",
      notes: "",
    },
    criteriaVersion: REAL_PROVIDER_REVIEW_CRITERIA_VERSION,
    entries: targets.map((target) => ({
      decision: "PENDING",
      employeeMembershipId: target.employeeMembershipId,
      imagePath: target.imagePath,
      issues: [],
      notes: "",
      title: target.title,
    })),
    generatedAt: new Date().toISOString(),
    instructions: [
      "逐项核对文案事实、小红书表达、图片相关性、图片质量、安全性和视觉重复风险。",
      "PASS 项不得选择问题；FAIL 项必须至少选择一个问题并填写说明。",
      "完成全部条目后填写 reviewer、reviewedAt，并将 conclusion.decision 改为 APPROVED 或 REJECTED。",
    ],
    reviewedAt: "",
    reviewer: "",
    schemaVersion: REAL_PROVIDER_REVIEW_SCHEMA_VERSION,
    synthetic: false,
  };
}

export function evaluateRealProviderReview(
  value: unknown,
  expectedBenchmarkId: string,
  expectedMembershipIds: readonly string[],
  minimumPassRate: number,
): RealProviderReviewEvaluation {
  if (!Number.isFinite(minimumPassRate) || minimumPassRate < 0 || minimumPassRate > 1) {
    throw new Error("Manual review minimum pass rate must be between 0 and 1");
  }
  if (new Set(expectedMembershipIds).size !== expectedMembershipIds.length) {
    throw new Error("Expected manual review membership IDs must be unique");
  }

  const errors: string[] = [];
  const review = recordValue(value);
  if (review.schemaVersion !== REAL_PROVIDER_REVIEW_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${REAL_PROVIDER_REVIEW_SCHEMA_VERSION}`);
  }
  if (review.synthetic !== false) errors.push("synthetic must be false");
  if (review.benchmarkId !== expectedBenchmarkId) errors.push("benchmarkId does not match report");
  if (review.criteriaVersion !== REAL_PROVIDER_REVIEW_CRITERIA_VERSION) {
    errors.push(`criteriaVersion must be ${REAL_PROVIDER_REVIEW_CRITERIA_VERSION}`);
  }
  if (typeof review.reviewer !== "string" || review.reviewer.trim().length < 2) {
    errors.push("reviewer must contain at least two characters");
  }
  if (
    typeof review.reviewedAt !== "string" ||
    review.reviewedAt.length === 0 ||
    Number.isNaN(Date.parse(review.reviewedAt))
  ) {
    errors.push("reviewedAt must be a valid date-time");
  }

  const conclusion = recordValue(review.conclusion);
  const conclusionDecision = conclusion.decision;
  if (conclusionDecision !== "APPROVED" && conclusionDecision !== "REJECTED") {
    errors.push("conclusion.decision must be APPROVED or REJECTED");
  }

  const expectedIds = new Set(expectedMembershipIds);
  const reviewEntries = Array.isArray(review.entries) ? review.entries : [];
  if (!Array.isArray(review.entries)) errors.push("entries must be an array");
  const seen = new Set<string>();
  let passCount = 0;
  let failCount = 0;
  let pendingCount = 0;
  let hardFailureCount = 0;

  for (const rawEntry of reviewEntries) {
    const entry = recordValue(rawEntry);
    const membershipId = entry.employeeMembershipId;
    if (typeof membershipId !== "string" || !expectedIds.has(membershipId)) {
      errors.push("review contains an unknown employeeMembershipId");
      continue;
    }
    if (seen.has(membershipId)) {
      errors.push(`review contains duplicate entry: ${membershipId}`);
      continue;
    }
    seen.add(membershipId);
    const issues = parseIssues(entry.issues, membershipId, errors);
    if (entry.decision === "PASS") {
      passCount += 1;
      if (issues.length > 0) errors.push(`PASS entry ${membershipId} must not contain issues`);
      continue;
    }
    if (entry.decision === "FAIL") {
      failCount += 1;
      if (issues.length === 0) errors.push(`FAIL entry ${membershipId} must contain an issue`);
      if (typeof entry.notes !== "string" || entry.notes.trim().length < 2) {
        errors.push(`FAIL entry ${membershipId} must contain review notes`);
      }
      if (issues.some((issue) => issue === "FACTUAL_ACCURACY" || issue === "IMAGE_SAFETY")) {
        hardFailureCount += 1;
      }
      continue;
    }
    pendingCount += 1;
  }

  for (const expectedId of expectedMembershipIds) {
    if (!seen.has(expectedId)) errors.push(`review is missing entry: ${expectedId}`);
  }
  pendingCount += expectedMembershipIds.length - seen.size;
  const reviewedCount = passCount + failCount;
  const passRate = reviewedCount === 0 ? 0 : passCount / reviewedCount;
  const complete =
    errors.length === 0 && pendingCount === 0 && reviewedCount === expectedMembershipIds.length;
  return {
    accepted:
      complete &&
      conclusionDecision === "APPROVED" &&
      passRate >= minimumPassRate &&
      hardFailureCount === 0,
    complete,
    errors: Object.freeze(errors),
    failCount,
    hardFailureCount,
    passCount,
    passRate,
    pendingCount,
    reviewedCount,
  };
}

function parseIssues(
  value: unknown,
  membershipId: string,
  errors: string[],
): RealProviderReviewIssue[] {
  if (!Array.isArray(value)) {
    errors.push(`issues must be an array for ${membershipId}`);
    return [];
  }
  const issues: RealProviderReviewIssue[] = [];
  for (const issue of value) {
    if (!REAL_PROVIDER_REVIEW_ISSUES.includes(issue as RealProviderReviewIssue)) {
      errors.push(`review contains an unsupported issue for ${membershipId}`);
      continue;
    }
    issues.push(issue as RealProviderReviewIssue);
  }
  if (new Set(issues).size !== issues.length) {
    errors.push(`review contains duplicate issues for ${membershipId}`);
  }
  return issues;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
