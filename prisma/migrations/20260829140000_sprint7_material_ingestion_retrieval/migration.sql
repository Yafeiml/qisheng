CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE "material_ingestion_status" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'QUARANTINED');
CREATE TYPE "material_artifact_kind" AS ENUM ('UPLOAD', 'LINK_SNAPSHOT', 'IMAGE_SOURCE');
CREATE TYPE "material_artifact_status" AS ENUM ('PENDING_UPLOAD', 'STORED', 'VERIFIED', 'REJECTED');

ALTER TABLE "materials"
ADD COLUMN "content_checksum" VARCHAR(64),
ADD COLUMN "extracted_metadata" JSONB,
ADD COLUMN "ingestion_error_code" VARCHAR(120),
ADD COLUMN "ingestion_error_message" VARCHAR(500),
ADD COLUMN "ingestion_status" "material_ingestion_status" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "parser_version" VARCHAR(80),
ADD COLUMN "ready_at" TIMESTAMP(3),
ADD COLUMN "scope_key" VARCHAR(64);

UPDATE "materials"
SET
  "scope_key" = COALESCE("enterprise_id", '__tenant__'),
  "ingestion_status" = 'READY',
  "content_checksum" = encode(digest("content", 'sha256'), 'hex'),
  "parser_version" = 'legacy-text-v1',
  "ready_at" = COALESCE("updated_at", "created_at")
WHERE "scope_key" IS NULL;

ALTER TABLE "materials"
ALTER COLUMN "scope_key" SET NOT NULL;

ALTER TABLE "materials"
ADD CONSTRAINT "materials_scope_key_check"
CHECK (
  ("enterprise_id" IS NULL AND "scope_key" = '__tenant__') OR
  ("enterprise_id" IS NOT NULL AND "scope_key" = "enterprise_id")
),
ADD CONSTRAINT "materials_checksum_check"
CHECK ("content_checksum" IS NULL OR "content_checksum" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "materials_ready_content_check"
CHECK ("ingestion_status" <> 'READY' OR length(btrim("content")) > 0);

ALTER TABLE "runtime_policies"
ADD COLUMN "embedding_model_id" TEXT,
ADD COLUMN "material_chunk_overlap_characters" INTEGER NOT NULL DEFAULT 160,
ADD COLUMN "material_chunk_size_characters" INTEGER NOT NULL DEFAULT 1200,
ADD COLUMN "retrieval_max_context_characters" INTEGER NOT NULL DEFAULT 12000,
ADD COLUMN "retrieval_strategy_version" VARCHAR(120) NOT NULL DEFAULT 'hybrid-v1',
ADD COLUMN "retrieval_top_k" INTEGER NOT NULL DEFAULT 8,
ADD CONSTRAINT "runtime_policies_retrieval_top_k_check" CHECK ("retrieval_top_k" BETWEEN 1 AND 50),
ADD CONSTRAINT "runtime_policies_retrieval_context_check" CHECK ("retrieval_max_context_characters" BETWEEN 1000 AND 100000),
ADD CONSTRAINT "runtime_policies_chunk_size_check" CHECK ("material_chunk_size_characters" BETWEEN 200 AND 10000),
ADD CONSTRAINT "runtime_policies_chunk_overlap_check" CHECK (
  "material_chunk_overlap_characters" BETWEEN 0 AND 2000 AND
  "material_chunk_overlap_characters" < "material_chunk_size_characters"
);

CREATE TABLE "material_artifacts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT,
  "scope_key" VARCHAR(64) NOT NULL,
  "material_id" TEXT NOT NULL,
  "kind" "material_artifact_kind" NOT NULL,
  "status" "material_artifact_status" NOT NULL DEFAULT 'PENDING_UPLOAD',
  "object_key" VARCHAR(1000),
  "original_file_name" VARCHAR(255),
  "source_url" VARCHAR(1000),
  "mime_type" VARCHAR(160) NOT NULL,
  "byte_size" INTEGER,
  "checksum" VARCHAR(64),
  "metadata" JSONB,
  "stored_at" TIMESTAMP(3),
  "verified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "material_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "material_artifacts_scope_key_check" CHECK (
    ("enterprise_id" IS NULL AND "scope_key" = '__tenant__') OR
    ("enterprise_id" IS NOT NULL AND "scope_key" = "enterprise_id")
  ),
  CONSTRAINT "material_artifacts_size_check" CHECK ("byte_size" IS NULL OR "byte_size" BETWEEN 1 AND 26214400),
  CONSTRAINT "material_artifacts_checksum_check" CHECK ("checksum" IS NULL OR "checksum" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "material_ingestion_jobs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT,
  "scope_key" VARCHAR(64) NOT NULL,
  "material_id" TEXT NOT NULL,
  "artifact_id" TEXT,
  "status" "material_ingestion_status" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "queue_version" INTEGER NOT NULL DEFAULT 1,
  "parser_version" VARCHAR(80) NOT NULL,
  "lease_owner" VARCHAR(180),
  "lease_token" VARCHAR(64),
  "lease_expires_at" TIMESTAMP(3),
  "heartbeat_at" TIMESTAMP(3),
  "next_retry_at" TIMESTAMP(3),
  "error_code" VARCHAR(120),
  "error_message" VARCHAR(500),
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "material_ingestion_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "material_ingestion_jobs_scope_key_check" CHECK (
    ("enterprise_id" IS NULL AND "scope_key" = '__tenant__') OR
    ("enterprise_id" IS NOT NULL AND "scope_key" = "enterprise_id")
  ),
  CONSTRAINT "material_ingestion_jobs_attempt_check" CHECK (
    "attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 20 AND "queue_version" > 0
  )
);

CREATE TABLE "material_chunks" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT,
  "scope_key" VARCHAR(64) NOT NULL,
  "material_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "text_checksum" VARCHAR(64) NOT NULL,
  "character_count" INTEGER NOT NULL,
  "token_count" INTEGER NOT NULL,
  "structured_facts" JSONB,
  "metadata" JSONB,
  "search_vector" tsvector,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "material_chunks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "material_chunks_scope_key_check" CHECK (
    ("enterprise_id" IS NULL AND "scope_key" = '__tenant__') OR
    ("enterprise_id" IS NOT NULL AND "scope_key" = "enterprise_id")
  ),
  CONSTRAINT "material_chunks_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "material_chunks_text_check" CHECK (
    length(btrim("text")) > 0 AND
    "character_count" = length("text") AND
    "token_count" > 0 AND
    "text_checksum" ~ '^[0-9a-f]{64}$'
  )
);

CREATE OR REPLACE FUNCTION material_chunk_search_vector_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."search_vector" := to_tsvector('simple', COALESCE(NEW."text", ''));
  RETURN NEW;
END;
$$;

CREATE TRIGGER material_chunks_search_vector_trigger
BEFORE INSERT OR UPDATE OF "text" ON "material_chunks"
FOR EACH ROW EXECUTE FUNCTION material_chunk_search_vector_update();

CREATE TABLE "material_embeddings" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT,
  "scope_key" VARCHAR(64) NOT NULL,
  "material_id" TEXT NOT NULL,
  "chunk_id" TEXT NOT NULL,
  "model_definition_id" TEXT,
  "profile_version" VARCHAR(120) NOT NULL,
  "dimension" INTEGER NOT NULL,
  "vector" DOUBLE PRECISION[],
  "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "material_embeddings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "material_embeddings_scope_key_check" CHECK (
    ("enterprise_id" IS NULL AND "scope_key" = '__tenant__') OR
    ("enterprise_id" IS NOT NULL AND "scope_key" = "enterprise_id")
  ),
  CONSTRAINT "material_embeddings_vector_check" CHECK (
    "dimension" BETWEEN 8 AND 4096 AND cardinality("vector") = "dimension"
  )
);

CREATE TABLE "campaign_retrieval_evidence" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "material_id" TEXT NOT NULL,
  "material_scope_key" VARCHAR(64) NOT NULL,
  "chunk_id" TEXT NOT NULL,
  "material_series_id" TEXT NOT NULL,
  "material_version" INTEGER NOT NULL,
  "material_title" VARCHAR(200) NOT NULL,
  "material_type" "material_type" NOT NULL,
  "frozen_snippet" TEXT NOT NULL,
  "score" DECIMAL(12,8) NOT NULL,
  "lexical_score" DECIMAL(12,8) NOT NULL,
  "vector_score" DECIMAL(12,8) NOT NULL,
  "tag_score" DECIMAL(12,8) NOT NULL,
  "rank" INTEGER NOT NULL,
  "hit_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "strategy_version" VARCHAR(120) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "campaign_retrieval_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "campaign_retrieval_evidence_score_check" CHECK (
    "rank" > 0 AND "material_version" > 0 AND
    "score" >= 0 AND "lexical_score" >= 0 AND "vector_score" >= 0 AND "tag_score" >= 0 AND
    length(btrim("frozen_snippet")) > 0
  ),
  CONSTRAINT "campaign_retrieval_evidence_scope_check" CHECK (
    "material_scope_key" = '__tenant__' OR "material_scope_key" = "enterprise_id"
  )
);

CREATE UNIQUE INDEX "materials_id_tenant_id_key" ON "materials"("id", "tenant_id");
CREATE UNIQUE INDEX "materials_id_tenant_id_scope_key_key" ON "materials"("id", "tenant_id", "scope_key");
CREATE INDEX "materials_tenant_id_scope_key_ingestion_status_status_autho_idx"
ON "materials"("tenant_id", "scope_key", "ingestion_status", "status", "authorization_status");

CREATE UNIQUE INDEX "material_artifacts_id_tenant_id_key" ON "material_artifacts"("id", "tenant_id");
CREATE UNIQUE INDEX "material_artifacts_material_id_id_tenant_id_scope_key_key"
ON "material_artifacts"("material_id", "id", "tenant_id", "scope_key");
CREATE INDEX "material_artifacts_tenant_id_checksum_idx" ON "material_artifacts"("tenant_id", "checksum");
CREATE INDEX "material_artifacts_material_id_status_idx" ON "material_artifacts"("material_id", "status");

CREATE UNIQUE INDEX "material_ingestion_jobs_material_id_queue_version_key"
ON "material_ingestion_jobs"("material_id", "queue_version");
CREATE INDEX "material_ingestion_jobs_tenant_id_status_next_retry_at_crea_idx"
ON "material_ingestion_jobs"("tenant_id", "status", "next_retry_at", "created_at");
CREATE INDEX "material_ingestion_jobs_status_lease_expires_at_idx"
ON "material_ingestion_jobs"("status", "lease_expires_at");

CREATE UNIQUE INDEX "material_chunks_material_id_ordinal_key" ON "material_chunks"("material_id", "ordinal");
CREATE UNIQUE INDEX "material_chunks_id_material_id_tenant_id_scope_key_key"
ON "material_chunks"("id", "material_id", "tenant_id", "scope_key");
CREATE INDEX "material_chunks_tenant_id_scope_key_material_id_idx"
ON "material_chunks"("tenant_id", "scope_key", "material_id");
CREATE INDEX "material_chunks_search_vector_idx" ON "material_chunks" USING GIN ("search_vector");
CREATE INDEX "material_chunks_text_trgm_idx" ON "material_chunks" USING GIN ("text" gin_trgm_ops);

CREATE UNIQUE INDEX "material_embeddings_chunk_id_profile_version_key"
ON "material_embeddings"("chunk_id", "profile_version");
CREATE INDEX "material_embeddings_tenant_id_scope_key_profile_version_idx"
ON "material_embeddings"("tenant_id", "scope_key", "profile_version");
CREATE INDEX "material_embeddings_material_id_idx" ON "material_embeddings"("material_id");

CREATE UNIQUE INDEX "campaign_retrieval_evidence_campaign_id_rank_key"
ON "campaign_retrieval_evidence"("campaign_id", "rank");
CREATE UNIQUE INDEX "campaign_retrieval_evidence_campaign_id_chunk_id_key"
ON "campaign_retrieval_evidence"("campaign_id", "chunk_id");
CREATE INDEX "campaign_retrieval_evidence_tenant_id_enterprise_id_campaig_idx"
ON "campaign_retrieval_evidence"("tenant_id", "enterprise_id", "campaign_id");
CREATE INDEX "campaign_retrieval_evidence_material_id_chunk_id_idx"
ON "campaign_retrieval_evidence"("material_id", "chunk_id");

ALTER TABLE "material_artifacts"
ADD CONSTRAINT "material_artifacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "material_artifacts_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "material_artifacts_material_id_tenant_id_scope_key_fkey" FOREIGN KEY ("material_id", "tenant_id", "scope_key") REFERENCES "materials"("id", "tenant_id", "scope_key") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "material_ingestion_jobs"
ADD CONSTRAINT "material_ingestion_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "material_ingestion_jobs_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "material_ingestion_jobs_material_id_tenant_id_scope_key_fkey" FOREIGN KEY ("material_id", "tenant_id", "scope_key") REFERENCES "materials"("id", "tenant_id", "scope_key") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "material_ingestion_jobs_artifact_id_tenant_id_fkey" FOREIGN KEY ("artifact_id", "tenant_id") REFERENCES "material_artifacts"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "material_chunks"
ADD CONSTRAINT "material_chunks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "material_chunks_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "material_chunks_material_id_tenant_id_scope_key_fkey" FOREIGN KEY ("material_id", "tenant_id", "scope_key") REFERENCES "materials"("id", "tenant_id", "scope_key") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "material_embeddings"
ADD CONSTRAINT "material_embeddings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "material_embeddings_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "material_embeddings_material_id_tenant_id_scope_key_fkey" FOREIGN KEY ("material_id", "tenant_id", "scope_key") REFERENCES "materials"("id", "tenant_id", "scope_key") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "material_embeddings_chunk_id_material_id_tenant_id_scope_k_fkey" FOREIGN KEY ("chunk_id", "material_id", "tenant_id", "scope_key") REFERENCES "material_chunks"("id", "material_id", "tenant_id", "scope_key") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "material_embeddings_model_definition_id_fkey" FOREIGN KEY ("model_definition_id") REFERENCES "model_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "campaign_retrieval_evidence"
ADD CONSTRAINT "campaign_retrieval_evidence_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "campaign_retrieval_evidence_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "campaign_retrieval_evidence_campaign_id_enterprise_id_tena_fkey" FOREIGN KEY ("campaign_id", "enterprise_id", "tenant_id") REFERENCES "campaigns"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "campaign_retrieval_evidence_material_id_tenant_id_material_fkey" FOREIGN KEY ("material_id", "tenant_id", "material_scope_key") REFERENCES "materials"("id", "tenant_id", "scope_key") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "campaign_retrieval_evidence_chunk_id_material_id_tenant_id_fkey" FOREIGN KEY ("chunk_id", "material_id", "tenant_id", "material_scope_key") REFERENCES "material_chunks"("id", "material_id", "tenant_id", "scope_key") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "runtime_policies"
ADD CONSTRAINT "runtime_policies_embedding_model_id_fkey" FOREIGN KEY ("embedding_model_id") REFERENCES "model_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "material_chunks" (
  "id", "tenant_id", "enterprise_id", "scope_key", "material_id", "ordinal", "text",
  "text_checksum", "character_count", "token_count", "structured_facts", "metadata", "created_at"
)
SELECT
  encode(digest("id" || ':legacy:0', 'sha256'), 'hex'),
  "tenant_id", "enterprise_id", "scope_key", "id", 0, "content",
  encode(digest("content", 'sha256'), 'hex'), length("content"),
  GREATEST(1, CEIL(length("content") / 4.0)::INTEGER), "structured_facts",
  jsonb_build_object('source', 'legacy-text-v1'), "created_at"
FROM "materials"
WHERE "ingestion_status" = 'READY' AND length(btrim("content")) > 0;
