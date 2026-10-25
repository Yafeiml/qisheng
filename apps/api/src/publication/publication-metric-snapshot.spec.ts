import { describe, expect, it } from "vitest";
import type { IngestPublicationMetricsDto } from "./publication.dto";
import { normalizeMetricSnapshot } from "./publication-metric-snapshot";

function input(changes: Partial<IngestPublicationMetricsDto>): IngestPublicationMetricsDto {
  return {
    canonicalKey: "xhs:note:sample123",
    observedAt: "2026-09-23T00:00:00.000Z",
    source: "BROWSER",
    ...changes,
  } as IngestPublicationMetricsDto;
}

describe("normalizeMetricSnapshot", () => {
  it("separates a real zero from a missing count", () => {
    const result = normalizeMetricSnapshot(input({ comments: 0 }));
    expect(result.values).toMatchObject({ comments: 0, likes: null, favorites: null, views: null });
  });

  it("keeps the legacy Hermes omission defaults without applying them to browser sources", () => {
    const result = normalizeMetricSnapshot(input({ source: "HERMES", views: 12 }));
    expect(result.values).toMatchObject({ views: 12, likes: 0, comments: 0, favorites: 0 });
    expect(normalizeMetricSnapshot(input({ comments: 0 })).values.likes).toBeNull();
  });

  it("keeps approximate data visible but excludes it from exact totals", () => {
    const result = normalizeMetricSnapshot(
      input({
        rawData: {
          metricDisplay: { likes: "1.2万" },
          metricPrecision: { likes: "APPROXIMATE" },
        },
      }),
    );
    expect(result.values.likes).toBeNull();
    expect(result.rawData?.metricDisplay?.likes).toBe("1.2万");
  });

  it("rejects a completely unavailable snapshot", () => {
    expect(() => normalizeMetricSnapshot(input({}))).toThrow(/实际读取/u);
    expect(() =>
      normalizeMetricSnapshot(input({ rawData: { metricPrecision: { comments: "UNAVAILABLE" } } })),
    ).toThrow(/实际读取/u);
  });

  it("rejects mismatched precision, untrusted raw content and long display values", () => {
    expect(() =>
      normalizeMetricSnapshot(
        input({ likes: 0, rawData: { metricPrecision: { likes: "APPROXIMATE" } } }),
      ),
    ).toThrow(/不一致/u);
    expect(() =>
      normalizeMetricSnapshot(
        input({
          likes: 0,
          rawData: { cookie: "secret" } as unknown as IngestPublicationMetricsDto["rawData"],
        }),
      ),
    ).toThrow(/未受支持/u);
    expect(() =>
      normalizeMetricSnapshot(
        input({
          rawData: {
            metricPrecision: { likes: "APPROXIMATE" },
            metricDisplay: { likes: "<script>alert(1)</script>" },
          },
        }),
      ),
    ).toThrow(/无效/u);
  });
});
