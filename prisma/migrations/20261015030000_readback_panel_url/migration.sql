BEGIN;
ALTER TABLE "publication_readback_nodes" ADD COLUMN "panel_url" TEXT;
COMMIT;
