// A provider detail response can establish note identity and copy similarity,
// but cannot independently prove account ownership or image fingerprints.
export const READBACK_POLICY_VERSION = "distributed-readback-text-v1";

export const READBACK_SCORING_POLICY = {
  textSimilarityThreshold: 0.85,
  manualReviewMargin: 0.1,
  requireImageMatch: false,
  imageSimilarityThreshold: 0,
} as const;
