CREATE TYPE "generation_delivery_mode" AS ENUM ('DEVELOPMENT', 'PRODUCTION');

CREATE TYPE "model_route_qualification_status" AS ENUM ('PASSED', 'FAILED');

CREATE TABLE "runtime_policies" (
    "id" VARCHAR(40) NOT NULL,
    "provider_health_max_age_seconds" INTEGER NOT NULL DEFAULT 900,
    "route_qualification_max_age_seconds" INTEGER NOT NULL DEFAULT 86400,
    "minimum_generation_workers" INTEGER NOT NULL DEFAULT 1,
    "max_queue_backlog" INTEGER NOT NULL DEFAULT 10000,
    "max_active_generation_jobs" INTEGER NOT NULL DEFAULT 1000,
    "max_provider_concurrent_invocations" INTEGER NOT NULL DEFAULT 10,
    "cost_warning_threshold" DECIMAL(18,6) NOT NULL DEFAULT 100,
    "cost_currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "updated_by" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runtime_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "runtime_policies_health_age_check" CHECK ("provider_health_max_age_seconds" BETWEEN 30 AND 86400),
    CONSTRAINT "runtime_policies_qualification_age_check" CHECK ("route_qualification_max_age_seconds" BETWEEN 60 AND 604800),
    CONSTRAINT "runtime_policies_min_workers_check" CHECK ("minimum_generation_workers" BETWEEN 1 AND 1000),
    CONSTRAINT "runtime_policies_queue_backlog_check" CHECK ("max_queue_backlog" BETWEEN 1 AND 1000000),
    CONSTRAINT "runtime_policies_active_jobs_check" CHECK ("max_active_generation_jobs" BETWEEN 1 AND 1000000),
    CONSTRAINT "runtime_policies_provider_concurrency_check" CHECK ("max_provider_concurrent_invocations" BETWEEN 1 AND 10000),
    CONSTRAINT "runtime_policies_cost_warning_check" CHECK ("cost_warning_threshold" >= 0)
);

INSERT INTO "runtime_policies" (
    "id",
    "updated_by"
) VALUES (
    'platform',
    'system:migration'
);

CREATE TABLE "model_route_qualifications" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "status" "model_route_qualification_status" NOT NULL,
    "delivery_mode" "generation_delivery_mode" NOT NULL,
    "configuration_fingerprint" VARCHAR(64) NOT NULL,
    "text_provider_id" TEXT NOT NULL,
    "text_model_id" TEXT NOT NULL,
    "image_provider_id" TEXT NOT NULL,
    "image_model_id" TEXT NOT NULL,
    "text_latency_ms" INTEGER,
    "image_latency_ms" INTEGER,
    "estimated_cost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "storage_verified" BOOLEAN NOT NULL DEFAULT false,
    "diagnostics" JSONB,
    "error_code" VARCHAR(120),
    "error_message" VARCHAR(500),
    "checked_by" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_route_qualifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "model_route_qualifications_cost_check" CHECK ("estimated_cost" >= 0),
    CONSTRAINT "model_route_qualifications_expiry_check" CHECK ("expires_at" > "checked_at")
);

CREATE TABLE "campaign_preflight_snapshots" (
    "campaign_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "runtime_policy_id" VARCHAR(40) NOT NULL,
    "route_qualification_id" TEXT,
    "delivery_mode" "generation_delivery_mode" NOT NULL,
    "configuration_fingerprint" VARCHAR(64) NOT NULL,
    "checks" JSONB NOT NULL,
    "queue_metrics" JSONB NOT NULL,
    "estimated_cost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_preflight_snapshots_pkey" PRIMARY KEY ("campaign_id"),
    CONSTRAINT "campaign_preflight_snapshots_cost_check" CHECK ("estimated_cost" >= 0)
);

CREATE INDEX "model_route_qualifications_route_id_status_checked_at_idx"
ON "model_route_qualifications"("route_id", "status", "checked_at");

CREATE INDEX "model_route_qualifications_configuration_fingerprint_status_expires_at_idx"
ON "model_route_qualifications"("configuration_fingerprint", "status", "expires_at");

CREATE INDEX "campaign_preflight_snapshots_tenant_id_enterprise_id_created_at_idx"
ON "campaign_preflight_snapshots"("tenant_id", "enterprise_id", "created_at");

CREATE INDEX "campaign_preflight_snapshots_route_qualification_id_idx"
ON "campaign_preflight_snapshots"("route_qualification_id");

CREATE UNIQUE INDEX "campaign_preflight_snapshots_campaign_id_enterprise_id_tenant_id_key"
ON "campaign_preflight_snapshots"("campaign_id", "enterprise_id", "tenant_id");

ALTER TABLE "model_route_qualifications"
ADD CONSTRAINT "model_route_qualifications_route_id_fkey"
FOREIGN KEY ("route_id") REFERENCES "model_routes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "campaign_preflight_snapshots"
ADD CONSTRAINT "campaign_preflight_snapshots_campaign_id_enterprise_id_tenant_id_fkey"
FOREIGN KEY ("campaign_id", "enterprise_id", "tenant_id")
REFERENCES "campaigns"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "campaign_preflight_snapshots"
ADD CONSTRAINT "campaign_preflight_snapshots_runtime_policy_id_fkey"
FOREIGN KEY ("runtime_policy_id") REFERENCES "runtime_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "campaign_preflight_snapshots"
ADD CONSTRAINT "campaign_preflight_snapshots_route_qualification_id_fkey"
FOREIGN KEY ("route_qualification_id") REFERENCES "model_route_qualifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
