-- Denormalize campaign identity onto generated images so database constraints can
-- protect per-campaign visual uniqueness under concurrent worker commits.
ALTER TABLE "generated_images"
ADD COLUMN "campaign_id" TEXT;

UPDATE "generated_images" AS image
SET "campaign_id" = content."campaign_id"
FROM "employee_contents" AS content
WHERE content."id" = image."employee_content_id"
  AND content."tenant_id" = image."tenant_id";

ALTER TABLE "generated_images"
ALTER COLUMN "campaign_id" SET NOT NULL;

-- Pre-migration development data may contain dHash collisions created before
-- the database constraint existed. Preserve the first hash and mark later
-- colliding legacy rows as requiring future re-evaluation.
WITH ranked_hashes AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "campaign_id", "perceptual_hash"
      ORDER BY "created_at", "id"
    ) AS duplicate_rank
  FROM "generated_images"
  WHERE "perceptual_hash" IS NOT NULL
)
UPDATE "generated_images" AS image
SET "perceptual_hash" = NULL
FROM ranked_hashes
WHERE image."id" = ranked_hashes."id"
  AND ranked_hashes.duplicate_rank > 1;

CREATE UNIQUE INDEX "generated_images_campaign_id_perceptual_hash_key"
ON "generated_images"("campaign_id", "perceptual_hash");

ALTER TABLE "generated_images"
ADD CONSTRAINT "generated_images_campaign_id_tenant_id_fkey"
FOREIGN KEY ("campaign_id", "tenant_id")
REFERENCES "campaigns"("id", "tenant_id")
ON DELETE RESTRICT ON UPDATE CASCADE;
