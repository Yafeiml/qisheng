-- The browser's first verified observation is recorded at window 0.
-- Preserve legacy positive windows while allowing that initial snapshot.
ALTER TABLE "publish_metric_snapshots"
  DROP CONSTRAINT "publish_metric_snapshots_window_check";

ALTER TABLE "publish_metric_snapshots"
  ADD CONSTRAINT "publish_metric_snapshots_window_check"
  CHECK ("window_hours" IS NULL OR "window_hours" >= 0);
