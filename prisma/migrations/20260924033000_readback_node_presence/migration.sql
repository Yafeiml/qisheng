CREATE TABLE "publication_readback_nodes" (
  "id" VARCHAR(80) NOT NULL,
  "panel_host" VARCHAR(15),
  "last_seen_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "publication_readback_nodes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "publication_readback_nodes_last_seen_at_idx"
  ON "publication_readback_nodes"("last_seen_at");

ALTER TABLE "publication_collector_state" ADD COLUMN "daily_limit" INTEGER;
ALTER TABLE "publication_collector_state"
  ADD CONSTRAINT "publication_collector_state_daily_limit_check"
  CHECK ("daily_limit" IS NULL OR "daily_limit" BETWEEN 1 AND 10000);
