CREATE TYPE "customer_contract_status" AS ENUM (
  'DRAFT',
  'SIGNED',
  'ACTIVE',
  'SUPERSEDED',
  'TERMINATED'
);

ALTER TABLE "plans"
  ADD COLUMN "standard_price_minor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'CNY',
  ADD COLUMN "trial_days" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "tax_included" BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE "plans"
  ADD CONSTRAINT "plans_standard_price_minor_nonnegative"
    CHECK ("standard_price_minor" >= 0),
  ADD CONSTRAINT "plans_trial_days_nonnegative"
    CHECK ("trial_days" >= 0),
  ADD CONSTRAINT "plans_currency_iso_length"
    CHECK (char_length("currency") = 3);

CREATE TABLE "customer_contracts" (
  "id" TEXT NOT NULL,
  "series_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "supersedes_id" TEXT,
  "tenant_id" TEXT NOT NULL,
  "contract_number" VARCHAR(120) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "discount_minor" BIGINT NOT NULL DEFAULT 0,
  "currency" VARCHAR(3) NOT NULL,
  "tax_included" BOOLEAN NOT NULL DEFAULT TRUE,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3) NOT NULL,
  "signed_at" TIMESTAMP(3),
  "status" "customer_contract_status" NOT NULL DEFAULT 'DRAFT',
  "change_note" VARCHAR(500),
  "terminated_at" TIMESTAMP(3),
  "termination_reason" VARCHAR(500),
  "terminated_by" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "customer_contracts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_contracts_amount_nonnegative" CHECK ("amount_minor" >= 0),
  CONSTRAINT "customer_contracts_discount_nonnegative" CHECK ("discount_minor" >= 0),
  CONSTRAINT "customer_contracts_discount_not_above_amount" CHECK ("discount_minor" <= "amount_minor"),
  CONSTRAINT "customer_contracts_period_valid" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "customer_contracts_currency_iso_length" CHECK (char_length("currency") = 3),
  CONSTRAINT "customer_contracts_termination_facts" CHECK (
    ("status" = 'TERMINATED' AND "terminated_at" IS NOT NULL AND "termination_reason" IS NOT NULL)
    OR
    ("status" <> 'TERMINATED' AND "terminated_at" IS NULL AND "termination_reason" IS NULL)
  )
);

CREATE UNIQUE INDEX "customer_contracts_series_id_version_key"
  ON "customer_contracts"("series_id", "version");
CREATE UNIQUE INDEX "customer_contracts_tenant_id_contract_number_version_key"
  ON "customer_contracts"("tenant_id", "contract_number", "version");
CREATE UNIQUE INDEX "customer_contracts_id_tenant_id_key"
  ON "customer_contracts"("id", "tenant_id");
CREATE INDEX "customer_contracts_tenant_id_status_created_at_idx"
  ON "customer_contracts"("tenant_id", "status", "created_at");
CREATE INDEX "customer_contracts_supersedes_id_idx"
  ON "customer_contracts"("supersedes_id");

ALTER TABLE "customer_contracts"
  ADD CONSTRAINT "customer_contracts_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_contracts_supersedes_id_fkey"
    FOREIGN KEY ("supersedes_id") REFERENCES "customer_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscriptions" ADD COLUMN "contract_id" TEXT;
CREATE INDEX "subscriptions_contract_id_idx" ON "subscriptions"("contract_id");
ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_contract_id_tenant_id_fkey"
    FOREIGN KEY ("contract_id", "tenant_id") REFERENCES "customer_contracts"("id", "tenant_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
