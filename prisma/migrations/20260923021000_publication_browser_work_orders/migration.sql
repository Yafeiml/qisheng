CREATE TABLE "publication_collection_jobs" (
  "id" TEXT NOT NULL,
  "submission_id" TEXT NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "window_hours" INTEGER NOT NULL DEFAULT 0,
  "status" VARCHAR(24) NOT NULL DEFAULT 'QUEUED',
  "due_at" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_owner" VARCHAR(80),
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMP(3),
  "heartbeat_at" TIMESTAMP(3),
  "observed_at" TIMESTAMP(3),
  "evidence" JSONB,
  "error_code" VARCHAR(80),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "publication_collection_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_collection_jobs_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "publish_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "publication_collection_jobs_kind_check" CHECK ("kind" IN ('VERIFY', 'METRICS')),
  CONSTRAINT "publication_collection_jobs_status_check" CHECK ("status" IN ('QUEUED', 'LEASED', 'COMPLETED', 'NEEDS_REVIEW', 'SKIPPED', 'CANCELLED')),
  CONSTRAINT "publication_collection_jobs_window_check" CHECK ("window_hours" IN (0, 24, 72)),
  CONSTRAINT "publication_collection_jobs_attempts_check" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "publication_collection_jobs_submission_id_kind_window_hours_key"
  ON "publication_collection_jobs" ("submission_id", "kind", "window_hours");
CREATE INDEX "publication_collection_jobs_status_due_at_id_idx"
  ON "publication_collection_jobs" ("status", "due_at", "id");
CREATE INDEX "publication_collection_jobs_submission_id_status_idx"
  ON "publication_collection_jobs" ("submission_id", "status");

CREATE TABLE "publication_collector_state" (
  "id" VARCHAR(64) NOT NULL,
  "paused_at" TIMESTAMP(3),
  "pause_reason" VARCHAR(160),
  "resumed_at" TIMESTAMP(3),
  "last_seen_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "publication_collector_state_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "publication_collector_request_nonces" (
  "id" UUID NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "publication_collector_request_nonces_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "publication_collector_request_nonces_received_at_idx"
  ON "publication_collector_request_nonces" ("received_at");
