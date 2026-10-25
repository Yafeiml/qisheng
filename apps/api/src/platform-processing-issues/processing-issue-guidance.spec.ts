import { describe, expect, it } from "vitest";
import { processingIssueGuidance } from "./processing-issue-guidance";

describe("administrator guidance for verified supplier model permissions", () => {
  it.each(["MATERIAL_ANALYSIS_MODEL_NOT_ALLOWED", "EMBEDDING_MODEL_NOT_ALLOWED"])(
    "explains %s as a model grant problem rather than an invalid key",
    (code) => {
      const result = processingIssueGuidance(code);
      expect(result).toMatchObject({
        errorCode: code,
        stage: code.startsWith("EMBEDDING_") ? "EMBEDDING" : "ANALYSIS",
        settingsPath: "/platform/models",
      });
      expect(result.reason).toContain("未获得当前供应商密钥的调用权限");
      expect(result.reason).not.toContain("认证失败");
      expect(result.suggestedActions[0]).toContain("供应商后台检查 API Key 的模型访问权限");
      expect(result.suggestedActions[0]).toContain("选择当前密钥已获授权的模型");
    },
  );
});
