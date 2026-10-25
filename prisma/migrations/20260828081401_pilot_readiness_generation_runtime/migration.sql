-- CreateEnum
CREATE TYPE "generation_work_item_status" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "model_invocation_kind" AS ENUM ('CAMPAIGN_BLUEPRINT', 'EMPLOYEE_COPY', 'EMPLOYEE_IMAGE');

-- CreateEnum
CREATE TYPE "model_invocation_status" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "model_provider_protocol" AS ENUM ('SYNTHETIC', 'OPENAI_COMPATIBLE');

-- AlterTable
ALTER TABLE "generated_images" ADD COLUMN     "byte_size" BIGINT,
ADD COLUMN     "perceptual_hash" VARCHAR(16),
ADD COLUMN     "storage_etag" VARCHAR(255),
ADD COLUMN     "storage_key" VARCHAR(1000);

-- AlterTable
ALTER TABLE "generation_runs" ADD COLUMN     "failed_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "image_provider" VARCHAR(80) NOT NULL DEFAULT '',
ADD COLUMN     "routing_policy" JSONB,
ADD COLUMN     "text_provider" VARCHAR(80) NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "model_providers" ADD COLUMN     "protocol" "model_provider_protocol" NOT NULL DEFAULT 'OPENAI_COMPATIBLE';

-- AlterTable
ALTER TABLE "model_routes" ADD COLUMN     "image_fallback_model_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "max_attempts_per_model" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "text_fallback_model_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "generation_work_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "generation_run_id" TEXT NOT NULL,
    "audience_snapshot_id" TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "status" "generation_work_item_status" NOT NULL DEFAULT 'QUEUED',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "reservation_version" INTEGER NOT NULL DEFAULT 1,
    "error_code" VARCHAR(120),
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_work_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_invocations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "generation_run_id" TEXT NOT NULL,
    "generation_work_item_id" TEXT,
    "kind" "model_invocation_kind" NOT NULL,
    "provider" VARCHAR(80) NOT NULL,
    "model" VARCHAR(200) NOT NULL,
    "status" "model_invocation_status" NOT NULL DEFAULT 'RUNNING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "provider_request_id" VARCHAR(200),
    "latency_ms" INTEGER,
    "input_units" INTEGER,
    "output_units" INTEGER,
    "image_count" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "error_code" VARCHAR(120),
    "error_message" TEXT,
    "retryable" BOOLEAN,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "metadata" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_work_items_tenant_id_status_created_at_idx" ON "generation_work_items"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "generation_work_items_campaign_id_status_idx" ON "generation_work_items"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "generation_work_items_membership_id_status_idx" ON "generation_work_items"("membership_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "generation_work_items_generation_run_id_audience_snapshot_i_key" ON "generation_work_items"("generation_run_id", "audience_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "generation_work_items_id_tenant_id_key" ON "generation_work_items"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "model_invocations_tenant_id_created_at_idx" ON "model_invocations"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "model_invocations_generation_run_id_status_idx" ON "model_invocations"("generation_run_id", "status");

-- CreateIndex
CREATE INDEX "model_invocations_generation_work_item_id_kind_idx" ON "model_invocations"("generation_work_item_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "model_invocations_tenant_id_idempotency_key_key" ON "model_invocations"("tenant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "generation_work_items" ADD CONSTRAINT "generation_work_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_work_items" ADD CONSTRAINT "generation_work_items_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_work_items" ADD CONSTRAINT "generation_work_items_campaign_id_enterprise_id_tenant_id_fkey" FOREIGN KEY ("campaign_id", "enterprise_id", "tenant_id") REFERENCES "campaigns"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_work_items" ADD CONSTRAINT "generation_work_items_generation_run_id_fkey" FOREIGN KEY ("generation_run_id") REFERENCES "generation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_work_items" ADD CONSTRAINT "generation_work_items_audience_snapshot_id_tenant_id_fkey" FOREIGN KEY ("audience_snapshot_id", "tenant_id") REFERENCES "campaign_audience_snapshots"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_work_items" ADD CONSTRAINT "generation_work_items_membership_id_enterprise_id_tenant_i_fkey" FOREIGN KEY ("membership_id", "enterprise_id", "tenant_id") REFERENCES "enterprise_memberships"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_campaign_id_tenant_id_fkey" FOREIGN KEY ("campaign_id", "tenant_id") REFERENCES "campaigns"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_generation_run_id_fkey" FOREIGN KEY ("generation_run_id") REFERENCES "generation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_generation_work_item_id_tenant_id_fkey" FOREIGN KEY ("generation_work_item_id", "tenant_id") REFERENCES "generation_work_items"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
