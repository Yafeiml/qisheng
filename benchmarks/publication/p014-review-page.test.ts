import { describe, expect, it } from "vitest";
import { summarizeP014Benchmark } from "./p014-core";
import { createP014ReviewHtml } from "./p014-review-page";
import { manifestWithResults } from "./p014-test-fixtures";

describe("P-014 review page", () => {
  it("provides one-click WSL-safe signing without embedding secrets", () => {
    const { manifest, results } = manifestWithResults();
    const html = createP014ReviewHtml(manifest, results, summarizeP014Benchmark(manifest, results));

    expect(html).toContain("P-014 小红书真实样本验真复核");
    expect(html).toContain("/api/manual-review");
    expect(html).toContain("manual-review.json");
    expect(html).toContain("sample-match");
    expect(html).not.toContain("api-secret");
  });
});
