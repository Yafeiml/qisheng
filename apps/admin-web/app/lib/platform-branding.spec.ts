import { describe, expect, it } from "vitest";
import { parsePlatformBranding } from "./platform-branding";

describe("public branding payload", () => {
  it("accepts a configured name without requiring a logo", () => {
    expect(parsePlatformBranding({ name: "新的平台", logoDataUrl: null, other: "hidden" })).toEqual(
      { name: "新的平台", logoDataUrl: null },
    );
  });
  it.each(["javascript:alert(1)", "data:image/svg+xml,<svg/>", "https://example.test/logo.png"])(
    "rejects unexpected logo sources",
    (logoDataUrl) => {
      expect(() => parsePlatformBranding({ name: "新的平台", logoDataUrl })).toThrow();
    },
  );
  it("rejects a malformed response instead of replacing the last good name", () => {
    expect(() => parsePlatformBranding({ name: "", logoDataUrl: null })).toThrow();
  });
});
