CREATE TABLE "tenant_recharge_policies" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "pay_rate_bps" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "note" VARCHAR(500) NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tenant_recharge_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_recharge_policies_rate_check" CHECK ("pay_rate_bps" BETWEEN 1 AND 9999),
    CONSTRAINT "tenant_recharge_policies_version_check" CHECK ("version" > 0),
    CONSTRAINT "tenant_recharge_policies_window_check" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at"),
    CONSTRAINT "tenant_recharge_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "tenant_recharge_policies_tenant_id_key" ON "tenant_recharge_policies"("tenant_id");

ALTER TABLE "recharge_orders"
    ADD COLUMN "original_amount_minor" BIGINT,
    ADD COLUMN "discount_minor" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "pay_rate_bps_snapshot" INTEGER NOT NULL DEFAULT 10000,
    ADD COLUMN "policy_id_snapshot" TEXT,
    ADD COLUMN "policy_version_snapshot" INTEGER,
    ADD COLUMN "expires_at" TIMESTAMP(3);

-- Historical orders retain their original agreed price and confirmation behavior.
UPDATE "recharge_orders" SET "original_amount_minor" = "amount_minor";
ALTER TABLE "recharge_orders" ALTER COLUMN "original_amount_minor" SET NOT NULL;
ALTER TABLE "recharge_orders"
    ADD CONSTRAINT "recharge_orders_price_snapshot_check" CHECK (
        "original_amount_minor" > 0 AND "amount_minor" > 0 AND "discount_minor" >= 0
        AND "original_amount_minor" - "discount_minor" = "amount_minor"
        AND "pay_rate_bps_snapshot" BETWEEN 1 AND 10000
    );
