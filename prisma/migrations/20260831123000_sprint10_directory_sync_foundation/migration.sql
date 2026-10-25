CREATE TYPE "directory_provider" AS ENUM ('WECOM', 'FEISHU', 'DINGTALK', 'SIMULATED');
CREATE TYPE "directory_connection_scope_type" AS ENUM ('TENANT', 'ENTERPRISE');
CREATE TYPE "directory_management_mode" AS ENUM ('CENTRALIZED', 'ENTERPRISE_MANAGED');
CREATE TYPE "directory_connection_status" AS ENUM ('DRAFT', 'ACTIVE', 'ERROR', 'DISABLED');
CREATE TYPE "directory_sync_mode" AS ENUM ('MANUAL', 'SCHEDULED', 'EVENT');
CREATE TYPE "directory_mapping_status" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "directory_employment_status" AS ENUM ('ACTIVE', 'INACTIVE', 'LEFT');
CREATE TYPE "directory_member_link_status" AS ENUM ('ACTIVE', 'MISSING', 'DISABLED');
CREATE TYPE "directory_sync_run_status" AS ENUM ('FETCHING', 'PREVIEW_READY', 'APPLIED', 'FAILED');
CREATE TYPE "directory_sync_trigger" AS ENUM ('MANUAL', 'SCHEDULED', 'EVENT');
CREATE TYPE "directory_sync_change_action" AS ENUM ('CREATE', 'UPDATE', 'DEPARTURE', 'CONFLICT');
CREATE TYPE "directory_sync_change_status" AS ENUM ('PENDING', 'APPLIED', 'SKIPPED', 'REJECTED');
CREATE TYPE "membership_participation_status" AS ENUM ('PENDING_REVIEW', 'PARTICIPATING', 'PAUSED', 'EXEMPT');
CREATE TYPE "participation_control_owner" AS ENUM ('TENANT', 'ENTERPRISE');

CREATE TABLE "enterprise_personnel_policies" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "allow_enterprise_participation_management" BOOLEAN NOT NULL DEFAULT true,
    "allow_enterprise_seat_management" BOOLEAN NOT NULL DEFAULT false,
    "default_participation_status" "membership_participation_status" NOT NULL DEFAULT 'PENDING_REVIEW',
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "enterprise_personnel_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "membership_participations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "status" "membership_participation_status" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reason_code" VARCHAR(64),
    "reason" VARCHAR(500),
    "effective_from" TIMESTAMP(3),
    "effective_until" TIMESTAMP(3),
    "control_owner" "participation_control_owner" NOT NULL DEFAULT 'ENTERPRISE',
    "locked_by_tenant" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "membership_participations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "membership_participations_effective_window_check"
      CHECK ("effective_until" IS NULL OR "effective_from" IS NULL OR "effective_until" > "effective_from")
);

CREATE TABLE "directory_connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT,
    "name" VARCHAR(120) NOT NULL,
    "provider" "directory_provider" NOT NULL,
    "scope_type" "directory_connection_scope_type" NOT NULL,
    "management_mode" "directory_management_mode" NOT NULL,
    "external_organization_id" VARCHAR(160) NOT NULL,
    "credential_ciphertext" BYTEA NOT NULL,
    "credential_initialization_vector" BYTEA NOT NULL,
    "credential_authentication_tag" BYTEA NOT NULL,
    "credential_key_version" VARCHAR(40) NOT NULL,
    "credential_last_four" VARCHAR(4) NOT NULL,
    "status" "directory_connection_status" NOT NULL DEFAULT 'DRAFT',
    "sync_mode" "directory_sync_mode" NOT NULL DEFAULT 'MANUAL',
    "last_sync_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "last_error_code" VARCHAR(120),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "directory_connections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "directory_connections_scope_check" CHECK (
      ("scope_type" = 'TENANT' AND "enterprise_id" IS NULL AND "management_mode" = 'CENTRALIZED') OR
      ("scope_type" = 'ENTERPRISE' AND "enterprise_id" IS NOT NULL AND "management_mode" = 'ENTERPRISE_MANAGED')
    )
);

CREATE TABLE "directory_enterprise_mappings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "external_root_department_id" VARCHAR(160) NOT NULL,
    "external_root_path" VARCHAR(500),
    "include_children" BOOLEAN NOT NULL DEFAULT true,
    "status" "directory_mapping_status" NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "directory_enterprise_mappings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "directory_department_links" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "external_department_id" VARCHAR(160) NOT NULL,
    "external_parent_department_id" VARCHAR(160),
    "external_path" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "directory_department_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "directory_member_links" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "external_user_id" VARCHAR(160) NOT NULL,
    "employment_status" "directory_employment_status" NOT NULL DEFAULT 'ACTIVE',
    "source_snapshot_hash" CHAR(64) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "missing_full_sync_count" INTEGER NOT NULL DEFAULT 0,
    "status" "directory_member_link_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "directory_member_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "directory_member_links_missing_count_check" CHECK ("missing_full_sync_count" >= 0)
);

CREATE TABLE "directory_sync_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT,
    "connection_id" TEXT NOT NULL,
    "status" "directory_sync_run_status" NOT NULL DEFAULT 'FETCHING',
    "trigger" "directory_sync_trigger" NOT NULL DEFAULT 'MANUAL',
    "initiated_by" TEXT NOT NULL,
    "fetched_count" INTEGER NOT NULL DEFAULT 0,
    "create_count" INTEGER NOT NULL DEFAULT 0,
    "update_count" INTEGER NOT NULL DEFAULT 0,
    "departure_count" INTEGER NOT NULL DEFAULT 0,
    "conflict_count" INTEGER NOT NULL DEFAULT 0,
    "applied_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(120),
    "error_message" VARCHAR(500),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "directory_sync_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "directory_sync_runs_counts_check" CHECK (
      "fetched_count" >= 0 AND "create_count" >= 0 AND "update_count" >= 0 AND
      "departure_count" >= 0 AND "conflict_count" >= 0 AND "applied_count" >= 0
    )
);

CREATE TABLE "directory_sync_changes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "external_user_id" VARCHAR(160) NOT NULL,
    "membership_id" TEXT,
    "external_department_id" VARCHAR(160),
    "action" "directory_sync_change_action" NOT NULL,
    "status" "directory_sync_change_status" NOT NULL DEFAULT 'PENDING',
    "conflict_code" VARCHAR(120),
    "message" VARCHAR(500),
    "before_snapshot" JSONB,
    "after_snapshot" JSONB NOT NULL,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "directory_sync_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "enterprise_personnel_policies_enterprise_id_key" ON "enterprise_personnel_policies"("enterprise_id");
CREATE UNIQUE INDEX "enterprise_personnel_policies_enterprise_id_tenant_id_key" ON "enterprise_personnel_policies"("enterprise_id", "tenant_id");
CREATE INDEX "enterprise_personnel_policies_tenant_id_enterprise_id_idx" ON "enterprise_personnel_policies"("tenant_id", "enterprise_id");
CREATE UNIQUE INDEX "membership_participations_membership_id_key" ON "membership_participations"("membership_id");
CREATE UNIQUE INDEX "membership_participations_membership_id_enterprise_id_tenan_key" ON "membership_participations"("membership_id", "enterprise_id", "tenant_id");
CREATE INDEX "membership_participations_tenant_id_enterprise_id_status_idx" ON "membership_participations"("tenant_id", "enterprise_id", "status");
CREATE INDEX "membership_participations_status_effective_until_idx" ON "membership_participations"("status", "effective_until");
CREATE UNIQUE INDEX "directory_connections_id_tenant_id_key" ON "directory_connections"("id", "tenant_id");
CREATE INDEX "directory_connections_tenant_id_scope_type_status_idx" ON "directory_connections"("tenant_id", "scope_type", "status");
CREATE INDEX "directory_connections_enterprise_id_status_idx" ON "directory_connections"("enterprise_id", "status");
CREATE UNIQUE INDEX "directory_enterprise_mappings_connection_id_external_root_d_key" ON "directory_enterprise_mappings"("connection_id", "external_root_department_id", "enterprise_id");
CREATE UNIQUE INDEX "directory_enterprise_mappings_active_enterprise_source_key" ON "directory_enterprise_mappings"("enterprise_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "directory_enterprise_mappings_tenant_id_enterprise_id_statu_idx" ON "directory_enterprise_mappings"("tenant_id", "enterprise_id", "status");
CREATE UNIQUE INDEX "directory_department_links_connection_id_external_departmen_key" ON "directory_department_links"("connection_id", "external_department_id", "enterprise_id");
CREATE INDEX "directory_department_links_tenant_id_enterprise_id_departme_idx" ON "directory_department_links"("tenant_id", "enterprise_id", "department_id");
CREATE UNIQUE INDEX "directory_member_links_connection_id_external_user_id_enter_key" ON "directory_member_links"("connection_id", "external_user_id", "enterprise_id");
CREATE UNIQUE INDEX "directory_member_links_connection_id_membership_id_key" ON "directory_member_links"("connection_id", "membership_id");
CREATE INDEX "directory_member_links_tenant_id_enterprise_id_status_idx" ON "directory_member_links"("tenant_id", "enterprise_id", "status");
CREATE INDEX "directory_member_links_membership_id_idx" ON "directory_member_links"("membership_id");
CREATE INDEX "directory_sync_runs_tenant_id_connection_id_created_at_idx" ON "directory_sync_runs"("tenant_id", "connection_id", "created_at");
CREATE INDEX "directory_sync_runs_enterprise_id_created_at_idx" ON "directory_sync_runs"("enterprise_id", "created_at");
CREATE UNIQUE INDEX "directory_sync_changes_run_id_external_user_id_enterprise_i_key" ON "directory_sync_changes"("run_id", "external_user_id", "enterprise_id");
CREATE INDEX "directory_sync_changes_tenant_id_enterprise_id_status_idx" ON "directory_sync_changes"("tenant_id", "enterprise_id", "status");
CREATE INDEX "directory_sync_changes_run_id_action_status_idx" ON "directory_sync_changes"("run_id", "action", "status");

ALTER TABLE "enterprise_personnel_policies" ADD CONSTRAINT "enterprise_personnel_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enterprise_personnel_policies" ADD CONSTRAINT "enterprise_personnel_policies_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_participations" ADD CONSTRAINT "membership_participations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_participations" ADD CONSTRAINT "membership_participations_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_participations" ADD CONSTRAINT "membership_participations_membership_id_enterprise_id_tena_fkey" FOREIGN KEY ("membership_id", "enterprise_id", "tenant_id") REFERENCES "enterprise_memberships"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_connections" ADD CONSTRAINT "directory_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_connections" ADD CONSTRAINT "directory_connections_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_enterprise_mappings" ADD CONSTRAINT "directory_enterprise_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_enterprise_mappings" ADD CONSTRAINT "directory_enterprise_mappings_connection_id_tenant_id_fkey" FOREIGN KEY ("connection_id", "tenant_id") REFERENCES "directory_connections"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_enterprise_mappings" ADD CONSTRAINT "directory_enterprise_mappings_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_department_links" ADD CONSTRAINT "directory_department_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_department_links" ADD CONSTRAINT "directory_department_links_connection_id_tenant_id_fkey" FOREIGN KEY ("connection_id", "tenant_id") REFERENCES "directory_connections"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_department_links" ADD CONSTRAINT "directory_department_links_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_department_links" ADD CONSTRAINT "directory_department_links_department_id_enterprise_id_fkey" FOREIGN KEY ("department_id", "enterprise_id") REFERENCES "departments"("id", "enterprise_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_member_links" ADD CONSTRAINT "directory_member_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_member_links" ADD CONSTRAINT "directory_member_links_connection_id_tenant_id_fkey" FOREIGN KEY ("connection_id", "tenant_id") REFERENCES "directory_connections"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_member_links" ADD CONSTRAINT "directory_member_links_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_member_links" ADD CONSTRAINT "directory_member_links_membership_id_enterprise_id_tenant__fkey" FOREIGN KEY ("membership_id", "enterprise_id", "tenant_id") REFERENCES "enterprise_memberships"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_sync_runs" ADD CONSTRAINT "directory_sync_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_sync_runs" ADD CONSTRAINT "directory_sync_runs_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_sync_runs" ADD CONSTRAINT "directory_sync_runs_connection_id_tenant_id_fkey" FOREIGN KEY ("connection_id", "tenant_id") REFERENCES "directory_connections"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_sync_changes" ADD CONSTRAINT "directory_sync_changes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_sync_changes" ADD CONSTRAINT "directory_sync_changes_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "directory_sync_changes" ADD CONSTRAINT "directory_sync_changes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "directory_sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
