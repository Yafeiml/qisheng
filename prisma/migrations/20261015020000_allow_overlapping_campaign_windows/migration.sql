BEGIN;
DROP TRIGGER IF EXISTS "campaigns_no_overlapping_delivery_windows" ON "campaigns";
DROP FUNCTION IF EXISTS "enforce_single_campaign_delivery_window"();
COMMIT;
