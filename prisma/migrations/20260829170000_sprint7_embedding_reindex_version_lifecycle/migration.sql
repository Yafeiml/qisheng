CREATE TYPE "material_ingestion_purpose" AS ENUM ('INGEST', 'REINDEX');

ALTER TABLE "material_ingestion_jobs"
ADD COLUMN "purpose" "material_ingestion_purpose" NOT NULL DEFAULT 'INGEST';

CREATE INDEX "material_ingestion_jobs_purpose_status_created_at_idx"
ON "material_ingestion_jobs"("purpose", "status", "created_at");

CREATE OR REPLACE FUNCTION "xhs_cosine_similarity"(
  left_vector DOUBLE PRECISION[],
  right_vector DOUBLE PRECISION[]
)
RETURNS DOUBLE PRECISION
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN cardinality(left_vector) = 0
      OR cardinality(left_vector) <> cardinality(right_vector)
      THEN NULL
    ELSE (
      SELECT CASE
        WHEN vector_terms.norm_product = 0 THEN 0
        ELSE vector_terms.dot_product / vector_terms.norm_product
      END
      FROM (
        SELECT
          SUM(left_value * right_value) AS dot_product,
          SQRT(SUM(left_value * left_value)) * SQRT(SUM(right_value * right_value)) AS norm_product
        FROM unnest(left_vector, right_vector) AS pairs(left_value, right_value)
      ) AS vector_terms
    )
  END;
$$;
