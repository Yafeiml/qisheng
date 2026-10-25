import { describe, expect, it } from "vitest";
import { publicMetricSnapshot } from "./publication-metrics-public";

describe("public publication metric snapshots", () => {
  it("hides historical provider payloads while preserving an abbreviated public reading", () => {
    const snapshot = {
      comments: 0,
      favorites: null,
      likes: null,
      rawData: {
        cookie: "private-session-value",
        metricDisplay: { comments: "0", favorites: "secret", likes: "1.2万+" },
        metricPrecision: { comments: "EXACT", favorites: "UNAVAILABLE", likes: "APPROXIMATE" },
        rawHtml: "<html>private</html>",
      },
      shares: null,
      views: null,
    };
    const publicSnapshot = publicMetricSnapshot(snapshot);
    expect(publicSnapshot.comments).toBe(0);
    expect(publicSnapshot.likes).toBeNull();
    expect(publicSnapshot.rawData).toEqual({
      metricDisplay: { likes: "1.2万+" },
      metricPrecision: { comments: "EXACT", favorites: "UNAVAILABLE", likes: "APPROXIMATE" },
    });
    expect(JSON.stringify(publicSnapshot)).not.toContain("private-session-value");
    expect(JSON.stringify(publicSnapshot)).not.toContain("rawHtml");
  });

  it("does not expose invalid or inconsistent historical precision metadata", () => {
    const snapshot = {
      comments: null,
      favorites: null,
      likes: 0,
      rawData: {
        metricDisplay: { likes: "123", favorites: "session_token=abc" },
        metricPrecision: { likes: "APPROXIMATE", favorites: "APPROXIMATE" },
      },
      shares: null,
      views: null,
    };
    expect(publicMetricSnapshot(snapshot).rawData).toBeNull();
    expect(publicMetricSnapshot(snapshot).likes).toBe(0);
  });
});
