import type { components } from "@xhs-agentic/contracts";

type Assessment = components["schemas"]["CampaignRiskAssessmentDto"];

function isUnavailable(message: string): boolean {
  return (
    /^\s*REVIEW_UNAVAILABLE(?:\s*\([\d.]+\))?(?:\s*[:：]|$)/u.test(message) ||
    message.trimStart().startsWith("本次整体审核未完成")
  );
}

function readableMessage(message: string): string {
  const text = message.replace(/^[A-Z][A-Z0-9_]*(?:\s*\([\d.]+\))?\s*[:：]\s*/u, "");
  return /^[A-Z][A-Z0-9_]+$/u.test(text)
    ? "这条内容需要人工核对，请结合图文检查是否符合活动要求。"
    : text;
}

export function contentReviewSummary(assessment: Assessment) {
  const warnings = (assessment.warnings ?? []).filter((message) => !isUnavailable(message));
  const blocks = assessment.unresolvedBlocks ?? [];
  const unavailable = (assessment.warnings ?? []).some(isUnavailable);
  const manuallyConfirmed =
    assessment.passed && assessment.reviewDisposition?.type === "WARNING_ACCEPTED";
  const label = manuallyConfirmed
    ? "已人工确认可用"
    : blocks.length
      ? "内容需要修改"
      : assessment.passed
        ? "自动检查通过"
        : unavailable
          ? "自动审核未完成"
          : "请人工核对内容";
  const tone = assessment.passed
    ? ("success" as const)
    : blocks.length
      ? ("danger" as const)
      : ("warning" as const);
  return {
    unavailable,
    manuallyConfirmed,
    label,
    tone,
    warningCount: warnings.length,
    canConfirm: !assessment.passed && blocks.length === 0 && (assessment.warnings?.length ?? 0) > 0,
    messages: [...blocks, ...warnings, ...(assessment.notices ?? [])]
      .filter((message) => !isUnavailable(message))
      .map(readableMessage),
  };
}
