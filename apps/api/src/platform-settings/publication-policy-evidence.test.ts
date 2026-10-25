import { describe, expect, it } from "vitest";
import { PUBLICATION_SCORING_PROFILE_VERSION } from "../publication/publication-verification-scoring";
import { parsePublicationPolicyEvidence } from "./publication-policy-evidence";

describe("publication policy evidence", () => {
  it("accepts a complete formal P-014 acceptance report", () => {
    const parsed = parsePublicationPolicyEvidence(JSON.stringify(validReport()));

    expect(parsed).toMatchObject({
      benchmarkId: "p014-production-20260831",
      policyVersion: "xhs-public-v1",
      providerCode: "PUBLICATION_VENDOR_V1",
      requireImageMatch: true,
      sampleCount: 30,
      scoringProfileVersion: PUBLICATION_SCORING_PROFILE_VERSION,
    });
    expect(parsed.acceptanceReportSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects local, synthetic, weak or unsigned evidence", () => {
    expect(() =>
      parsePublicationPolicyEvidence(JSON.stringify({ ...validReport(), synthetic: true })),
    ).toThrow("Synthetic");
    expect(() =>
      parsePublicationPolicyEvidence(
        JSON.stringify({
          ...validReport(),
          provider: {
            endpoint: "http://127.0.0.1:8080/v1/resolve",
            runtimeCode: "LOCAL_TEST",
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      parsePublicationPolicyEvidence(
        JSON.stringify({
          ...validReport(),
          manualReview: { ...validReport().manualReview, passed: 29, total: 29 },
        }),
      ),
    ).toThrow("at least 30 real samples");
    expect(() =>
      parsePublicationPolicyEvidence(
        JSON.stringify({ ...validReport(), errors: ["automated gate failed"] }),
      ),
    ).toThrow("contains errors");
  });

  it("requires the approved policy to match employee-specific images", () => {
    expect(() =>
      parsePublicationPolicyEvidence(
        JSON.stringify({
          ...validReport(),
          approvedPolicy: { ...validReport().approvedPolicy, requireImageMatch: false },
        }),
      ),
    ).toThrow("employee-specific image");
  });
});

function validReport() {
  return {
    accepted: true,
    approvedPolicy: {
      imageSimilarityThreshold: 0.8,
      manualReviewMargin: 0.08,
      policyVersion: "xhs-public-v1",
      requireImageMatch: true,
      textSimilarityThreshold: 0.72,
    },
    automatedGatePassed: true,
    benchmarkId: "p014-production-20260831",
    checkedAt: new Date().toISOString(),
    errors: [],
    evidenceHashes: {
      manifestSha256: "a".repeat(64),
      manualReviewSha256: "b".repeat(64),
      reportSha256: "c".repeat(64),
      resultsSha256: "d".repeat(64),
    },
    manualReview: {
      accepted: true,
      approvedPolicyVersion: "xhs-public-v1",
      errors: [],
      failed: 0,
      passed: 30,
      reviewedAt: new Date().toISOString(),
      reviewer: "Production Reviewer",
      total: 30,
    },
    provider: {
      declaredName: "Production Publication Vendor",
      endpoint: "https://publication.example.com/v1/resolve",
      runtimeCode: "PUBLICATION_VENDOR_V1",
    },
    schemaVersion: 1,
    scoringProfileVersion: PUBLICATION_SCORING_PROFILE_VERSION,
    synthetic: false,
  } as const;
}
