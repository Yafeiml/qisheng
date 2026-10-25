CREATE TABLE "model_provider_invocation_leases" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "lease_owner" VARCHAR(200) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_provider_invocation_leases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "model_provider_invocation_leases_expiry_check" CHECK ("expires_at" > "created_at")
);

CREATE INDEX "model_provider_invocation_leases_provider_id_expires_at_idx"
ON "model_provider_invocation_leases"("provider_id", "expires_at");

CREATE INDEX "model_provider_invocation_leases_expires_at_idx"
ON "model_provider_invocation_leases"("expires_at");

ALTER TABLE "model_provider_invocation_leases"
ADD CONSTRAINT "model_provider_invocation_leases_provider_id_fkey"
FOREIGN KEY ("provider_id") REFERENCES "model_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
