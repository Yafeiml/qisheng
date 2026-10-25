-- Prevent an enterprise from exposing two employee campaigns at the same time.
-- Existing rows are intentionally not rewritten: the trigger protects every new
-- approval/reschedule and serializes concurrent writes per enterprise.
CREATE OR REPLACE FUNCTION "enforce_single_campaign_delivery_window"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" IN ('APPROVED', 'ACTIVE') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW."enterprise_id", 0));

    IF EXISTS (
      SELECT 1
      FROM "campaigns" AS existing
      WHERE existing."enterprise_id" = NEW."enterprise_id"
        AND existing."id" <> NEW."id"
        AND existing."status" IN ('APPROVED', 'ACTIVE')
        AND tsrange(existing."visible_at", existing."expires_at", '[)')
          && tsrange(NEW."visible_at", NEW."expires_at", '[)')
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23P01',
        CONSTRAINT = 'campaigns_no_overlapping_delivery_windows',
        MESSAGE = 'campaigns_no_overlapping_delivery_windows';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "campaigns_no_overlapping_delivery_windows"
BEFORE INSERT OR UPDATE OF "enterprise_id", "status", "visible_at", "expires_at"
ON "campaigns"
FOR EACH ROW
EXECUTE FUNCTION "enforce_single_campaign_delivery_window"();
