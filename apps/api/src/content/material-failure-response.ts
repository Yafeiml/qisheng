import { processingIssueGuidance } from "../platform-processing-issues/processing-issue-guidance";

export function materialFailureResponse(rawCode: string | null) {
  if (!rawCode) return { errorCode: null, errorMessage: null };
  const guidance = processingIssueGuidance(rawCode);
  return {
    errorCode: guidance.errorCode,
    errorMessage:
      guidance.stage === "FILE" ? guidance.reason : "请联系平台管理员处理，资料记录已保留。",
  };
}

export function safeMaterialFailureResponse<
  T extends { ingestionErrorCode: string | null; ingestionErrorMessage: string | null },
>(material: T) {
  const failure = materialFailureResponse(material.ingestionErrorCode);
  return {
    ...material,
    ingestionErrorCode: failure.errorCode,
    ingestionErrorMessage: failure.errorMessage,
  };
}
