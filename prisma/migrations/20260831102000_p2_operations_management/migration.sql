CREATE TYPE "campaign_planning_status" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "management_action_status" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');

CREATE TABLE "prompt_templates" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "content" TEXT NOT NULL,
  "content_direction" VARCHAR(120),
  "status" "campaign_planning_status" NOT NULL DEFAULT 'ACTIVE',
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "campaign_templates" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT NOT NULL,
  "prompt_template_id" TEXT,
  "name" VARCHAR(120) NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "prompt" TEXT NOT NULL,
  "content_direction" VARCHAR(120),
  "image_style" VARCHAR(120),
  "image_count" INTEGER NOT NULL DEFAULT 1,
  "reminder_offsets_hours" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "status" "campaign_planning_status" NOT NULL DEFAULT 'ACTIVE',
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "campaign_drafts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "step" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_drafts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "campaigns"
  ADD COLUMN "content_direction" VARCHAR(120),
  ADD COLUMN "image_style" VARCHAR(120),
  ADD COLUMN "reminder_offsets_hours" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "prompt_template_id" TEXT,
  ADD COLUMN "campaign_template_id" TEXT;

CREATE TABLE "management_actions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enterprise_id" TEXT NOT NULL,
  "campaign_id" TEXT,
  "title" VARCHAR(200) NOT NULL,
  "description" VARCHAR(1000),
  "assignee" VARCHAR(120),
  "status" "management_action_status" NOT NULL DEFAULT 'OPEN',
  "due_at" TIMESTAMP(3),
  "note" TEXT,
  "created_by" TEXT NOT NULL,
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "management_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prompt_templates_enterprise_name_key"
  ON "prompt_templates"("enterprise_id", "name");
CREATE UNIQUE INDEX "prompt_templates_scope_key"
  ON "prompt_templates"("id", "enterprise_id", "tenant_id");
CREATE INDEX "prompt_templates_scope_status_idx"
  ON "prompt_templates"("tenant_id", "enterprise_id", "status", "created_at");

CREATE UNIQUE INDEX "campaign_templates_enterprise_name_key"
  ON "campaign_templates"("enterprise_id", "name");
CREATE UNIQUE INDEX "campaign_templates_scope_key"
  ON "campaign_templates"("id", "enterprise_id", "tenant_id");
CREATE INDEX "campaign_templates_scope_status_idx"
  ON "campaign_templates"("tenant_id", "enterprise_id", "status", "created_at");
CREATE INDEX "campaign_templates_prompt_idx"
  ON "campaign_templates"("prompt_template_id");

CREATE UNIQUE INDEX "campaign_drafts_enterprise_creator_key"
  ON "campaign_drafts"("enterprise_id", "created_by");
CREATE INDEX "campaign_drafts_scope_updated_idx"
  ON "campaign_drafts"("tenant_id", "enterprise_id", "updated_at");

CREATE UNIQUE INDEX "management_actions_scope_key"
  ON "management_actions"("id", "enterprise_id", "tenant_id");
CREATE INDEX "management_actions_scope_status_due_idx"
  ON "management_actions"("tenant_id", "enterprise_id", "status", "due_at");
CREATE INDEX "management_actions_campaign_idx"
  ON "management_actions"("campaign_id");

CREATE INDEX "campaigns_direction_created_idx"
  ON "campaigns"("enterprise_id", "content_direction", "created_at");
CREATE INDEX "campaigns_image_style_created_idx"
  ON "campaigns"("enterprise_id", "image_style", "created_at");
CREATE INDEX "campaigns_prompt_template_idx" ON "campaigns"("prompt_template_id");
CREATE INDEX "campaigns_campaign_template_idx" ON "campaigns"("campaign_template_id");

ALTER TABLE "prompt_templates"
  ADD CONSTRAINT "prompt_templates_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prompt_templates"
  ADD CONSTRAINT "prompt_templates_enterprise_scope_fkey"
  FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "campaign_templates"
  ADD CONSTRAINT "campaign_templates_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaign_templates"
  ADD CONSTRAINT "campaign_templates_enterprise_scope_fkey"
  FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaign_templates"
  ADD CONSTRAINT "campaign_templates_prompt_scope_fkey"
  FOREIGN KEY ("prompt_template_id", "enterprise_id", "tenant_id")
  REFERENCES "prompt_templates"("id", "enterprise_id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "campaign_drafts"
  ADD CONSTRAINT "campaign_drafts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaign_drafts"
  ADD CONSTRAINT "campaign_drafts_enterprise_scope_fkey"
  FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_prompt_template_scope_fkey"
  FOREIGN KEY ("prompt_template_id", "enterprise_id", "tenant_id")
  REFERENCES "prompt_templates"("id", "enterprise_id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_campaign_template_scope_fkey"
  FOREIGN KEY ("campaign_template_id", "enterprise_id", "tenant_id")
  REFERENCES "campaign_templates"("id", "enterprise_id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "management_actions"
  ADD CONSTRAINT "management_actions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "management_actions"
  ADD CONSTRAINT "management_actions_enterprise_scope_fkey"
  FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "management_actions"
  ADD CONSTRAINT "management_actions_campaign_scope_fkey"
  FOREIGN KEY ("campaign_id", "enterprise_id", "tenant_id")
  REFERENCES "campaigns"("id", "enterprise_id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
