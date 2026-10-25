-- Additive platform-only tables; the previous Worker does not read these tables.
CREATE TABLE "generation_lab_runs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "created_by" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT NOT NULL,
  "parent_id" TEXT,
  "title" TEXT NOT NULL,
  "action" TEXT NOT NULL DEFAULT 'COPY',
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "input" JSONB NOT NULL,
  "result" JSONB,
  "error" TEXT,
  "review_status" TEXT NOT NULL DEFAULT 'NONE',
  "review" JSONB,
  "lease_token" TEXT,
  "heartbeat_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "generation_lab_runs_status_created_at_idx" ON "generation_lab_runs"("status", "created_at");
CREATE INDEX "generation_lab_runs_review_status_created_at_idx" ON "generation_lab_runs"("review_status", "created_at");
CREATE INDEX "generation_lab_runs_enterprise_id_created_at_idx" ON "generation_lab_runs"("enterprise_id", "created_at");
CREATE TABLE "generation_lab_assets" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL REFERENCES "generation_lab_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "bytes" BYTEA NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "generation_lab_assets_run_id_kind_idx" ON "generation_lab_assets"("run_id", "kind");
CREATE TABLE "generation_lab_calls" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL REFERENCES "generation_lab_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "model_id" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'STARTED',
  "usage" JSONB,
  "error" TEXT,
  "latency_ms" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "generation_lab_calls_run_id_created_at_idx" ON "generation_lab_calls"("run_id", "created_at");
