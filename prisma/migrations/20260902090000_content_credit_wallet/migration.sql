CREATE TYPE "credit_wallet_status" AS ENUM ('ACTIVE', 'FROZEN');
CREATE TYPE "credit_lot_source" AS ENUM ('PURCHASE', 'BONUS', 'OPENING', 'ADJUSTMENT');
CREATE TYPE "credit_lot_status" AS ENUM ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'REVOKED');
CREATE TYPE "credit_ledger_type" AS ENUM (
  'TOP_UP',
  'BONUS',
  'RESERVE',
  'CONSUME',
  'RELEASE',
  'ADJUST',
  'EXPIRE',
  'REFUND',
  'REVOKE'
);
CREATE TYPE "recharge_product_status" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "recharge_order_status" AS ENUM ('PENDING', 'PAID', 'CANCELLED', 'REFUNDED');
CREATE TYPE "recharge_order_channel" AS ENUM ('MANUAL', 'PAYMENT_GATEWAY');

CREATE TABLE "tenant_capability_policies" (
  "tenant_id" TEXT NOT NULL,
  "max_enterprises" INTEGER,
  "max_images_per_content" INTEGER NOT NULL DEFAULT 1,
  "group_shared_materials_enabled" BOOLEAN NOT NULL DEFAULT true,
  "geo_enabled" BOOLEAN NOT NULL DEFAULT true,
  "geo_entity_limit" INTEGER NOT NULL DEFAULT 500,
  "geo_topic_limit" INTEGER NOT NULL DEFAULT 5000,
  "metrics_integration_enabled" BOOLEAN NOT NULL DEFAULT true,
  "storage_limit_bytes" BIGINT NOT NULL DEFAULT 10737418240,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tenant_capability_policies_pkey" PRIMARY KEY ("tenant_id"),
  CONSTRAINT "tenant_capability_policies_limits_check" CHECK (
    ("max_enterprises" IS NULL OR "max_enterprises" >= 1)
    AND "max_images_per_content" >= 1
    AND "geo_entity_limit" >= 1
    AND "geo_topic_limit" >= 1
    AND "storage_limit_bytes" >= 0
  )
);

CREATE TABLE "credit_wallets" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "status" "credit_wallet_status" NOT NULL DEFAULT 'ACTIVE',
  "available_credits" INTEGER NOT NULL DEFAULT 0,
  "reserved_credits" INTEGER NOT NULL DEFAULT 0,
  "consumed_credits" INTEGER NOT NULL DEFAULT 0,
  "lifetime_granted" INTEGER NOT NULL DEFAULT 0,
  "lifetime_purchased" INTEGER NOT NULL DEFAULT 0,
  "lifetime_bonus" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "credit_wallets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_wallets_balances_check" CHECK (
    "available_credits" >= 0
    AND "reserved_credits" >= 0
    AND "consumed_credits" >= 0
    AND "lifetime_granted" >= 0
    AND "lifetime_purchased" >= 0
    AND "lifetime_bonus" >= 0
  )
);

CREATE TABLE "recharge_products" (
  "id" TEXT NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500),
  "purchased_credits" INTEGER NOT NULL,
  "bonus_credits" INTEGER NOT NULL DEFAULT 0,
  "price_minor" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'CNY',
  "bonus_expires_days" INTEGER,
  "tax_included" BOOLEAN NOT NULL DEFAULT true,
  "status" "recharge_product_status" NOT NULL DEFAULT 'ACTIVE',
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "starts_at" TIMESTAMP(3),
  "ends_at" TIMESTAMP(3),
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "recharge_products_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recharge_products_values_check" CHECK (
    "purchased_credits" >= 1
    AND "bonus_credits" >= 0
    AND "price_minor" >= 1
    AND ("bonus_expires_days" IS NULL OR "bonus_expires_days" >= 1)
    AND ("ends_at" IS NULL OR "starts_at" IS NULL OR "ends_at" > "starts_at")
  )
);

CREATE TABLE "recharge_orders" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "wallet_id" TEXT NOT NULL,
  "product_id" TEXT,
  "order_number" VARCHAR(80) NOT NULL,
  "status" "recharge_order_status" NOT NULL DEFAULT 'PENDING',
  "channel" "recharge_order_channel" NOT NULL DEFAULT 'MANUAL',
  "product_code_snapshot" VARCHAR(80),
  "product_name_snapshot" VARCHAR(120) NOT NULL,
  "purchased_credits" INTEGER NOT NULL,
  "bonus_credits" INTEGER NOT NULL DEFAULT 0,
  "amount_minor" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'CNY',
  "bonus_expires_days_snapshot" INTEGER,
  "tax_included" BOOLEAN NOT NULL DEFAULT true,
  "external_transaction_id" VARCHAR(160),
  "note" VARCHAR(500),
  "created_by" TEXT NOT NULL,
  "confirmed_by" TEXT,
  "paid_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "refunded_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "recharge_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recharge_orders_values_check" CHECK (
    "purchased_credits" >= 1
    AND "bonus_credits" >= 0
    AND "amount_minor" >= 1
    AND ("bonus_expires_days_snapshot" IS NULL OR "bonus_expires_days_snapshot" >= 1)
  ),
  CONSTRAINT "recharge_orders_paid_state_check" CHECK (
    ("status" <> 'PAID') OR ("paid_at" IS NOT NULL AND "confirmed_by" IS NOT NULL)
  )
);

CREATE TABLE "credit_lots" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "wallet_id" TEXT NOT NULL,
  "recharge_order_id" TEXT,
  "source" "credit_lot_source" NOT NULL,
  "status" "credit_lot_status" NOT NULL DEFAULT 'ACTIVE',
  "granted_credits" INTEGER NOT NULL,
  "available_credits" INTEGER NOT NULL,
  "reserved_credits" INTEGER NOT NULL DEFAULT 0,
  "consumed_credits" INTEGER NOT NULL DEFAULT 0,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "expires_at" TIMESTAMP(3),
  "created_by" TEXT,
  "note" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "credit_lots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_lots_balances_check" CHECK (
    "granted_credits" >= 0
    AND "available_credits" >= 0
    AND "reserved_credits" >= 0
    AND "consumed_credits" >= 0
  )
);

CREATE TABLE "credit_ledgers" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "wallet_id" TEXT NOT NULL,
  "lot_id" TEXT,
  "recharge_order_id" TEXT,
  "campaign_id" TEXT,
  "generation_work_item_id" TEXT,
  "distribution_task_id" TEXT,
  "type" "credit_ledger_type" NOT NULL,
  "amount" INTEGER NOT NULL,
  "available_after" INTEGER NOT NULL,
  "reserved_after" INTEGER NOT NULL,
  "consumed_after" INTEGER NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "created_by" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "credit_ledgers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_ledgers_values_check" CHECK (
    "amount" >= 1
    AND "available_after" >= 0
    AND "reserved_after" >= 0
    AND "consumed_after" >= 0
  )
);

ALTER TABLE "campaigns" ADD COLUMN "credit_wallet_id" TEXT;
ALTER TABLE "generation_work_items" ADD COLUMN "credit_lot_id" TEXT;

CREATE UNIQUE INDEX "credit_wallets_tenant_id_key" ON "credit_wallets"("tenant_id");
CREATE UNIQUE INDEX "credit_wallets_id_tenant_id_key" ON "credit_wallets"("id", "tenant_id");
CREATE INDEX "credit_wallets_status_updated_at_idx" ON "credit_wallets"("status", "updated_at");
CREATE UNIQUE INDEX "recharge_products_code_key" ON "recharge_products"("code");
CREATE INDEX "recharge_products_status_sort_order_created_at_idx" ON "recharge_products"("status", "sort_order", "created_at");
CREATE UNIQUE INDEX "recharge_orders_order_number_key" ON "recharge_orders"("order_number");
CREATE UNIQUE INDEX "recharge_orders_id_tenant_id_key" ON "recharge_orders"("id", "tenant_id");
CREATE INDEX "recharge_orders_tenant_id_status_created_at_idx" ON "recharge_orders"("tenant_id", "status", "created_at");
CREATE INDEX "recharge_orders_product_id_status_idx" ON "recharge_orders"("product_id", "status");
CREATE UNIQUE INDEX "credit_lots_id_tenant_id_key" ON "credit_lots"("id", "tenant_id");
CREATE INDEX "credit_lots_tenant_id_status_priority_expires_at_created_at_idx" ON "credit_lots"("tenant_id", "status", "priority", "expires_at", "created_at");
CREATE INDEX "credit_lots_recharge_order_id_idx" ON "credit_lots"("recharge_order_id");
CREATE UNIQUE INDEX "credit_ledgers_tenant_id_idempotency_key_key" ON "credit_ledgers"("tenant_id", "idempotency_key");
CREATE INDEX "credit_ledgers_tenant_id_created_at_id_idx" ON "credit_ledgers"("tenant_id", "created_at", "id");
CREATE INDEX "credit_ledgers_wallet_id_type_created_at_idx" ON "credit_ledgers"("wallet_id", "type", "created_at");
CREATE INDEX "credit_ledgers_campaign_id_type_created_at_idx" ON "credit_ledgers"("campaign_id", "type", "created_at");
CREATE INDEX "credit_ledgers_generation_work_item_id_type_idx" ON "credit_ledgers"("generation_work_item_id", "type");
CREATE INDEX "campaigns_credit_wallet_id_status_created_at_idx" ON "campaigns"("credit_wallet_id", "status", "created_at");
CREATE INDEX "generation_work_items_credit_lot_id_credit_reserved_status_idx" ON "generation_work_items"("credit_lot_id", "credit_reserved", "status");

ALTER TABLE "tenant_capability_policies" ADD CONSTRAINT "tenant_capability_policies_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recharge_orders" ADD CONSTRAINT "recharge_orders_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recharge_orders" ADD CONSTRAINT "recharge_orders_wallet_id_tenant_id_fkey"
  FOREIGN KEY ("wallet_id", "tenant_id") REFERENCES "credit_wallets"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recharge_orders" ADD CONSTRAINT "recharge_orders_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "recharge_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_wallet_id_tenant_id_fkey"
  FOREIGN KEY ("wallet_id", "tenant_id") REFERENCES "credit_wallets"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_recharge_order_id_tenant_id_fkey"
  FOREIGN KEY ("recharge_order_id", "tenant_id") REFERENCES "recharge_orders"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_ledgers" ADD CONSTRAINT "credit_ledgers_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_ledgers" ADD CONSTRAINT "credit_ledgers_wallet_id_tenant_id_fkey"
  FOREIGN KEY ("wallet_id", "tenant_id") REFERENCES "credit_wallets"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_ledgers" ADD CONSTRAINT "credit_ledgers_lot_id_tenant_id_fkey"
  FOREIGN KEY ("lot_id", "tenant_id") REFERENCES "credit_lots"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_ledgers" ADD CONSTRAINT "credit_ledgers_recharge_order_id_tenant_id_fkey"
  FOREIGN KEY ("recharge_order_id", "tenant_id") REFERENCES "recharge_orders"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_ledgers" ADD CONSTRAINT "credit_ledgers_campaign_id_tenant_id_fkey"
  FOREIGN KEY ("campaign_id", "tenant_id") REFERENCES "campaigns"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_ledgers" ADD CONSTRAINT "credit_ledgers_generation_work_item_id_tenant_id_fkey"
  FOREIGN KEY ("generation_work_item_id", "tenant_id") REFERENCES "generation_work_items"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_ledgers" ADD CONSTRAINT "credit_ledgers_distribution_task_id_tenant_id_fkey"
  FOREIGN KEY ("distribution_task_id", "tenant_id") REFERENCES "distribution_tasks"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_credit_wallet_id_tenant_id_fkey"
  FOREIGN KEY ("credit_wallet_id", "tenant_id") REFERENCES "credit_wallets"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "generation_work_items" ADD CONSTRAINT "generation_work_items_credit_lot_id_tenant_id_fkey"
  FOREIGN KEY ("credit_lot_id", "tenant_id") REFERENCES "credit_lots"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "tenant_capability_policies" (
  "tenant_id",
  "max_enterprises",
  "max_images_per_content",
  "group_shared_materials_enabled",
  "geo_enabled",
  "geo_entity_limit",
  "geo_topic_limit",
  "metrics_integration_enabled",
  "storage_limit_bytes",
  "updated_at"
)
SELECT
  tenant."id",
  NULL,
  COALESCE(entitlement."images_per_distribution", 1),
  COALESCE(entitlement."group_shared_materials_enabled", true),
  true,
  CASE COALESCE(entitlement."geo_level", 'ADVANCED') WHEN 'BASIC' THEN 20 WHEN 'STANDARD' THEN 100 ELSE 500 END,
  CASE COALESCE(entitlement."geo_level", 'ADVANCED') WHEN 'BASIC' THEN 100 WHEN 'STANDARD' THEN 1000 ELSE 5000 END,
  COALESCE(entitlement."metrics_integration_enabled", true),
  COALESCE(entitlement."storage_quota_bytes", 10737418240),
  CURRENT_TIMESTAMP
FROM "tenants" tenant
LEFT JOIN LATERAL (
  SELECT plan_entitlement.*
  FROM "quota_periods" quota
  JOIN "subscriptions" subscription ON subscription."id" = quota."subscription_id"
  JOIN "plan_entitlements" plan_entitlement ON plan_entitlement."plan_id" = subscription."plan_id"
  WHERE quota."tenant_id" = tenant."id"
    AND quota."status" = 'ACTIVE'
  ORDER BY quota."period_start" DESC
  LIMIT 1
) entitlement ON true;

INSERT INTO "credit_wallets" (
  "id",
  "tenant_id",
  "available_credits",
  "reserved_credits",
  "consumed_credits",
  "lifetime_granted",
  "lifetime_purchased",
  "lifetime_bonus",
  "updated_at"
)
SELECT
  'cw_' || substr(md5(tenant."id"), 1, 24),
  tenant."id",
  GREATEST(COALESCE(quota."content_credit_limit", 0) - COALESCE(quota."content_credit_reserved", 0) - COALESCE(quota."content_credit_consumed", 0), 0),
  COALESCE(quota."content_credit_reserved", 0),
  COALESCE(quota."content_credit_consumed", 0),
  GREATEST(COALESCE(quota."content_credit_limit", 0), COALESCE(quota."content_credit_reserved", 0) + COALESCE(quota."content_credit_consumed", 0)),
  GREATEST(COALESCE(quota."content_credit_limit", 0), COALESCE(quota."content_credit_reserved", 0) + COALESCE(quota."content_credit_consumed", 0)),
  0,
  CURRENT_TIMESTAMP
FROM "tenants" tenant
LEFT JOIN LATERAL (
  SELECT quota.*
  FROM "quota_periods" quota
  WHERE quota."tenant_id" = tenant."id" AND quota."status" = 'ACTIVE'
  ORDER BY quota."period_start" DESC
  LIMIT 1
) quota ON true;

INSERT INTO "credit_lots" (
  "id",
  "tenant_id",
  "wallet_id",
  "source",
  "status",
  "granted_credits",
  "available_credits",
  "reserved_credits",
  "consumed_credits",
  "priority",
  "created_by",
  "note",
  "updated_at"
)
SELECT
  'cl_open_' || substr(md5(wallet."tenant_id"), 1, 24),
  wallet."tenant_id",
  wallet."id",
  'OPENING',
  (CASE WHEN wallet."available_credits" + wallet."reserved_credits" = 0 THEN 'EXHAUSTED' ELSE 'ACTIVE' END)::"credit_lot_status",
  wallet."lifetime_granted",
  wallet."available_credits",
  wallet."reserved_credits",
  wallet."consumed_credits",
  200,
  'system:migration',
  'Opening balance migrated from the active legacy quota period',
  CURRENT_TIMESTAMP
FROM "credit_wallets" wallet
WHERE wallet."lifetime_granted" > 0;

UPDATE "campaigns" campaign
SET "credit_wallet_id" = wallet."id"
FROM "credit_wallets" wallet
WHERE wallet."tenant_id" = campaign."tenant_id";

UPDATE "generation_work_items" item
SET "credit_lot_id" = lot."id"
FROM "credit_lots" lot
WHERE lot."tenant_id" = item."tenant_id"
  AND lot."source" = 'OPENING'
  AND item."credit_reserved" = true;

INSERT INTO "credit_ledgers" (
  "id",
  "tenant_id",
  "wallet_id",
  "lot_id",
  "type",
  "amount",
  "available_after",
  "reserved_after",
  "consumed_after",
  "idempotency_key",
  "reason",
  "created_by",
  "metadata"
)
SELECT
  'cled_open_' || substr(md5(wallet."tenant_id"), 1, 20),
  wallet."tenant_id",
  wallet."id",
  lot."id",
  'ADJUST',
  wallet."lifetime_granted",
  wallet."available_credits",
  wallet."reserved_credits",
  wallet."consumed_credits",
  'migration:opening-balance:v1',
  'Opening content credit balance migrated from the legacy quota model',
  'system:migration',
  jsonb_build_object('source', 'quota_periods', 'migration', 'content_credit_wallet')
FROM "credit_wallets" wallet
JOIN "credit_lots" lot ON lot."wallet_id" = wallet."id" AND lot."source" = 'OPENING'
WHERE wallet."lifetime_granted" > 0;

INSERT INTO "recharge_products" (
  "id", "code", "name", "description", "purchased_credits", "bonus_credits", "price_minor",
  "currency", "tax_included", "status", "sort_order", "created_by", "updated_at"
)
VALUES
  ('rp_starter_10', 'CREDIT_10', '10 个内容点数', '适合小规模试用与临时补充', 10, 0, 5000, 'CNY', true, 'ACTIVE', 10, 'system:migration', CURRENT_TIMESTAMP),
  ('rp_growth_100', 'CREDIT_100_BONUS_10', '100 个内容点数', '充值 100 个内容点数，赠送 10 个', 100, 10, 50000, 'CNY', true, 'ACTIVE', 20, 'system:migration', CURRENT_TIMESTAMP),
  ('rp_scale_1000', 'CREDIT_1000_BONUS_200', '1000 个内容点数', '充值 1000 个内容点数，赠送 200 个', 1000, 200, 500000, 'CNY', true, 'ACTIVE', 30, 'system:migration', CURRENT_TIMESTAMP);
