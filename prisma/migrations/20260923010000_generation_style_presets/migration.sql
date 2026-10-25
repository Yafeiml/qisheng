CREATE TABLE "generation_style_configurations" (
  "id" TEXT NOT NULL DEFAULT 'platform',
  "version" INTEGER NOT NULL DEFAULT 1,
  "configuration" JSONB NOT NULL,
  "updated_by" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "generation_style_configurations_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "prompt_templates" ADD COLUMN "content_direction_preset_id" VARCHAR(64);
ALTER TABLE "campaign_templates" ADD COLUMN "content_direction_preset_id" VARCHAR(64), ADD COLUMN "image_style_preset_id" VARCHAR(64);
ALTER TABLE "campaigns" ADD COLUMN "content_direction_preset_id" VARCHAR(64), ADD COLUMN "image_style_preset_id" VARCHAR(64), ADD COLUMN "generation_style_snapshot" JSONB;
