-- Content credits are the only billing fact source from this migration onward.
-- Historical plan, subscription, monthly quota, usage and paid-seat records are removed.

DELETE FROM "model_routes" WHERE "scope_type" = 'PLAN';

ALTER TABLE "model_routes" DROP CONSTRAINT IF EXISTS "model_routes_scope_shape_check";
ALTER TABLE "model_routes" DROP CONSTRAINT IF EXISTS "model_routes_plan_id_fkey";
DROP INDEX IF EXISTS "model_routes_plan_id_scope_type_idx";
ALTER TABLE "model_routes" DROP COLUMN IF EXISTS "plan_id";

ALTER TYPE "model_route_scope_type" RENAME TO "model_route_scope_type_legacy";
CREATE TYPE "model_route_scope_type" AS ENUM ('PLATFORM', 'TENANT', 'ENTERPRISE');
ALTER TABLE "model_routes"
  ALTER COLUMN "scope_type" TYPE "model_route_scope_type"
  USING "scope_type"::text::"model_route_scope_type";
DROP TYPE "model_route_scope_type_legacy";

ALTER TABLE "model_routes"
ADD CONSTRAINT "model_routes_scope_shape_check" CHECK (
  (
    "scope_type" = 'PLATFORM'
    AND "scope_id" = 'platform'
    AND "tenant_id" IS NULL
    AND "enterprise_id" IS NULL
  ) OR (
    "scope_type" = 'TENANT'
    AND "scope_id" = "tenant_id"
    AND "tenant_id" IS NOT NULL
    AND "enterprise_id" IS NULL
  ) OR (
    "scope_type" = 'ENTERPRISE'
    AND "scope_id" = "enterprise_id"
    AND "tenant_id" IS NOT NULL
    AND "enterprise_id" IS NOT NULL
  )
);

ALTER TABLE "campaigns"
  DROP CONSTRAINT IF EXISTS "campaigns_quota_period_id_tenant_id_fkey";
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "quota_period_id";

DROP TABLE IF EXISTS "usage_ledgers";
DROP TABLE IF EXISTS "seat_change_ledgers";
DROP TABLE IF EXISTS "quota_periods";
DROP TABLE IF EXISTS "subscriptions";
DROP TABLE IF EXISTS "plan_entitlements";
DROP TABLE IF EXISTS "plans";

DROP TYPE IF EXISTS "usage_ledger_type";
DROP TYPE IF EXISTS "seat_change_type";
DROP TYPE IF EXISTS "quota_period_status";
DROP TYPE IF EXISTS "subscription_status";
DROP TYPE IF EXISTS "billing_cycle";
DROP TYPE IF EXISTS "plan_status";
