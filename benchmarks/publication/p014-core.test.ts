import { describe, expect, it } from "vitest";
import {
  type P014Manifest,
  type P014SampleResult,
  p014CoverageErrors,
  parseP014Manifest,
  summarizeP014Benchmark,
} from "./p014-core";

describe("P-014 benchmark core", () => {
  it("rejects synthetic manifests before any provider call", () => {
    expect(() => parseP014Manifest({ schemaVersion: 1, synthetic: true })).toThrow(
      "synthetic fixtures cannot satisfy P-014",
    );
  });

  it("reports missing formal sample coverage for a smoke manifest", () => {
    const manifest = manifestWithSamples([sample("match-1", "MATCH", ["LONG_LINK"])]);
    const errors = p014CoverageErrors(manifest);

    expect(errors).toContain("formal P-014 acceptance requires at least 30 samples");
    expect(errors).toContain("required real-sample scenario is missing: SHORT_LINK");
  });

  it("selects only policies that have no false accepts and meet review gates", () => {
    const samples = [
      sample("match-1", "MATCH", ["LONG_LINK"]),
      sample("match-2", "MATCH", ["SHORT_LINK"], "same-note"),
      sample("match-3", "MATCH", ["QUERY_VARIANT"], "same-note"),
      sample("mismatch-1", "MISMATCH", ["UNRELATED_CONTENT"]),
      sample("unavailable-1", "UNAVAILABLE", ["UNAVAILABLE_CONTENT"]),
    ];
    const manifest = manifestWithSamples(samples);
    const results = samples.map((entry): P014SampleResult => {
      const adapterStatus = entry.label === "UNAVAILABLE" ? "UNAVAILABLE" : "AVAILABLE";
      return {
        adapterStatus,
        canonicalGroup: entry.canonicalGroup,
        canonicalKey: entry.canonicalGroup ? "xhs:note:same" : `xhs:note:${entry.id}`,
        canonicalUrl: entry.canonicalGroup
          ? "https://www.xiaohongshu.com/explore/same"
          : `https://www.xiaohongshu.com/explore/${entry.id}`,
        error: null,
        evidence: adapterStatus === "AVAILABLE" ? evidence() : null,
        inputClassification: entry.scenarios.includes("SHORT_LINK") ? "XHS_SHORT" : "XHS_NOTE",
        inputNormalizedUrl: entry.input,
        label: entry.label,
        latencyMs: 100,
        policyEvaluations:
          adapterStatus === "AVAILABLE"
            ? [
                evaluation("strict-v1", entry.label === "MATCH" ? "VALID" : "INVALID"),
                evaluation("unsafe-v1", "VALID"),
              ]
            : [],
        sampleId: entry.id,
        scenarios: entry.scenarios,
      };
    });
    const summary = summarizeP014Benchmark(manifest, results);

    expect(summary.passingPolicyVersions).toEqual(["strict-v1"]);
    expect(summary.recommendedPolicyVersion).toBe("strict-v1");
    expect(
      summary.policyMetrics.find(({ policyVersion }) => policyVersion === "unsafe-v1")?.errors,
    ).toContain("false accept rate 1.0000 exceeds 0.0000");
    expect(summary.automatedGatePassed).toBe(false);
    expect(summary.automatedGateErrors).toContain(
      "formal P-014 acceptance requires at least 30 samples",
    );
  });
});

function manifestWithSamples(samples: P014Manifest["samples"]): P014Manifest {
  return {
    benchmarkId: "p014-unit-test",
    policyCandidates: [
      {
        imageSimilarityThreshold: 0.8,
        manualReviewMargin: 0.1,
        policyVersion: "strict-v1",
        requireImageMatch: true,
        textSimilarityThreshold: 0.6,
      },
      {
        imageSimilarityThreshold: 0.2,
        manualReviewMargin: 0.1,
        policyVersion: "unsafe-v1",
        requireImageMatch: true,
        textSimilarityThreshold: 0.2,
      },
    ],
    providerDeclaration: {
      dataTermsReviewed: true,
      name: "real-provider",
      productionService: true,
    },
    qualityGates: {
      maximumFalseAcceptRate: 0,
      maximumFalseRejectRate: 0.1,
      maximumManualReviewRate: 0.3,
      maximumP95LatencyMs: 15_000,
      minimumCanonicalConsistencyRate: 1,
      minimumExpectedAvailableResolutionRate: 0.9,
      minimumMatchAutoPassRate: 0.8,
      minimumUnavailableRecognitionRate: 0.8,
    },
    samples,
    schemaVersion: 1,
    synthetic: false,
  };
}

function sample(
  id: string,
  label: P014Manifest["samples"][number]["label"],
  scenarios: P014Manifest["samples"][number]["scenarios"],
  canonicalGroup: string | null = null,
): P014Manifest["samples"][number] {
  return {
    canonicalGroup,
    expectedContent: {
      body: "规范术前评估，扫描约 10 秒。",
      hashtags: ["全飞秒Pro"],
      images: [
        {
          checksum: "a".repeat(64),
          imageUrl: "https://assets.example.test/expected.png",
          perceptualHash: "0123456789abcdef",
        },
      ],
      title: "全飞秒 Pro",
    },
    id,
    input: `https://www.xiaohongshu.com/explore/${id.replace(/-/gu, "")}`,
    label,
    notes: null,
    scenarios,
  };
}

function evidence() {
  return {
    adapterModel: "provider-model",
    adapterReference: "provider-reference",
    adapterRequestId: "provider-request",
    body: "规范术前评估，扫描约 10 秒。",
    externalPublishedAt: null,
    hashtags: ["全飞秒Pro"],
    images: [
      {
        checksum: "a".repeat(64),
        perceptualHash: "0123456789abcdef",
        url: "https://assets.example.test/public.png",
      },
    ],
    provider: "real-provider",
    title: "全飞秒 Pro",
  } as const;
}

function evaluation(policyVersion: string, decision: "INVALID" | "VALID") {
  return {
    decision,
    factScore: 1,
    failureReason: decision === "VALID" ? null : "mismatch",
    imageScore: 1,
    overallScore: decision === "VALID" ? 1 : 0.1,
    policyVersion,
    textScore: decision === "VALID" ? 1 : 0.1,
  } as const;
}
