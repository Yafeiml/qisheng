CREATE TYPE "material_usability_status" AS ENUM ('PENDING', 'USABLE', 'NEEDS_INPUT');

-- Existing, manually curated materials retain their current eligibility.
-- New intake explicitly starts PENDING until understanding and indexing succeed.
ALTER TABLE "materials"
  ADD COLUMN "usability_status" "material_usability_status" NOT NULL DEFAULT 'USABLE',
  ADD COLUMN "source_text" TEXT,
  ADD COLUMN "supplement" TEXT,
  ADD COLUMN "analysis" JSONB;

ALTER TABLE "runtime_policies" ADD COLUMN "material_analysis_model_id" TEXT;
ALTER TABLE "runtime_policies" ADD CONSTRAINT "runtime_policies_material_analysis_model_id_fkey"
  FOREIGN KEY ("material_analysis_model_id") REFERENCES "model_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
