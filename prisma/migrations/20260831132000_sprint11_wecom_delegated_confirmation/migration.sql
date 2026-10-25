ALTER TABLE "directory_enterprise_mappings"
ADD COLUMN "allow_enterprise_sync_confirmation" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "directory_enterprise_mappings_enterprise_confirmation_idx"
ON "directory_enterprise_mappings"("enterprise_id", "allow_enterprise_sync_confirmation", "status");
