import { describe, expect, it } from "vitest";
import { materialFailureResponse, safeMaterialFailureResponse } from "./material-failure-response";

describe("tenant material failure responses", () => {
  it("replaces historical supplier text with administrator guidance without rewriting storage", () => {
    const stored = {
      id: "material-legacy",
      ingestionErrorCode: "MATERIAL_ANALYSIS_AUTH_FAILED",
      ingestionErrorMessage: "invalid_api_key sk-private body=source text https://private.invalid",
    };
    const result = safeMaterialFailureResponse(stored);
    expect(result.ingestionErrorCode).toBe("MATERIAL_ANALYSIS_AUTH_FAILED");
    expect(result.ingestionErrorMessage).toContain("请联系平台管理员处理");
    expect(JSON.stringify(result)).not.toMatch(
      /sk-private|source text|private\.invalid|invalid_api_key/u,
    );
    expect(stored.ingestionErrorMessage).toContain("sk-private");
  });

  it("retains actionable file reasons and allows no unrecognized error payload", () => {
    expect(materialFailureResponse("EMPTY_EXTRACTED_TEXT")).toEqual({
      errorCode: "EMPTY_EXTRACTED_TEXT",
      errorMessage: expect.stringContaining("可用文字"),
    });
    expect(materialFailureResponse("MATERIAL_SECRET_KEY_PRIVATE")).toEqual({
      errorCode: "UNCLASSIFIED",
      errorMessage: expect.stringContaining("请联系平台管理员处理"),
    });
    expect(materialFailureResponse(null)).toEqual({ errorCode: null, errorMessage: null });
  });
});
