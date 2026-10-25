-- Maintenance migration: stop every old API and Worker before applying this version.
-- Historical migrations stay immutable; only retired balances and their references are removed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "campaigns"
  DROP COLUMN "credit_wallet_id";

ALTER TABLE "generation_work_items"
  DROP COLUMN "credit_lot_id",
  DROP COLUMN "credit_reserved";

DROP TABLE "credit_ledgers";
DROP TABLE "credit_lots";
DROP TABLE "recharge_orders";
DROP TABLE "recharge_products";
DROP TABLE "tenant_recharge_policies";
DROP TABLE "credit_wallets";

DROP TYPE "credit_ledger_type";
DROP TYPE "credit_lot_status";
DROP TYPE "credit_lot_source";
DROP TYPE "credit_wallet_status";
DROP TYPE "recharge_order_channel";
DROP TYPE "recharge_order_status";
DROP TYPE "recharge_product_status";

ALTER TABLE "campaigns"
  RENAME COLUMN "cancellation_settlement" TO "cancellation_summary";
UPDATE "campaigns"
SET "cancellation_summary" = jsonb_strip_nulls(jsonb_build_object(
  'cancelledDistributionTasks', "cancellation_summary"->'cancelledDistributionTasks',
  'cancelledGenerationRuns', "cancellation_summary"->'cancelledGenerationRuns',
  'cancelledWorkItems', "cancellation_summary"->'cancelledWorkItems'
))
WHERE "cancellation_summary" IS NOT NULL;

UPDATE "campaign_drafts"
SET "payload" = "payload" - 'fundingSource' - 'walletScope';
UPDATE "campaign_preflight_snapshots" AS snapshot
SET "checks" = COALESCE((
  SELECT jsonb_agg(item ORDER BY ordinal)
  FROM jsonb_array_elements(snapshot."checks") WITH ORDINALITY AS existing(item, ordinal)
  WHERE COALESCE(item->>'code', '') NOT IN ('CREDITS', 'CONTENT_CREDITS', 'CREDIT_WALLET_ACTIVE')
), '[]'::jsonb)
WHERE jsonb_typeof(snapshot."checks") = 'array';

DELETE FROM "role_permissions"
WHERE "permission_id" IN (
  SELECT "id" FROM "permissions"
  WHERE "code" LIKE '%.credit.%'
     OR "code" LIKE '%.recharge%'
);
DELETE FROM "permissions"
WHERE "code" LIKE '%.credit.%'
   OR "code" LIKE '%.recharge%';

COMMIT;
