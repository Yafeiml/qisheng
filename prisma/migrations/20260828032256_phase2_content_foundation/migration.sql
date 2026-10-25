-- CreateEnum
CREATE TYPE "material_type" AS ENUM ('TEXT', 'DOCUMENT', 'IMAGE_REFERENCE', 'LINK');

-- CreateEnum
CREATE TYPE "material_authorization_status" AS ENUM ('PENDING', 'AUTHORIZED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "material_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "sensitive_severity" AS ENUM ('BLOCK', 'WARNING', 'NOTICE');

-- CreateEnum
CREATE TYPE "geo_entity_type" AS ENUM ('BRAND', 'ENTERPRISE', 'DOCTOR', 'DEVICE', 'TECHNOLOGY', 'SERVICE', 'LOCATION');

-- CreateTable
CREATE TABLE "materials" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT,
    "type" "material_type" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "content" TEXT NOT NULL,
    "structured_facts" JSONB,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_url" VARCHAR(1000),
    "authorization_status" "material_authorization_status" NOT NULL DEFAULT 'PENDING',
    "valid_from" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "status" "material_status" NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sensitive_rules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT,
    "term" VARCHAR(200) NOT NULL,
    "severity" "sensitive_severity" NOT NULL,
    "risk_type" VARCHAR(80) NOT NULL,
    "replacement_suggestion" VARCHAR(500),
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "status" "material_status" NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sensitive_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geo_entities" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT,
    "type" "geo_entity_type" NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "facts" JSONB,
    "status" "material_status" NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "geo_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geo_topics" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT,
    "entity_id" TEXT NOT NULL,
    "question" VARCHAR(500) NOT NULL,
    "intent" VARCHAR(100) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "material_status" NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "geo_topics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "materials_tenant_id_status_authorization_status_idx" ON "materials"("tenant_id", "status", "authorization_status");

-- CreateIndex
CREATE INDEX "materials_enterprise_id_status_authorization_status_idx" ON "materials"("enterprise_id", "status", "authorization_status");

-- CreateIndex
CREATE INDEX "sensitive_rules_tenant_id_status_severity_idx" ON "sensitive_rules"("tenant_id", "status", "severity");

-- CreateIndex
CREATE INDEX "sensitive_rules_enterprise_id_status_severity_idx" ON "sensitive_rules"("enterprise_id", "status", "severity");

-- CreateIndex
CREATE INDEX "geo_entities_tenant_id_status_type_idx" ON "geo_entities"("tenant_id", "status", "type");

-- CreateIndex
CREATE INDEX "geo_entities_enterprise_id_status_type_idx" ON "geo_entities"("enterprise_id", "status", "type");

-- CreateIndex
CREATE UNIQUE INDEX "geo_entities_id_tenant_id_key" ON "geo_entities"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "geo_topics_tenant_id_status_priority_idx" ON "geo_topics"("tenant_id", "status", "priority");

-- CreateIndex
CREATE INDEX "geo_topics_enterprise_id_status_priority_idx" ON "geo_topics"("enterprise_id", "status", "priority");

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sensitive_rules" ADD CONSTRAINT "sensitive_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sensitive_rules" ADD CONSTRAINT "sensitive_rules_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geo_entities" ADD CONSTRAINT "geo_entities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geo_entities" ADD CONSTRAINT "geo_entities_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geo_topics" ADD CONSTRAINT "geo_topics_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geo_topics" ADD CONSTRAINT "geo_topics_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geo_topics" ADD CONSTRAINT "geo_topics_entity_id_tenant_id_fkey" FOREIGN KEY ("entity_id", "tenant_id") REFERENCES "geo_entities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "materials" ADD CONSTRAINT "materials_valid_range_check" CHECK (
    "expires_at" IS NULL OR "valid_from" IS NULL OR "expires_at" > "valid_from"
);

ALTER TABLE "sensitive_rules" ADD CONSTRAINT "sensitive_rules_effective_range_check" CHECK (
    "effective_to" IS NULL OR "effective_from" IS NULL OR "effective_to" > "effective_from"
);

ALTER TABLE "geo_topics" ADD CONSTRAINT "geo_topics_priority_check" CHECK ("priority" >= 0);

CREATE UNIQUE INDEX "sensitive_rules_tenant_public_term_key"
ON "sensitive_rules"("tenant_id", "term")
WHERE "enterprise_id" IS NULL;

CREATE UNIQUE INDEX "sensitive_rules_enterprise_term_key"
ON "sensitive_rules"("enterprise_id", "term")
WHERE "enterprise_id" IS NOT NULL;

CREATE UNIQUE INDEX "geo_entities_tenant_public_name_type_key"
ON "geo_entities"("tenant_id", "type", "name")
WHERE "enterprise_id" IS NULL;

CREATE UNIQUE INDEX "geo_entities_enterprise_name_type_key"
ON "geo_entities"("enterprise_id", "type", "name")
WHERE "enterprise_id" IS NOT NULL;
