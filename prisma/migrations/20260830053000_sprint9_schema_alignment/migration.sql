-- Align explicit Sprint 9 database objects with Prisma's stable names and
-- application-managed @updatedAt semantics.
ALTER TABLE "employee_content_revisions"
  RENAME CONSTRAINT "employee_content_revisions_campaign_id_enterprise_id_tenant_id_"
  TO "employee_content_revisions_campaign_id_enterprise_id_tenan_fkey";

ALTER INDEX "employee_content_revisions_tenant_id_enterprise_id_campaign_id_"
  RENAME TO "employee_content_revisions_tenant_id_enterprise_id_campaign_idx";

ALTER TABLE "storage_reservations"
  ALTER COLUMN "updated_at" DROP DEFAULT;

ALTER TABLE "tenant_storage_accounts"
  ALTER COLUMN "updated_at" DROP DEFAULT;
