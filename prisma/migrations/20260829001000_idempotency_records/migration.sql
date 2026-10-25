-- Persist write-request ownership and completed responses so retries remain safe
-- across API instances and process restarts.
CREATE TYPE "idempotency_audience" AS ENUM ('SAAS_ADMIN', 'EMPLOYEE', 'INTEGRATION');
CREATE TYPE "idempotency_status" AS ENUM ('PROCESSING', 'COMPLETED');

CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "audience" "idempotency_audience" NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "method" VARCHAR(12) NOT NULL,
    "request_path" VARCHAR(1000) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "idempotency_status" NOT NULL DEFAULT 'PROCESSING',
    "lock_token" UUID NOT NULL,
    "locked_until" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "response_status_code" INTEGER,
    "response_body" JSONB,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_records_user_id_audience_key_key"
ON "idempotency_records"("user_id", "audience", "key");

CREATE INDEX "idempotency_records_status_locked_until_idx"
ON "idempotency_records"("status", "locked_until");

CREATE INDEX "idempotency_records_expires_at_idx"
ON "idempotency_records"("expires_at");

ALTER TABLE "idempotency_records"
ADD CONSTRAINT "idempotency_records_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "global_users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
