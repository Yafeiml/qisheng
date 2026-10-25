CREATE INDEX "publication_collection_jobs_kind_updated_at_id_idx"
  ON "publication_collection_jobs" ("kind", "updated_at" DESC, "id" DESC);
