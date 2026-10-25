CREATE TYPE "provider_circuit_state" AS ENUM ('CLOSED', 'OPEN', 'HALF_OPEN');

ALTER TABLE "generation_runs"
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "queue_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "execution_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "recovery_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lease_owner" VARCHAR(180),
  ADD COLUMN "lease_token" VARCHAR(64),
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "heartbeat_at" TIMESTAMP(3),
  ADD COLUMN "next_retry_at" TIMESTAMP(3),
  ADD COLUMN "error_code" VARCHAR(120),
  ADD COLUMN "error_retryable" BOOLEAN;

ALTER TABLE "generation_work_items"
  ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "queue_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "execution_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "recovery_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lease_owner" VARCHAR(180),
  ADD COLUMN "lease_token" VARCHAR(64),
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "heartbeat_at" TIMESTAMP(3),
  ADD COLUMN "next_retry_at" TIMESTAMP(3),
  ADD COLUMN "error_retryable" BOOLEAN;

ALTER TABLE "model_providers"
  ADD COLUMN "circuit_state" "provider_circuit_state" NOT NULL DEFAULT 'CLOSED',
  ADD COLUMN "runtime_failure_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "circuit_opened_at" TIMESTAMP(3),
  ADD COLUMN "circuit_open_until" TIMESTAMP(3),
  ADD COLUMN "circuit_probe_token" VARCHAR(64),
  ADD COLUMN "circuit_probe_expires_at" TIMESTAMP(3),
  ADD COLUMN "last_runtime_failure_at" TIMESTAMP(3),
  ADD COLUMN "last_runtime_error_code" VARCHAR(120);

ALTER TABLE "generation_runs"
  ADD CONSTRAINT "generation_runs_attempt_count_check" CHECK ("attempt_count" >= 0),
  ADD CONSTRAINT "generation_runs_max_attempts_check" CHECK ("max_attempts" > 0),
  ADD CONSTRAINT "generation_runs_queue_version_check" CHECK ("queue_version" > 0),
  ADD CONSTRAINT "generation_runs_execution_version_check" CHECK ("execution_version" >= 0),
  ADD CONSTRAINT "generation_runs_recovery_count_check" CHECK ("recovery_count" >= 0);

ALTER TABLE "generation_work_items"
  ADD CONSTRAINT "generation_work_items_attempt_count_check" CHECK ("attempt_count" >= 0),
  ADD CONSTRAINT "generation_work_items_max_attempts_check" CHECK ("max_attempts" > 0),
  ADD CONSTRAINT "generation_work_items_queue_version_check" CHECK ("queue_version" > 0),
  ADD CONSTRAINT "generation_work_items_execution_version_check" CHECK ("execution_version" >= 0),
  ADD CONSTRAINT "generation_work_items_recovery_count_check" CHECK ("recovery_count" >= 0);

ALTER TABLE "model_providers"
  ADD CONSTRAINT "model_providers_runtime_failure_count_check" CHECK ("runtime_failure_count" >= 0);

CREATE INDEX "generation_runs_status_next_retry_at_created_at_idx"
  ON "generation_runs"("status", "next_retry_at", "created_at");
CREATE INDEX "generation_runs_status_lease_expires_at_idx"
  ON "generation_runs"("status", "lease_expires_at");
CREATE INDEX "generation_work_items_status_next_retry_at_created_at_idx"
  ON "generation_work_items"("status", "next_retry_at", "created_at");
CREATE INDEX "generation_work_items_status_lease_expires_at_idx"
  ON "generation_work_items"("status", "lease_expires_at");
CREATE INDEX "model_providers_circuit_state_circuit_open_until_idx"
  ON "model_providers"("circuit_state", "circuit_open_until");
