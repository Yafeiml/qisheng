import { describe, expect, it } from "vitest";
import { createRealProviderReviewHtml } from "./real-provider-review-page";

describe("real provider review page", () => {
  it("renders one-click signing controls and safely embeds review entries", () => {
    const html = createRealProviderReviewHtml("benchmark-1", [
      {
        copy: {
          body: "正文",
          hashtags: ["科普"],
          title: "</script><script>alert('unsafe')</script>",
        },
        employeeMembershipId: "membership-001",
        image: {
          checksum: "checksum",
          height: 1440,
          imagePath: "./membership-001.png",
          perceptualHash: "0123456789abcdef",
          width: 1080,
        },
      },
    ]);

    expect(html).toContain("一键签署并保存 JSON");
    expect(html).toContain("我已查看本页全部图文");
    expect(html).toContain("manual-review.json");
    expect(html).toContain("/api/manual-review");
    expect(html).toContain("membership-001");
    expect(html).not.toContain("</script><script>alert('unsafe')</script>");
    expect(html).toContain("\\u003c/script\\u003e");
  });
});
