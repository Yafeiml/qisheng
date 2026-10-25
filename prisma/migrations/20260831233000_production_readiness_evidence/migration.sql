CREATE TABLE "publication_verification_policy_evidence" (
  "id" TEXT NOT NULL,
  "benchmark_id" VARCHAR(128) NOT NULL,
  "acceptance_report_sha256" CHAR(64) NOT NULL,
  "provider_code" VARCHAR(100) NOT NULL,
  "provider_endpoint" VARCHAR(1000) NOT NULL,
  "policy_version" VARCHAR(120) NOT NULL,
  "scoring_profile_version" VARCHAR(160) NOT NULL,
  "text_similarity_threshold" DECIMAL(6,5) NOT NULL,
  "image_similarity_threshold" DECIMAL(6,5) NOT NULL,
  "manual_review_margin" DECIMAL(6,5) NOT NULL,
  "require_image_match" BOOLEAN NOT NULL,
  "sample_count" INTEGER NOT NULL,
  "report_checked_at" TIMESTAMP(3) NOT NULL,
  "reviewer" VARCHAR(160) NOT NULL,
  "registered_by" VARCHAR(100) NOT NULL,
  "report" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "publication_verification_policy_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_verification_policy_evidence_sha256_check"
    CHECK ("acceptance_report_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "publication_verification_policy_evidence_thresholds_check"
    CHECK (
      "text_similarity_threshold" >= 0 AND "text_similarity_threshold" <= 1
      AND "image_similarity_threshold" >= 0 AND "image_similarity_threshold" <= 1
      AND "manual_review_margin" >= 0 AND "manual_review_margin" <= 0.5
    ),
  CONSTRAINT "publication_verification_policy_evidence_sample_count_check"
    CHECK ("sample_count" >= 30),
  CONSTRAINT "publication_verification_policy_evidence_image_match_check"
    CHECK ("require_image_match" = true)
);

CREATE UNIQUE INDEX "publication_verification_policy_evidence_acceptance_report_sha256_key"
  ON "publication_verification_policy_evidence"("acceptance_report_sha256");

CREATE INDEX "publication_verification_policy_evidence_provider_policy_profile_created_idx"
  ON "publication_verification_policy_evidence"(
    "provider_code",
    "policy_version",
    "scoring_profile_version",
    "created_at"
  );

CREATE INDEX "publication_verification_policy_evidence_benchmark_id_created_at_idx"
  ON "publication_verification_policy_evidence"("benchmark_id", "created_at");
