CREATE TYPE "campaign_audience_mode" AS ENUM ('ALL', 'DEPARTMENT', 'SELECTED');

ALTER TABLE "campaigns"
  ADD COLUMN "audience_mode" "campaign_audience_mode" NOT NULL DEFAULT 'ALL',
  ADD COLUMN "audience_selector" JSONB,
  ADD COLUMN "archived_at" TIMESTAMP(3),
  ADD COLUMN "archived_by" TEXT;

UPDATE "campaigns" AS campaign
SET
  "audience_mode" = 'SELECTED',
  "audience_selector" = jsonb_build_object(
    'membershipIds',
    COALESCE(
      (
        SELECT jsonb_agg(snapshot."membership_id" ORDER BY snapshot."created_at", snapshot."id")
        FROM "campaign_audience_snapshots" AS snapshot
        WHERE snapshot."campaign_id" = campaign."id"
      ),
      '[]'::jsonb
    )
  );

CREATE TABLE "platform_customer_notes" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "body" VARCHAR(2000) NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_customer_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_customer_notes_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "platform_customer_notes_tenant_id_created_at_id_idx"
  ON "platform_customer_notes"("tenant_id", "created_at", "id");

CREATE INDEX "campaigns_tenant_archive_cursor_idx"
  ON "campaigns"("tenant_id", "archived_at", "created_at", "id");
CREATE INDEX "campaigns_enterprise_archive_cursor_idx"
  ON "campaigns"("enterprise_id", "archived_at", "created_at", "id");
CREATE INDEX "campaigns_enterprise_status_filter_idx"
  ON "campaigns"("enterprise_id", "status", "archived_at", "created_at", "id");
CREATE INDEX "campaigns_enterprise_creator_filter_idx"
  ON "campaigns"("enterprise_id", "created_by", "archived_at", "created_at", "id");
CREATE INDEX "campaigns_enterprise_visible_filter_idx"
  ON "campaigns"("enterprise_id", "visible_at", "archived_at", "id");
CREATE INDEX "campaigns_title_trgm_idx"
  ON "campaigns" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "campaigns_prompt_trgm_idx"
  ON "campaigns" USING GIN ("prompt" gin_trgm_ops);

CREATE INDEX "tenants_name_trgm_idx"
  ON "tenants" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "enterprises_name_trgm_idx"
  ON "enterprises" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "enterprises_code_trgm_idx"
  ON "enterprises" USING GIN ("code" gin_trgm_ops);

CREATE INDEX "generation_work_items_campaign_filter_idx"
  ON "generation_work_items"(
    "tenant_id",
    "enterprise_id",
    "campaign_id",
    "status",
    "created_at",
    "id"
  );
CREATE INDEX "audit_logs_resource_timeline_idx"
  ON "audit_logs"("tenant_id", "resource_type", "resource_id", "created_at", "id");
CREATE INDEX "campaign_evidence_shared_usage_idx"
  ON "campaign_retrieval_evidence"(
    "tenant_id",
    "material_scope_key",
    "enterprise_id",
    "created_at"
  );
