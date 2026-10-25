import { describe, expect, it } from "vitest";
import { normalizeChineseMobilePhone } from "./phone";

describe("normalizeChineseMobilePhone", () => {
  it.each([
    ["13800138000", "13800138000"],
    ["+86 138-0013-8000", "13800138000"],
    ["0086 138 0013 8000", "13800138000"],
    ["8613800138000", "13800138000"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeChineseMobilePhone(input)).toBe(expected);
  });

  it.each(["", "123", "12800138000", "+1 202 555 0101"])("rejects %s", (input) => {
    expect(() => normalizeChineseMobilePhone(input)).toThrow();
  });
});
