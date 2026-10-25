-- CreateEnum
CREATE TYPE "model_provider_credential_status" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "model_provider_health_status" AS ENUM ('UNKNOWN', 'HEALTHY', 'UNHEALTHY');

-- Remove the legacy reference-only credential contract before replacing the column.
ALTER TABLE "model_providers"
  DROP CONSTRAINT "model_providers_configuration_check";

-- AlterTable
ALTER TABLE "model_providers"
  DROP COLUMN "credential_ref",
  ADD COLUMN "active_credential_id" TEXT,
  ADD COLUMN "health_status" "model_provider_health_status" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "last_health_checked_at" TIMESTAMP(3),
  ADD COLUMN "last_health_latency_ms" INTEGER,
  ADD COLUMN "last_health_error_code" VARCHAR(80),
  ADD COLUMN "consecutive_health_failures" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "model_provider_credentials" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "initialization_vector" BYTEA NOT NULL,
    "authentication_tag" BYTEA NOT NULL,
    "key_version" VARCHAR(40) NOT NULL,
    "last_four" VARCHAR(8) NOT NULL,
    "status" "model_provider_credential_status" NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" VARCHAR(500),

    CONSTRAINT "model_provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_provider_health_checks" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "status" "model_provider_health_status" NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "http_status" INTEGER,
    "error_code" VARCHAR(80),
    "error_message" VARCHAR(300),
    "checked_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_provider_health_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_providers_active_credential_id_key"
ON "model_providers"("active_credential_id");

-- CreateIndex
CREATE INDEX "model_provider_credentials_provider_id_status_created_at_idx"
ON "model_provider_credentials"("provider_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "model_provider_health_checks_provider_id_created_at_idx"
ON "model_provider_health_checks"("provider_id", "created_at");

-- AddForeignKey
ALTER TABLE "model_provider_credentials"
ADD CONSTRAINT "model_provider_credentials_provider_id_fkey"
FOREIGN KEY ("provider_id") REFERENCES "model_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_provider_health_checks"
ADD CONSTRAINT "model_provider_health_checks_provider_id_fkey"
FOREIGN KEY ("provider_id") REFERENCES "model_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_providers"
ADD CONSTRAINT "model_providers_active_credential_id_fkey"
FOREIGN KEY ("active_credential_id") REFERENCES "model_provider_credentials"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "model_providers"
  ADD CONSTRAINT "model_providers_configuration_check"
    CHECK (
      length(trim("code")) > 0
      AND length(trim("base_url")) > 0
      AND "timeout_ms" > 0
      AND "consecutive_health_failures" >= 0
    );

ALTER TABLE "model_provider_credentials"
  ADD CONSTRAINT "model_provider_credentials_lifecycle_check"
    CHECK (
      length("ciphertext") > 0
      AND length("initialization_vector") = 12
      AND length("authentication_tag") = 16
      AND length(trim("key_version")) > 0
      AND length("last_four") BETWEEN 1 AND 8
      AND (
        ("status" = 'ACTIVE' AND "revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason" IS NULL)
        OR
        ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL AND "revoke_reason" IS NOT NULL)
      )
    );
