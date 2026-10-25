-- CreateEnum
CREATE TYPE "storage_reservation_status" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED');

-- CreateEnum
CREATE TYPE "storage_usage_type" AS ENUM ('RESERVE', 'COMMIT', 'RELEASE');

-- CreateTable
CREATE TABLE "tenant_storage_accounts" (
    "tenant_id" TEXT NOT NULL,
    "used_bytes" BIGINT NOT NULL DEFAULT 0,
    "reserved_bytes" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_storage_accounts_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "tenant_storage_accounts_non_negative_check"
      CHECK ("used_bytes" >= 0 AND "reserved_bytes" >= 0)
);

-- CreateTable
CREATE TABLE "storage_reservations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "reservation_key" VARCHAR(200) NOT NULL,
    "resource_type" VARCHAR(80) NOT NULL,
    "resource_id" VARCHAR(191) NOT NULL,
    "storage_key" VARCHAR(1000),
    "byte_size" BIGINT NOT NULL,
    "status" "storage_reservation_status" NOT NULL DEFAULT 'RESERVED',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "committed_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "storage_reservations_positive_bytes_check" CHECK ("byte_size" > 0),
    CONSTRAINT "storage_reservations_lifecycle_check" CHECK (
      ("status" = 'RESERVED' AND "committed_at" IS NULL AND "released_at" IS NULL) OR
      ("status" = 'COMMITTED' AND "committed_at" IS NOT NULL AND "released_at" IS NULL) OR
      ("status" = 'RELEASED' AND "released_at" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "storage_usage_ledgers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "type" "storage_usage_type" NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "used_bytes_after" BIGINT NOT NULL,
    "reserved_bytes_after" BIGINT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_usage_ledgers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "storage_usage_ledgers_balances_check"
      CHECK ("byte_size" > 0 AND "used_bytes_after" >= 0 AND "reserved_bytes_after" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "storage_reservations_tenant_id_reservation_key_key"
ON "storage_reservations"("tenant_id", "reservation_key");

-- CreateIndex
CREATE INDEX "storage_reservations_tenant_id_status_expires_at_idx"
ON "storage_reservations"("tenant_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "storage_reservations_tenant_id_resource_type_resource_id_idx"
ON "storage_reservations"("tenant_id", "resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "storage_usage_ledgers_reservation_id_type_key"
ON "storage_usage_ledgers"("reservation_id", "type");

-- CreateIndex
CREATE INDEX "storage_usage_ledgers_tenant_id_created_at_id_idx"
ON "storage_usage_ledgers"("tenant_id", "created_at", "id");

-- AddForeignKey
ALTER TABLE "tenant_storage_accounts"
ADD CONSTRAINT "tenant_storage_accounts_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_reservations"
ADD CONSTRAINT "storage_reservations_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenant_storage_accounts"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_usage_ledgers"
ADD CONSTRAINT "storage_usage_ledgers_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenant_storage_accounts"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_usage_ledgers"
ADD CONSTRAINT "storage_usage_ledgers_reservation_id_fkey"
FOREIGN KEY ("reservation_id") REFERENCES "storage_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill storage accounts from immutable material/image facts already present in local data.
INSERT INTO "tenant_storage_accounts" ("tenant_id", "used_bytes", "reserved_bytes")
SELECT
  tenant."id",
  COALESCE(materials."bytes", 0) + COALESCE(images."bytes", 0) + COALESCE(revisions."bytes", 0),
  0
FROM "tenants" AS tenant
LEFT JOIN (
  SELECT "tenant_id", SUM("byte_size")::BIGINT AS "bytes"
  FROM "material_artifacts"
  WHERE "status" IN ('STORED', 'VERIFIED')
  GROUP BY "tenant_id"
) AS materials ON materials."tenant_id" = tenant."id"
LEFT JOIN (
  SELECT "tenant_id", SUM(COALESCE("byte_size", 0))::BIGINT AS "bytes"
  FROM "generated_images"
  GROUP BY "tenant_id"
) AS images ON images."tenant_id" = tenant."id"
LEFT JOIN (
  SELECT revision."tenant_id", SUM(COALESCE(NULLIF(image->>'byteSize', ''), '0')::BIGINT)::BIGINT AS "bytes"
  FROM "employee_content_revisions" AS revision
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(revision."snapshot"->'images', '[]'::jsonb)) AS image
  GROUP BY revision."tenant_id"
) AS revisions ON revisions."tenant_id" = tenant."id";
