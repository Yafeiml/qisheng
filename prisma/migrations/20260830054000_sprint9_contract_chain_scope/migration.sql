-- Contract revisions must remain inside the same tenant and immutable series,
-- including writes that bypass the application service layer.
ALTER TABLE "customer_contracts"
  DROP CONSTRAINT "customer_contracts_supersedes_id_fkey";

CREATE UNIQUE INDEX "customer_contracts_id_tenant_id_series_id_key"
  ON "customer_contracts"("id", "tenant_id", "series_id");

ALTER TABLE "customer_contracts"
  ADD CONSTRAINT "customer_contracts_supersedes_id_tenant_id_series_id_fkey"
  FOREIGN KEY ("supersedes_id", "tenant_id", "series_id")
  REFERENCES "customer_contracts"("id", "tenant_id", "series_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
