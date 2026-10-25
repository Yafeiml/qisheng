-- Existing plan rows become immutable version 1 records.
ALTER TABLE "plans"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

DROP INDEX "plans_code_key";

CREATE UNIQUE INDEX "plans_code_version_key"
ON "plans"("code", "version");

CREATE INDEX "plans_code_status_idx"
ON "plans"("code", "status");

-- At most one sellable version of a commercial plan code can be active.
CREATE UNIQUE INDEX "plans_one_active_version_per_code_idx"
ON "plans"("code")
WHERE "status" = 'ACTIVE';

ALTER TABLE "plans"
ADD CONSTRAINT "plans_positive_version_check"
CHECK ("version" > 0);

-- A tenant can have at most one scheduled next subscription.
CREATE UNIQUE INDEX "subscriptions_one_pending_per_tenant_idx"
ON "subscriptions"("tenant_id")
WHERE "status" = 'PENDING';
