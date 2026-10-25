-- CreateEnum
CREATE TYPE "campaign_status" AS ENUM ('DRAFT', 'GENERATING', 'REVIEW_PENDING', 'APPROVED', 'ACTIVE', 'COMPLETED', 'EXPIRED', 'GENERATION_FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "generation_run_status" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "generated_content_status" AS ENUM ('GENERATED', 'REVIEW_BLOCKED', 'APPROVED');

-- CreateEnum
CREATE TYPE "distribution_task_status" AS ENUM ('LOCKED', 'AVAILABLE', 'VIEWED', 'COPIED', 'SUBMITTED', 'VERIFIED', 'INVALID', 'MANUAL_REVIEW', 'EXPIRED');

-- CreateEnum
CREATE TYPE "publish_verification_status" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'DUPLICATE', 'MANUAL_REVIEW');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "quota_period_id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" "campaign_status" NOT NULL DEFAULT 'DRAFT',
    "visible_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "image_count" INTEGER NOT NULL DEFAULT 1,
    "audience_count" INTEGER NOT NULL DEFAULT 0,
    "generated_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_audience_snapshots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "employee_name" VARCHAR(100) NOT NULL,
    "employee_phone" VARCHAR(32) NOT NULL,
    "department_name" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_audience_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_blueprints" (
    "campaign_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "master_copy" TEXT NOT NULL,
    "image_direction" TEXT NOT NULL,
    "source_context" JSONB NOT NULL,
    "generation_policy" JSONB NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_blueprints_pkey" PRIMARY KEY ("campaign_id")
);

-- CreateTable
CREATE TABLE "generation_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "status" "generation_run_status" NOT NULL DEFAULT 'QUEUED',
    "provider" VARCHAR(80) NOT NULL,
    "text_model" VARCHAR(120) NOT NULL,
    "image_model" VARCHAR(120) NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "requested_count" INTEGER NOT NULL,
    "completed_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_contents" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "audience_snapshot_id" TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "image_prompt" TEXT NOT NULL,
    "content_fingerprint" VARCHAR(64) NOT NULL,
    "status" "generated_content_status" NOT NULL DEFAULT 'GENERATED',
    "risk_assessment" JSONB NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_images" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_content_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "image_url" TEXT NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "provider" VARCHAR(80) NOT NULL,
    "model" VARCHAR(120) NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distribution_tasks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "employee_content_id" TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "status" "distribution_task_status" NOT NULL DEFAULT 'LOCKED',
    "visible_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "first_viewed_at" TIMESTAMP(3),
    "copied_at" TIMESTAMP(3),
    "downloaded_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "distribution_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_submissions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "raw_url" TEXT NOT NULL,
    "normalized_url" TEXT NOT NULL,
    "canonical_key" VARCHAR(180) NOT NULL,
    "status" "publish_verification_status" NOT NULL DEFAULT 'PENDING',
    "extracted_title" VARCHAR(500),
    "extracted_body" TEXT,
    "extracted_image_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "match_score" DOUBLE PRECISION,
    "failure_reason" VARCHAR(500),
    "verifier" VARCHAR(100) NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMP(3),

    CONSTRAINT "publish_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "published_content_registry" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "canonical_key" VARCHAR(180) NOT NULL,
    "normalized_url" TEXT NOT NULL,
    "content_fingerprint" VARCHAR(64) NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "published_content_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_content_fixtures" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "normalized_url" TEXT NOT NULL,
    "canonical_key" VARCHAR(180) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "body" TEXT NOT NULL,
    "image_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "synthetic" BOOLEAN NOT NULL DEFAULT true,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_content_fixtures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_metric_snapshots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "registry_id" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "window_hours" INTEGER,
    "source" VARCHAR(80) NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "favorites" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "raw_data" JSONB,
    "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publish_metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_tenant_id_status_visible_at_idx" ON "campaigns"("tenant_id", "status", "visible_at");

-- CreateIndex
CREATE INDEX "campaigns_enterprise_id_status_visible_at_idx" ON "campaigns"("enterprise_id", "status", "visible_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_id_tenant_id_key" ON "campaigns"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_id_enterprise_id_tenant_id_key" ON "campaigns"("id", "enterprise_id", "tenant_id");

-- CreateIndex
CREATE INDEX "campaign_audience_snapshots_tenant_id_enterprise_id_campaig_idx" ON "campaign_audience_snapshots"("tenant_id", "enterprise_id", "campaign_id");

-- CreateIndex
CREATE INDEX "campaign_audience_snapshots_membership_id_idx" ON "campaign_audience_snapshots"("membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_audience_snapshots_campaign_id_membership_id_key" ON "campaign_audience_snapshots"("campaign_id", "membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_audience_snapshots_id_tenant_id_key" ON "campaign_audience_snapshots"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "campaign_blueprints_tenant_id_idx" ON "campaign_blueprints"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_blueprints_campaign_id_tenant_id_key" ON "campaign_blueprints"("campaign_id", "tenant_id");

-- CreateIndex
CREATE INDEX "generation_runs_tenant_id_status_created_at_idx" ON "generation_runs"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "generation_runs_campaign_id_created_at_idx" ON "generation_runs"("campaign_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "employee_contents_audience_snapshot_id_key" ON "employee_contents"("audience_snapshot_id");

-- CreateIndex
CREATE INDEX "employee_contents_tenant_id_enterprise_id_campaign_id_statu_idx" ON "employee_contents"("tenant_id", "enterprise_id", "campaign_id", "status");

-- CreateIndex
CREATE INDEX "employee_contents_membership_id_created_at_idx" ON "employee_contents"("membership_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "employee_contents_campaign_id_membership_id_key" ON "employee_contents"("campaign_id", "membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_contents_audience_snapshot_id_tenant_id_key" ON "employee_contents"("audience_snapshot_id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_contents_id_tenant_id_key" ON "employee_contents"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "generated_images_checksum_key" ON "generated_images"("checksum");

-- CreateIndex
CREATE INDEX "generated_images_tenant_id_created_at_idx" ON "generated_images"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "generated_images_employee_content_id_sequence_key" ON "generated_images"("employee_content_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "distribution_tasks_employee_content_id_key" ON "distribution_tasks"("employee_content_id");

-- CreateIndex
CREATE INDEX "distribution_tasks_tenant_id_enterprise_id_status_visible_a_idx" ON "distribution_tasks"("tenant_id", "enterprise_id", "status", "visible_at");

-- CreateIndex
CREATE INDEX "distribution_tasks_membership_id_status_visible_at_idx" ON "distribution_tasks"("membership_id", "status", "visible_at");

-- CreateIndex
CREATE UNIQUE INDEX "distribution_tasks_campaign_id_membership_id_key" ON "distribution_tasks"("campaign_id", "membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "distribution_tasks_employee_content_id_tenant_id_key" ON "distribution_tasks"("employee_content_id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "distribution_tasks_id_tenant_id_key" ON "distribution_tasks"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "publish_submissions_tenant_id_task_id_submitted_at_idx" ON "publish_submissions"("tenant_id", "task_id", "submitted_at");

-- CreateIndex
CREATE INDEX "publish_submissions_canonical_key_status_idx" ON "publish_submissions"("canonical_key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "published_content_registry_task_id_key" ON "published_content_registry"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "published_content_registry_submission_id_key" ON "published_content_registry"("submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "published_content_registry_canonical_key_key" ON "published_content_registry"("canonical_key");

-- CreateIndex
CREATE INDEX "published_content_registry_tenant_id_campaign_id_verified_a_idx" ON "published_content_registry"("tenant_id", "campaign_id", "verified_at");

-- CreateIndex
CREATE UNIQUE INDEX "published_content_registry_task_id_tenant_id_key" ON "published_content_registry"("task_id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "public_content_fixtures_task_id_key" ON "public_content_fixtures"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "public_content_fixtures_normalized_url_key" ON "public_content_fixtures"("normalized_url");

-- CreateIndex
CREATE UNIQUE INDEX "public_content_fixtures_canonical_key_key" ON "public_content_fixtures"("canonical_key");

-- CreateIndex
CREATE INDEX "public_content_fixtures_tenant_id_created_at_idx" ON "public_content_fixtures"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "public_content_fixtures_task_id_tenant_id_key" ON "public_content_fixtures"("task_id", "tenant_id");

-- CreateIndex
CREATE INDEX "publish_metric_snapshots_tenant_id_campaign_id_observed_at_idx" ON "publish_metric_snapshots"("tenant_id", "campaign_id", "observed_at");

-- CreateIndex
CREATE UNIQUE INDEX "publish_metric_snapshots_registry_id_observed_at_source_key" ON "publish_metric_snapshots"("registry_id", "observed_at", "source");

-- AddForeignKey
ALTER TABLE "usage_ledgers" ADD CONSTRAINT "usage_ledgers_campaign_id_tenant_id_fkey" FOREIGN KEY ("campaign_id", "tenant_id") REFERENCES "campaigns"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledgers" ADD CONSTRAINT "usage_ledgers_distribution_task_id_tenant_id_fkey" FOREIGN KEY ("distribution_task_id", "tenant_id") REFERENCES "distribution_tasks"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_quota_period_id_tenant_id_fkey" FOREIGN KEY ("quota_period_id", "tenant_id") REFERENCES "quota_periods"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audience_snapshots" ADD CONSTRAINT "campaign_audience_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audience_snapshots" ADD CONSTRAINT "campaign_audience_snapshots_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audience_snapshots" ADD CONSTRAINT "campaign_audience_snapshots_campaign_id_enterprise_id_tena_fkey" FOREIGN KEY ("campaign_id", "enterprise_id", "tenant_id") REFERENCES "campaigns"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audience_snapshots" ADD CONSTRAINT "campaign_audience_snapshots_membership_id_enterprise_id_te_fkey" FOREIGN KEY ("membership_id", "enterprise_id", "tenant_id") REFERENCES "enterprise_memberships"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_blueprints" ADD CONSTRAINT "campaign_blueprints_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_blueprints" ADD CONSTRAINT "campaign_blueprints_campaign_id_tenant_id_fkey" FOREIGN KEY ("campaign_id", "tenant_id") REFERENCES "campaigns"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_campaign_id_tenant_id_fkey" FOREIGN KEY ("campaign_id", "tenant_id") REFERENCES "campaigns"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_contents" ADD CONSTRAINT "employee_contents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_contents" ADD CONSTRAINT "employee_contents_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_contents" ADD CONSTRAINT "employee_contents_campaign_id_enterprise_id_tenant_id_fkey" FOREIGN KEY ("campaign_id", "enterprise_id", "tenant_id") REFERENCES "campaigns"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_contents" ADD CONSTRAINT "employee_contents_audience_snapshot_id_tenant_id_fkey" FOREIGN KEY ("audience_snapshot_id", "tenant_id") REFERENCES "campaign_audience_snapshots"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_contents" ADD CONSTRAINT "employee_contents_membership_id_enterprise_id_tenant_id_fkey" FOREIGN KEY ("membership_id", "enterprise_id", "tenant_id") REFERENCES "enterprise_memberships"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_images" ADD CONSTRAINT "generated_images_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_images" ADD CONSTRAINT "generated_images_employee_content_id_tenant_id_fkey" FOREIGN KEY ("employee_content_id", "tenant_id") REFERENCES "employee_contents"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distribution_tasks" ADD CONSTRAINT "distribution_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distribution_tasks" ADD CONSTRAINT "distribution_tasks_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distribution_tasks" ADD CONSTRAINT "distribution_tasks_campaign_id_enterprise_id_tenant_id_fkey" FOREIGN KEY ("campaign_id", "enterprise_id", "tenant_id") REFERENCES "campaigns"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distribution_tasks" ADD CONSTRAINT "distribution_tasks_employee_content_id_tenant_id_fkey" FOREIGN KEY ("employee_content_id", "tenant_id") REFERENCES "employee_contents"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distribution_tasks" ADD CONSTRAINT "distribution_tasks_membership_id_enterprise_id_tenant_id_fkey" FOREIGN KEY ("membership_id", "enterprise_id", "tenant_id") REFERENCES "enterprise_memberships"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_submissions" ADD CONSTRAINT "publish_submissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_submissions" ADD CONSTRAINT "publish_submissions_task_id_tenant_id_fkey" FOREIGN KEY ("task_id", "tenant_id") REFERENCES "distribution_tasks"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_content_registry" ADD CONSTRAINT "published_content_registry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_content_registry" ADD CONSTRAINT "published_content_registry_campaign_id_tenant_id_fkey" FOREIGN KEY ("campaign_id", "tenant_id") REFERENCES "campaigns"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_content_registry" ADD CONSTRAINT "published_content_registry_task_id_tenant_id_fkey" FOREIGN KEY ("task_id", "tenant_id") REFERENCES "distribution_tasks"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_content_registry" ADD CONSTRAINT "published_content_registry_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "publish_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_content_fixtures" ADD CONSTRAINT "public_content_fixtures_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_content_fixtures" ADD CONSTRAINT "public_content_fixtures_task_id_tenant_id_fkey" FOREIGN KEY ("task_id", "tenant_id") REFERENCES "distribution_tasks"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_metric_snapshots" ADD CONSTRAINT "publish_metric_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_metric_snapshots" ADD CONSTRAINT "publish_metric_snapshots_campaign_id_tenant_id_fkey" FOREIGN KEY ("campaign_id", "tenant_id") REFERENCES "campaigns"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_metric_snapshots" ADD CONSTRAINT "publish_metric_snapshots_registry_id_fkey" FOREIGN KEY ("registry_id") REFERENCES "published_content_registry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain invariants that must remain true under concurrent API and worker writes.
ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_fixed_24h_window_check"
    CHECK ("expires_at" = "visible_at" + INTERVAL '24 hours'),
  ADD CONSTRAINT "campaigns_positive_image_count_check"
    CHECK ("image_count" > 0),
  ADD CONSTRAINT "campaigns_generation_counts_check"
    CHECK ("audience_count" >= 0 AND "generated_count" >= 0 AND "generated_count" <= "audience_count"),
  ADD CONSTRAINT "campaigns_approval_state_check"
    CHECK (
      "status" NOT IN ('APPROVED', 'ACTIVE', 'COMPLETED', 'EXPIRED')
      OR ("approved_at" IS NOT NULL AND "approved_by" IS NOT NULL)
    );

ALTER TABLE "generation_runs"
  ADD CONSTRAINT "generation_runs_counts_check"
    CHECK ("requested_count" >= 0 AND "completed_count" >= 0 AND "completed_count" <= "requested_count"),
  ADD CONSTRAINT "generation_runs_timestamps_check"
    CHECK (
      ("status" IN ('QUEUED') AND "finished_at" IS NULL)
      OR ("status" = 'RUNNING' AND "started_at" IS NOT NULL AND "finished_at" IS NULL)
      OR ("status" IN ('SUCCEEDED', 'FAILED') AND "started_at" IS NOT NULL AND "finished_at" IS NOT NULL)
    );

ALTER TABLE "generated_images"
  ADD CONSTRAINT "generated_images_dimensions_check"
    CHECK ("sequence" > 0 AND "width" > 0 AND "height" > 0);

ALTER TABLE "distribution_tasks"
  ADD CONSTRAINT "distribution_tasks_fixed_24h_window_check"
    CHECK ("expires_at" = "visible_at" + INTERVAL '24 hours'),
  ADD CONSTRAINT "distribution_tasks_verified_state_check"
    CHECK ("status" <> 'VERIFIED' OR "verified_at" IS NOT NULL),
  ADD CONSTRAINT "distribution_tasks_expired_state_check"
    CHECK ("status" <> 'EXPIRED' OR "expired_at" IS NOT NULL);

ALTER TABLE "publish_submissions"
  ADD CONSTRAINT "publish_submissions_match_score_check"
    CHECK ("match_score" IS NULL OR ("match_score" >= 0 AND "match_score" <= 1)),
  ADD CONSTRAINT "publish_submissions_verified_state_check"
    CHECK ("status" <> 'VERIFIED' OR "verified_at" IS NOT NULL),
  ADD CONSTRAINT "publish_submissions_canonical_key_check"
    CHECK (length("canonical_key") > 0);

ALTER TABLE "published_content_registry"
  ADD CONSTRAINT "published_content_registry_canonical_key_check"
    CHECK (length("canonical_key") > 0);

ALTER TABLE "public_content_fixtures"
  ADD CONSTRAINT "public_content_fixtures_synthetic_check"
    CHECK ("synthetic" = true),
  ADD CONSTRAINT "public_content_fixtures_content_check"
    CHECK (length("canonical_key") > 0 AND cardinality("image_urls") > 0);

ALTER TABLE "publish_metric_snapshots"
  ADD CONSTRAINT "publish_metric_snapshots_non_negative_check"
    CHECK ("views" >= 0 AND "likes" >= 0 AND "comments" >= 0 AND "favorites" >= 0 AND "shares" >= 0),
  ADD CONSTRAINT "publish_metric_snapshots_window_check"
    CHECK ("window_hours" IS NULL OR "window_hours" > 0);
