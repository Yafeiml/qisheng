ALTER TABLE "publication_readback_budget"
  ALTER COLUMN "updated_at" DROP DEFAULT;

ALTER INDEX "publish_readback_snapshots_tenant_id_campaign_id_observed_at_id"
  RENAME TO "publish_readback_snapshots_tenant_id_campaign_id_observed_a_idx";
