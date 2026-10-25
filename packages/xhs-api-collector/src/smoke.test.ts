import { describe, expect, it } from "vitest";
import { noteIdFromInput } from "./smoke";

describe("single paid pilot target", () => {
  it("accepts a canonical note while rejecting short links and offsite URLs", () => {
    expect(
      noteIdFromInput("https://www.xiaohongshu.com/discovery/item/abc123xyz?xsec_token=local"),
    ).toBe("abc123xyz");
    expect(() => noteIdFromInput("https://xhslink.com/SHORT1")).toThrow("NOTE_LINK_UNSUPPORTED");
    expect(() =>
      noteIdFromInput("https://www.xiaohongshu.com.evil.test/explore/abc123xyz"),
    ).toThrow("NOTE_LINK_UNSUPPORTED");
  });
});
