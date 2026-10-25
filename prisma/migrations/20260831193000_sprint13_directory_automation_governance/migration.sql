-- Sprint 13: durable directory automation, signed event inbox and operational alerts.

ALTER TYPE "directory_sync_run_status" ADD VALUE IF NOT EXISTS 'SUPERSEDED';

CREATE TYPE "directory_event_status" AS ENUM (
  'RECEIVED',
  'PROCESSING',
  'RETRYABLE',
  'PROCESSED',
  'DEAD_LETTER'
);

CREATE TYPE "directory_alert_type" AS ENUM (
  'CONNECTION_ERROR',
  'PERMISSION_INVALID',
  'CONSECUTIVE_FAILURES',
  'EVENT_DEAD_LETTER',
  'SYNC_STALE'
);

CREATE TYPE "directory_alert_severity" AS ENUM ('WARNING', 'CRITICAL');
CREATE TYPE "directory_alert_status" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

ALTER TABLE "directory_connections"
  ADD COLUMN "sync_interval_minutes" INTEGER NOT NULL DEFAULT 1440,
  ADD COLUMN "next_sync_at" TIMESTAMP(3),
  ADD COLUMN "last_event_at" TIMESTAMP(3),
  ADD COLUMN "consecutive_failure_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "automation_lease_owner" VARCHAR(160),
  ADD COLUMN "automation_lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "credential_rotated_at" TIMESTAMP(3),
  ADD COLUMN "credential_rotated_by" VARCHAR(64);

ALTER TABLE "directory_connections"
  ADD CONSTRAINT "directory_connections_sync_interval_minutes_check"
    CHECK ("sync_interval_minutes" BETWEEN 15 AND 10080),
  ADD CONSTRAINT "directory_connections_consecutive_failure_count_check"
    CHECK ("consecutive_failure_count" >= 0),
  ADD CONSTRAINT "directory_connections_automation_lease_pair_check"
    CHECK (
      ("automation_lease_owner" IS NULL AND "automation_lease_expires_at" IS NULL)
      OR
      ("automation_lease_owner" IS NOT NULL AND "automation_lease_expires_at" IS NOT NULL)
    );

CREATE INDEX "directory_connections_automation_due_idx"
  ON "directory_connections"("sync_mode", "next_sync_at", "status");
CREATE INDEX "directory_connections_automation_lease_expires_at_idx"
  ON "directory_connections"("automation_lease_expires_at");
CREATE INDEX "directory_sync_runs_tenant_id_status_created_at_idx"
  ON "directory_sync_runs"("tenant_id", "status", "created_at");

CREATE TABLE "directory_event_inbox" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT,
  "connection_id" TEXT NOT NULL,
  "sync_run_id" TEXT,
  "provider_event_id" VARCHAR(200) NOT NULL,
  "event_type" VARCHAR(160) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "signature_timestamp" TIMESTAMP(3) NOT NULL,
  "nonce_hash" CHAR(64) NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "normalized_payload" JSONB NOT NULL,
  "status" "directory_event_status" NOT NULL DEFAULT 'RECEIVED',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processing_started_at" TIMESTAMP(3),
  "processed_at" TIMESTAMP(3),
  "error_code" VARCHAR(120),
  "error_message" VARCHAR(500),
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "directory_event_inbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "directory_event_inbox_attempts_check"
    CHECK ("attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 20)
);

CREATE UNIQUE INDEX "directory_event_inbox_connection_id_provider_event_id_key"
  ON "directory_event_inbox"("connection_id", "provider_event_id");
CREATE UNIQUE INDEX "directory_event_inbox_connection_id_nonce_hash_key"
  ON "directory_event_inbox"("connection_id", "nonce_hash");
CREATE INDEX "directory_event_inbox_status_next_attempt_at_received_at_idx"
  ON "directory_event_inbox"("status", "next_attempt_at", "received_at");
CREATE INDEX "directory_event_inbox_tenant_id_connection_id_received_at_idx"
  ON "directory_event_inbox"("tenant_id", "connection_id", "received_at");
CREATE INDEX "directory_event_inbox_enterprise_id_received_at_idx"
  ON "directory_event_inbox"("enterprise_id", "received_at");

ALTER TABLE "directory_event_inbox"
  ADD CONSTRAINT "directory_event_inbox_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "directory_event_inbox_enterprise_id_tenant_id_fkey"
    FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "directory_event_inbox_connection_id_tenant_id_fkey"
    FOREIGN KEY ("connection_id", "tenant_id") REFERENCES "directory_connections"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "directory_event_inbox_sync_run_id_fkey"
    FOREIGN KEY ("sync_run_id") REFERENCES "directory_sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "directory_alerts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT,
  "connection_id" TEXT NOT NULL,
  "type" "directory_alert_type" NOT NULL,
  "severity" "directory_alert_severity" NOT NULL,
  "status" "directory_alert_status" NOT NULL DEFAULT 'OPEN',
  "message" VARCHAR(500) NOT NULL,
  "details" JSONB,
  "occurrence_count" INTEGER NOT NULL DEFAULT 1,
  "first_occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledged_at" TIMESTAMP(3),
  "acknowledged_by" VARCHAR(64),
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "directory_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "directory_alerts_occurrence_count_check" CHECK ("occurrence_count" > 0)
);

CREATE UNIQUE INDEX "directory_alerts_connection_id_type_key"
  ON "directory_alerts"("connection_id", "type");
CREATE INDEX "directory_alerts_tenant_id_status_severity_last_occurred_at_idx"
  ON "directory_alerts"("tenant_id", "status", "severity", "last_occurred_at");
CREATE INDEX "directory_alerts_enterprise_id_status_last_occurred_at_idx"
  ON "directory_alerts"("enterprise_id", "status", "last_occurred_at");

ALTER TABLE "directory_alerts"
  ADD CONSTRAINT "directory_alerts_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "directory_alerts_enterprise_id_tenant_id_fkey"
    FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "directory_alerts_connection_id_tenant_id_fkey"
    FOREIGN KEY ("connection_id", "tenant_id") REFERENCES "directory_connections"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
