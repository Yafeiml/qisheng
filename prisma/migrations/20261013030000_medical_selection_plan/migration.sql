-- Additive medical planning and evidence; historic campaigns remain unchanged.
ALTER TABLE "enterprise_memberships" ADD COLUMN "publisher_context" JSONB;
ALTER TABLE "campaigns" ADD COLUMN "selection_snapshot" JSONB;
ALTER TABLE "campaign_templates" ADD COLUMN "selection_snapshot" JSONB;
ALTER TABLE "distribution_tasks"
  ADD COLUMN "facts_confirmed_at" TIMESTAMP(3),
  ADD COLUMN "facts_confirmed_revision" INTEGER,
  ADD COLUMN "facts_returned_at" TIMESTAMP(3),
  ADD COLUMN "facts_return_reason" VARCHAR(64);

-- Authorized originals can be shared. Legacy workers still have their application checks.
DROP INDEX "generated_images_checksum_key";
DROP INDEX "generated_images_campaign_id_perceptual_hash_key";
CREATE INDEX "generated_images_checksum_idx" ON "generated_images"("checksum");
CREATE INDEX "generated_images_campaign_id_perceptual_hash_idx" ON "generated_images"("campaign_id", "perceptual_hash");

CREATE TABLE "campaign_effect_observations" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "payload" JSONB NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "campaign_effect_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "campaign_effect_observations_kind_check" CHECK ("kind" IN ('GEO', 'TRANSACTION'))
);
CREATE INDEX "campaign_effect_observations_scope_kind_observed_idx"
  ON "campaign_effect_observations"("tenant_id", "enterprise_id", "campaign_id", "kind", "observed_at");
ALTER TABLE "campaign_effect_observations"
  ADD CONSTRAINT "campaign_effect_observations_scope_fkey"
  FOREIGN KEY ("campaign_id", "enterprise_id", "tenant_id")
  REFERENCES "campaigns"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
