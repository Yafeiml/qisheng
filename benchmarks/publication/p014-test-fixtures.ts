import type { P014Manifest, P014SampleResult } from "./p014-core";

export function manifestWithResults(): {
  manifest: P014Manifest;
  results: P014SampleResult[];
} {
  const manifest: P014Manifest = {
    benchmarkId: "p014-review-test",
    policyCandidates: [
      {
        imageSimilarityThreshold: 0.8,
        manualReviewMargin: 0.1,
        policyVersion: "candidate-a",
        requireImageMatch: true,
        textSimilarityThreshold: 0.6,
      },
      {
        imageSimilarityThreshold: 0.85,
        manualReviewMargin: 0.08,
        policyVersion: "candidate-b",
        requireImageMatch: true,
        textSimilarityThreshold: 0.65,
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
    samples: [sample("sample-match", "MATCH", ["LONG_LINK"])],
    schemaVersion: 1,
    synthetic: false,
  };
  return {
    manifest,
    results: [result(manifest.samples[0] as P014Manifest["samples"][number])],
  };
}

function sample(
  id: string,
  label: "MATCH" | "MISMATCH" | "UNAVAILABLE",
  scenarios: P014Manifest["samples"][number]["scenarios"],
): P014Manifest["samples"][number] {
  return {
    canonicalGroup: null,
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
    input: "https://www.xiaohongshu.com/explore/abcdef123",
    label,
    notes: null,
    scenarios,
  };
}

function result(sample: P014Manifest["samples"][number]): P014SampleResult {
  return {
    adapterStatus: "AVAILABLE",
    canonicalGroup: sample.canonicalGroup,
    canonicalKey: "xhs:note:abcdef123",
    canonicalUrl: "https://www.xiaohongshu.com/explore/abcdef123",
    error: null,
    evidence: {
      adapterModel: "provider-model",
      adapterReference: "provider-reference",
      adapterRequestId: "provider-request",
      body: sample.expectedContent.body,
      externalPublishedAt: null,
      hashtags: sample.expectedContent.hashtags,
      images: [
        {
          checksum: "a".repeat(64),
          perceptualHash: "0123456789abcdef",
          url: "https://assets.example.test/public.png",
        },
      ],
      provider: "real-provider",
      title: sample.expectedContent.title,
    },
    inputClassification: "XHS_NOTE",
    inputNormalizedUrl: sample.input,
    label: sample.label,
    latencyMs: 100,
    policyEvaluations: ["candidate-a", "candidate-b"].map((policyVersion) => ({
      decision: "VALID" as const,
      factScore: 1,
      failureReason: null,
      imageScore: 1,
      overallScore: 1,
      policyVersion,
      textScore: 1,
    })),
    sampleId: sample.id,
    scenarios: sample.scenarios,
  };
}
