ALTER TYPE "platform_setting_group" ADD VALUE IF NOT EXISTS 'PUBLICATION';

ALTER TABLE "distribution_tasks"
  ALTER COLUMN "status" DROP DEFAULT,
  DROP CONSTRAINT "distribution_tasks_expired_state_check",
  DROP CONSTRAINT "distribution_tasks_verified_state_check";

CREATE TYPE "distribution_task_status_sprint15" AS ENUM (
  'LOCKED',
  'AVAILABLE',
  'VERIFYING',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
  'LATE_CORRECTED'
);

ALTER TABLE "distribution_tasks"
  ALTER COLUMN "status" TYPE "distribution_task_status_sprint15"
  USING (
    CASE "status"::text
      WHEN 'LOCKED' THEN 'LOCKED'
      WHEN 'AVAILABLE' THEN 'AVAILABLE'
      WHEN 'VIEWED' THEN 'AVAILABLE'
      WHEN 'COPIED' THEN 'AVAILABLE'
      WHEN 'INVALID' THEN 'AVAILABLE'
      WHEN 'SUBMITTED' THEN 'VERIFYING'
      WHEN 'MANUAL_REVIEW' THEN 'VERIFYING'
      WHEN 'VERIFIED' THEN 'COMPLETED'
      WHEN 'EXPIRED' THEN 'EXPIRED'
      WHEN 'CANCELLED' THEN 'CANCELLED'
      ELSE 'AVAILABLE'
    END
  )::"distribution_task_status_sprint15";

DROP TYPE "distribution_task_status";
ALTER TYPE "distribution_task_status_sprint15" RENAME TO "distribution_task_status";

ALTER TABLE "distribution_tasks"
  ALTER COLUMN "status" SET DEFAULT 'LOCKED',
  ADD CONSTRAINT "distribution_tasks_expired_state_check"
    CHECK (("status" <> 'EXPIRED') OR ("expired_at" IS NOT NULL)),
  ADD CONSTRAINT "distribution_tasks_completed_state_check"
    CHECK (("status" NOT IN ('COMPLETED', 'LATE_CORRECTED')) OR ("verified_at" IS NOT NULL)),
  ADD CONSTRAINT "distribution_tasks_late_corrected_state_check"
    CHECK (("status" <> 'LATE_CORRECTED') OR ("expired_at" IS NOT NULL));

ALTER TABLE "publish_submissions"
  ALTER COLUMN "status" DROP DEFAULT,
  DROP CONSTRAINT "publish_submissions_verified_state_check";

CREATE TYPE "publish_verification_status_sprint15" AS ENUM (
  'PENDING',
  'VERIFYING',
  'VALID',
  'INVALID',
  'DUPLICATE',
  'UNAVAILABLE',
  'MANUAL_REVIEW',
  'SUPERSEDED'
);

ALTER TABLE "publish_submissions"
  ALTER COLUMN "status" TYPE "publish_verification_status_sprint15"
  USING (
    CASE "status"::text
      WHEN 'PENDING' THEN 'PENDING'
      WHEN 'VERIFIED' THEN 'VALID'
      WHEN 'REJECTED' THEN 'INVALID'
      WHEN 'DUPLICATE' THEN 'DUPLICATE'
      WHEN 'MANUAL_REVIEW' THEN 'MANUAL_REVIEW'
      ELSE 'INVALID'
    END
  )::"publish_verification_status_sprint15";

DROP TYPE "publish_verification_status";
ALTER TYPE "publish_verification_status_sprint15" RENAME TO "publish_verification_status";

ALTER TABLE "publish_submissions"
  ALTER COLUMN "status" SET DEFAULT 'PENDING',
  ADD COLUMN "extracted_url" TEXT,
  ADD COLUMN "resolved_url" TEXT,
  ADD COLUMN "text_similarity_score" DOUBLE PRECISION,
  ADD COLUMN "image_similarity_score" DOUBLE PRECISION,
  ADD COLUMN "fact_match_score" DOUBLE PRECISION,
  ADD COLUMN "verification_policy_version" VARCHAR(120) NOT NULL DEFAULT 'development-v1',
  ADD COLUMN "verification_attempt" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "verification_started_at" TIMESTAMP(3),
  ADD COLUMN "verification_finished_at" TIMESTAMP(3),
  ADD COLUMN "adapter_request_id" VARCHAR(200),
  ADD COLUMN "adapter_provider" VARCHAR(100),
  ADD COLUMN "adapter_model" VARCHAR(160),
  ADD COLUMN "adapter_reference" TEXT,
  ADD COLUMN "external_published_at" TIMESTAMP(3),
  ADD COLUMN "late_correction" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "correction_reason" VARCHAR(500);

ALTER TABLE "publish_submissions"
  ADD CONSTRAINT "publish_submissions_verification_attempt_check"
  CHECK ("verification_attempt" >= 1),
  ADD CONSTRAINT "publish_submissions_valid_state_check"
  CHECK (("status" <> 'VALID') OR ("verified_at" IS NOT NULL)),
  ADD CONSTRAINT "publish_submissions_score_bounds_check"
  CHECK (
    ("match_score" IS NULL OR ("match_score" >= 0 AND "match_score" <= 1))
    AND ("text_similarity_score" IS NULL OR ("text_similarity_score" >= 0 AND "text_similarity_score" <= 1))
    AND ("image_similarity_score" IS NULL OR ("image_similarity_score" >= 0 AND "image_similarity_score" <= 1))
    AND ("fact_match_score" IS NULL OR ("fact_match_score" >= 0 AND "fact_match_score" <= 1))
  );

CREATE INDEX "publish_submissions_tenant_id_late_correction_status_submitted_idx"
  ON "publish_submissions"("tenant_id", "late_correction", "status", "submitted_at");
