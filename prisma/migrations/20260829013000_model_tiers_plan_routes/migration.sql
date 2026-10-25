-- Extend model capabilities for the platform catalog.
ALTER TYPE "model_capability" ADD VALUE IF NOT EXISTS 'EMBEDDING';
ALTER TYPE "model_capability" ADD VALUE IF NOT EXISTS 'VISION';

-- CreateEnum
CREATE TYPE "model_tier" AS ENUM ('BASIC', 'STANDARD', 'ADVANCED', 'PREMIUM');

-- CreateEnum
CREATE TYPE "model_route_scope_type" AS ENUM ('PLATFORM', 'PLAN', 'TENANT', 'ENTERPRISE');

-- AlterTable
ALTER TABLE "model_definitions"
ADD COLUMN "tier" "model_tier" NOT NULL DEFAULT 'STANDARD';

UPDATE "model_definitions"
SET "tier" = CASE UPPER(COALESCE("metadata"->>'tier', 'STANDARD'))
  WHEN 'BASIC' THEN 'BASIC'::"model_tier"
  WHEN 'ADVANCED' THEN 'ADVANCED'::"model_tier"
  WHEN 'PREMIUM' THEN 'PREMIUM'::"model_tier"
  ELSE 'STANDARD'::"model_tier"
END;

-- Replace the access-control enum with a route-specific scope enum and add plan routing.
ALTER TABLE "model_routes" DROP CONSTRAINT "model_routes_scope_shape_check";
DROP INDEX "model_routes_scope_type_scope_id_key";
DROP INDEX "model_routes_tenant_id_scope_type_idx";
DROP INDEX "model_routes_enterprise_id_scope_type_idx";

ALTER TABLE "model_routes"
ALTER COLUMN "scope_type" TYPE "model_route_scope_type"
USING "scope_type"::text::"model_route_scope_type";

ALTER TABLE "model_routes" ADD COLUMN "plan_id" TEXT;

CREATE UNIQUE INDEX "model_routes_scope_type_scope_id_key"
ON "model_routes"("scope_type", "scope_id");
CREATE INDEX "model_routes_plan_id_scope_type_idx" ON "model_routes"("plan_id", "scope_type");
CREATE INDEX "model_routes_tenant_id_scope_type_idx" ON "model_routes"("tenant_id", "scope_type");
CREATE INDEX "model_routes_enterprise_id_scope_type_idx"
ON "model_routes"("enterprise_id", "scope_type");

ALTER TABLE "model_routes"
ADD CONSTRAINT "model_routes_plan_id_fkey"
FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "model_routes"
ADD CONSTRAINT "model_routes_scope_shape_check" CHECK (
  (
    "scope_type" = 'PLATFORM'
    AND "scope_id" = 'platform'
    AND "plan_id" IS NULL
    AND "tenant_id" IS NULL
    AND "enterprise_id" IS NULL
  ) OR (
    "scope_type" = 'PLAN'
    AND "scope_id" = "plan_id"
    AND "plan_id" IS NOT NULL
    AND "tenant_id" IS NULL
    AND "enterprise_id" IS NULL
  ) OR (
    "scope_type" = 'TENANT'
    AND "scope_id" = "tenant_id"
    AND "plan_id" IS NULL
    AND "tenant_id" IS NOT NULL
    AND "enterprise_id" IS NULL
  ) OR (
    "scope_type" = 'ENTERPRISE'
    AND "scope_id" = "enterprise_id"
    AND "plan_id" IS NULL
    AND "tenant_id" IS NOT NULL
    AND "enterprise_id" IS NOT NULL
  )
);
