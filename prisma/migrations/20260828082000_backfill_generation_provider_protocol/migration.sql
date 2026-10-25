UPDATE "model_providers"
SET "protocol" = 'SYNTHETIC'
WHERE "synthetic" = TRUE;

UPDATE "generation_runs"
SET
  "text_provider" = CASE WHEN "text_provider" = '' THEN "provider" ELSE "text_provider" END,
  "image_provider" = CASE WHEN "image_provider" = '' THEN "provider" ELSE "image_provider" END;
