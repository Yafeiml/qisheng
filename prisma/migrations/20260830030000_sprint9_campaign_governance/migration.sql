ALTER TYPE "generation_run_status" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "generation_work_item_status" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "distribution_task_status" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "campaigns"
  ADD COLUMN "cancelled_by" TEXT,
  ADD COLUMN "cancellation_reason" VARCHAR(500),
  ADD COLUMN "cancellation_settlement" JSONB,
  ADD COLUMN "last_rescheduled_at" TIMESTAMP(3),
  ADD COLUMN "last_rescheduled_by" TEXT;

ALTER TABLE "generation_work_items"
  ADD COLUMN "credit_reserved" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "review_feedback" VARCHAR(1000),
  ADD COLUMN "review_regeneration_count" INTEGER NOT NULL DEFAULT 0;

UPDATE "generation_work_items"
SET "credit_reserved" = CASE
  WHEN "status" IN ('QUEUED', 'RUNNING') THEN true
  ELSE false
END;

ALTER TABLE "employee_contents"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "employee_contents"
  ADD CONSTRAINT "employee_contents_revision_check"
  CHECK ("revision" > 0);

ALTER TABLE "generation_work_items"
  ADD CONSTRAINT "generation_work_items_review_regeneration_count_check"
  CHECK ("review_regeneration_count" >= 0);

CREATE TABLE "employee_content_revisions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "employee_content_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "review_feedback" VARCHAR(1000),
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "employee_content_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_content_revisions_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "employee_content_revisions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "employee_content_revisions_enterprise_id_tenant_id_fkey"
    FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "employee_content_revisions_campaign_id_enterprise_id_tenant_id_fkey"
    FOREIGN KEY ("campaign_id", "enterprise_id", "tenant_id") REFERENCES "campaigns"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "employee_content_revisions_employee_content_id_tenant_id_fkey"
    FOREIGN KEY ("employee_content_id", "tenant_id") REFERENCES "employee_contents"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "employee_content_revisions_employee_content_id_revision_key"
  ON "employee_content_revisions"("employee_content_id", "revision");

CREATE INDEX "employee_content_revisions_tenant_id_enterprise_id_campaign_id_created_at_idx"
  ON "employee_content_revisions"("tenant_id", "enterprise_id", "campaign_id", "created_at");

CREATE INDEX "generation_work_items_campaign_credit_reserved_idx"
  ON "generation_work_items"("campaign_id", "credit_reserved", "status");
