ALTER TABLE "publication_collection_jobs"
  DROP CONSTRAINT "publication_collection_jobs_kind_check";
ALTER TABLE "publication_collection_jobs"
  ADD CONSTRAINT "publication_collection_jobs_kind_check"
  CHECK ("kind" IN ('VERIFY', 'METRICS', 'READBACK'));

CREATE TABLE "publish_readback_snapshots" (
  "id" TEXT NOT NULL,
  "submission_id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "window_hours" INTEGER NOT NULL,
  "source" VARCHAR(80) NOT NULL,
  "likes" INTEGER,
  "comments" INTEGER,
  "favorites" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "publish_readback_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publish_readback_snapshots_submission_id_fkey"
    FOREIGN KEY ("submission_id") REFERENCES "publish_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "publish_readback_snapshots_window_check" CHECK ("window_hours" IN (24, 72)),
  CONSTRAINT "publish_readback_snapshots_metrics_check"
    CHECK (
      ("likes" IS NULL OR "likes" >= 0) AND
      ("comments" IS NULL OR "comments" >= 0) AND
      ("favorites" IS NULL OR "favorites" >= 0)
    )
);
CREATE UNIQUE INDEX "publish_readback_snapshots_job_id_key" ON "publish_readback_snapshots"("job_id");
CREATE UNIQUE INDEX "publish_readback_snapshots_submission_id_window_hours_key"
  ON "publish_readback_snapshots"("submission_id", "window_hours");
CREATE INDEX "publish_readback_snapshots_tenant_id_campaign_id_observed_at_idx"
  ON "publish_readback_snapshots"("tenant_id", "campaign_id", "observed_at");

CREATE TABLE "publication_readback_budget" (
  "day" VARCHAR(10) NOT NULL,
  "used" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "publication_readback_budget_pkey" PRIMARY KEY ("day"),
  CONSTRAINT "publication_readback_budget_used_check" CHECK ("used" >= 0)
);
