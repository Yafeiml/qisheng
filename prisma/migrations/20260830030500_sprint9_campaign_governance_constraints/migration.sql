ALTER TABLE "generation_runs"
  DROP CONSTRAINT "generation_runs_timestamps_check";

ALTER TABLE "generation_runs"
  ADD CONSTRAINT "generation_runs_timestamps_check"
    CHECK (
      ("status" = 'QUEUED' AND "finished_at" IS NULL)
      OR ("status" = 'RUNNING' AND "started_at" IS NOT NULL AND "finished_at" IS NULL)
      OR ("status" IN ('SUCCEEDED', 'FAILED') AND "started_at" IS NOT NULL AND "finished_at" IS NOT NULL)
      OR ("status" = 'CANCELLED' AND "finished_at" IS NOT NULL)
    );
