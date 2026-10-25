ALTER TABLE "credit_wallets"
    ADD COLUMN "enterprise_id" TEXT,
    ADD COLUMN "scope_key" TEXT NOT NULL DEFAULT '__tenant__';
DROP INDEX "credit_wallets_tenant_id_key";
CREATE UNIQUE INDEX "credit_wallets_tenant_id_scope_key_key" ON "credit_wallets"("tenant_id", "scope_key");
ALTER TABLE "credit_wallets"
    ADD CONSTRAINT "credit_wallets_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "credit_wallets_scope_check" CHECK (
        ("enterprise_id" IS NULL AND "scope_key" = '__tenant__') OR
        ("enterprise_id" IS NOT NULL AND "scope_key" = "enterprise_id")
    );

-- A standalone customer's wallet belongs to its only enterprise.
UPDATE "credit_wallets" AS wallet
SET "enterprise_id" = enterprise."id", "scope_key" = enterprise."id"
FROM "tenants" AS tenant, "enterprises" AS enterprise
WHERE wallet."tenant_id" = tenant."id"
  AND tenant."customer_type" = 'SINGLE_ENTERPRISE'
  AND enterprise."tenant_id" = tenant."id";
