-- CreateEnum
CREATE TYPE "model_capability" AS ENUM ('TEXT', 'IMAGE', 'MULTIMODAL');

-- CreateEnum
CREATE TYPE "model_resource_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "base_url" VARCHAR(1000) NOT NULL,
    "credential_ref" VARCHAR(255) NOT NULL,
    "timeout_ms" INTEGER NOT NULL DEFAULT 60000,
    "status" "model_resource_status" NOT NULL DEFAULT 'ACTIVE',
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_definitions" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "display_name" VARCHAR(160) NOT NULL,
    "external_model_id" VARCHAR(200) NOT NULL,
    "capabilities" "model_capability"[] DEFAULT ARRAY[]::"model_capability"[],
    "status" "model_resource_status" NOT NULL DEFAULT 'ACTIVE',
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_routes" (
    "id" TEXT NOT NULL,
    "scope_type" "access_scope_type" NOT NULL,
    "scope_id" VARCHAR(64) NOT NULL,
    "tenant_id" TEXT,
    "enterprise_id" TEXT,
    "text_model_id" TEXT NOT NULL,
    "image_model_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_routes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_providers_code_key" ON "model_providers"("code");

-- CreateIndex
CREATE INDEX "model_providers_status_idx" ON "model_providers"("status");

-- CreateIndex
CREATE INDEX "model_definitions_status_idx" ON "model_definitions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "model_definitions_provider_id_code_key" ON "model_definitions"("provider_id", "code");

-- CreateIndex
CREATE INDEX "model_routes_tenant_id_scope_type_idx" ON "model_routes"("tenant_id", "scope_type");

-- CreateIndex
CREATE INDEX "model_routes_enterprise_id_scope_type_idx" ON "model_routes"("enterprise_id", "scope_type");

-- CreateIndex
CREATE UNIQUE INDEX "model_routes_scope_type_scope_id_key" ON "model_routes"("scope_type", "scope_id");

-- AddForeignKey
ALTER TABLE "model_definitions" ADD CONSTRAINT "model_definitions_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "model_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_text_model_id_fkey" FOREIGN KEY ("text_model_id") REFERENCES "model_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_image_model_id_fkey" FOREIGN KEY ("image_model_id") REFERENCES "model_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "model_providers"
  ADD CONSTRAINT "model_providers_configuration_check"
    CHECK (
      length(trim("code")) > 0
      AND length(trim("base_url")) > 0
      AND length(trim("credential_ref")) > 0
      AND "timeout_ms" > 0
    );

ALTER TABLE "model_definitions"
  ADD CONSTRAINT "model_definitions_capability_check"
    CHECK (cardinality("capabilities") > 0);

ALTER TABLE "model_routes"
  ADD CONSTRAINT "model_routes_scope_shape_check" CHECK (
    (
      "scope_type" = 'PLATFORM'
      AND "scope_id" = 'platform'
      AND "tenant_id" IS NULL
      AND "enterprise_id" IS NULL
    ) OR (
      "scope_type" = 'TENANT'
      AND "scope_id" = "tenant_id"
      AND "tenant_id" IS NOT NULL
      AND "enterprise_id" IS NULL
    ) OR (
      "scope_type" = 'ENTERPRISE'
      AND "scope_id" = "enterprise_id"
      AND "tenant_id" IS NOT NULL
      AND "enterprise_id" IS NOT NULL
    )
  );
