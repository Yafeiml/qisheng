CREATE TYPE "department_status" AS ENUM ('ACTIVE', 'DISABLED');

ALTER TABLE "departments"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "department_status" USING ("status"::text::"department_status"),
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

CREATE TYPE "membership_import_batch_status" AS ENUM ('PREVIEW_READY', 'PREVIEW_FAILED', 'IMPORTED');

CREATE TABLE "membership_import_batches" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT NOT NULL,
  "file_name" VARCHAR(255),
  "source" VARCHAR(32) NOT NULL,
  "status" "membership_import_batch_status" NOT NULL,
  "row_count" INTEGER NOT NULL,
  "create_count" INTEGER NOT NULL,
  "update_count" INTEGER NOT NULL,
  "error_count" INTEGER NOT NULL,
  "report" JSONB NOT NULL,
  "created_by" TEXT NOT NULL,
  "imported_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "membership_import_batches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "membership_import_batches_tenant_id_enterprise_id_created_at_idx"
  ON "membership_import_batches"("tenant_id", "enterprise_id", "created_at");

CREATE INDEX "membership_import_batches_enterprise_id_status_created_at_idx"
  ON "membership_import_batches"("enterprise_id", "status", "created_at");

ALTER TABLE "membership_import_batches"
  ADD CONSTRAINT "membership_import_batches_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "membership_import_batches"
  ADD CONSTRAINT "membership_import_batches_enterprise_id_tenant_id_fkey"
  FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
