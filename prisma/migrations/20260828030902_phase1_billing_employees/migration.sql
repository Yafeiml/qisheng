/*
  Warnings:

  - A unique constraint covering the columns `[id,enterprise_id,tenant_id]` on the table `enterprise_memberships` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "plan_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "billing_cycle" AS ENUM ('MONTHLY', 'YEARLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "quota_period_status" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "usage_ledger_type" AS ENUM ('RESERVE', 'CONSUME', 'RELEASE', 'ADJUST');

-- CreateEnum
CREATE TYPE "seat_change_type" AS ENUM ('ENABLE', 'DISABLE', 'REPLACE');

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "status" "plan_status" NOT NULL DEFAULT 'ACTIVE',
    "billing_cycle" "billing_cycle" NOT NULL DEFAULT 'MONTHLY',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_entitlements" (
    "plan_id" TEXT NOT NULL,
    "max_enterprises" INTEGER NOT NULL,
    "max_enterprise_membership_seats" INTEGER NOT NULL,
    "max_seat_replacements_per_cycle" INTEGER NOT NULL,
    "monthly_content_credits" INTEGER NOT NULL,
    "images_per_distribution" INTEGER NOT NULL DEFAULT 1,
    "group_shared_materials_enabled" BOOLEAN NOT NULL DEFAULT false,
    "geo_level" VARCHAR(32) NOT NULL DEFAULT 'BASIC',
    "metrics_integration_enabled" BOOLEAN NOT NULL DEFAULT false,
    "storage_quota_bytes" BIGINT NOT NULL DEFAULT 1073741824,
    "text_model_tier" VARCHAR(32) NOT NULL DEFAULT 'STANDARD',
    "image_model_tier" VARCHAR(32) NOT NULL DEFAULT 'STANDARD',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_entitlements_pkey" PRIMARY KEY ("plan_id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'PENDING',
    "custom_entitlements" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_periods" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "employee_seat_limit" INTEGER NOT NULL,
    "content_credit_limit" INTEGER NOT NULL,
    "content_credit_reserved" INTEGER NOT NULL DEFAULT 0,
    "content_credit_consumed" INTEGER NOT NULL DEFAULT 0,
    "employee_seat_replacement_count" INTEGER NOT NULL DEFAULT 0,
    "status" "quota_period_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quota_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_ledgers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "quota_period_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "distribution_task_id" TEXT,
    "type" "usage_ledger_type" NOT NULL,
    "amount" INTEGER NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_change_ledgers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "quota_period_id" TEXT NOT NULL,
    "enterprise_membership_id" TEXT NOT NULL,
    "type" "seat_change_type" NOT NULL,
    "replacement_count" INTEGER NOT NULL DEFAULT 0,
    "reason" VARCHAR(500) NOT NULL,
    "actor_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seat_change_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "departments_tenant_id_enterprise_id_status_idx" ON "departments"("tenant_id", "enterprise_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "departments_enterprise_id_code_key" ON "departments"("enterprise_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "departments_id_enterprise_id_key" ON "departments"("id", "enterprise_id");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE INDEX "plans_status_idx" ON "plans"("status");

-- CreateIndex
CREATE INDEX "subscriptions_tenant_id_status_idx" ON "subscriptions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_plan_id_status_idx" ON "subscriptions"("plan_id", "status");

-- CreateIndex
CREATE INDEX "quota_periods_tenant_id_status_period_start_period_end_idx" ON "quota_periods"("tenant_id", "status", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "quota_periods_subscription_id_period_start_key" ON "quota_periods"("subscription_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "quota_periods_id_tenant_id_key" ON "quota_periods"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "usage_ledgers_tenant_id_quota_period_id_created_at_idx" ON "usage_ledgers"("tenant_id", "quota_period_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_ledgers_campaign_id_idx" ON "usage_ledgers"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_ledgers_tenant_id_idempotency_key_key" ON "usage_ledgers"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "seat_change_ledgers_tenant_id_quota_period_id_created_at_idx" ON "seat_change_ledgers"("tenant_id", "quota_period_id", "created_at");

-- CreateIndex
CREATE INDEX "seat_change_ledgers_enterprise_id_enterprise_membership_id_idx" ON "seat_change_ledgers"("enterprise_id", "enterprise_membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_memberships_id_enterprise_id_tenant_id_key" ON "enterprise_memberships"("id", "enterprise_id", "tenant_id");

-- AddForeignKey
ALTER TABLE "enterprise_memberships" ADD CONSTRAINT "enterprise_memberships_department_id_enterprise_id_fkey" FOREIGN KEY ("department_id", "enterprise_id") REFERENCES "departments"("id", "enterprise_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota_periods" ADD CONSTRAINT "quota_periods_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota_periods" ADD CONSTRAINT "quota_periods_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledgers" ADD CONSTRAINT "usage_ledgers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledgers" ADD CONSTRAINT "usage_ledgers_quota_period_id_tenant_id_fkey" FOREIGN KEY ("quota_period_id", "tenant_id") REFERENCES "quota_periods"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_change_ledgers" ADD CONSTRAINT "seat_change_ledgers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_change_ledgers" ADD CONSTRAINT "seat_change_ledgers_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_change_ledgers" ADD CONSTRAINT "seat_change_ledgers_quota_period_id_tenant_id_fkey" FOREIGN KEY ("quota_period_id", "tenant_id") REFERENCES "quota_periods"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_change_ledgers" ADD CONSTRAINT "seat_change_ledgers_enterprise_membership_id_enterprise_id_fkey" FOREIGN KEY ("enterprise_membership_id", "enterprise_id", "tenant_id") REFERENCES "enterprise_memberships"("id", "enterprise_id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only one current commercial contract is active for a tenant at a time.
CREATE UNIQUE INDEX "subscriptions_one_active_per_tenant_idx"
ON "subscriptions"("tenant_id")
WHERE "status" = 'ACTIVE';

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_date_range_check"
CHECK ("ends_at" > "starts_at");

ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_positive_limits_check" CHECK (
    "max_enterprises" > 0
    AND "max_enterprise_membership_seats" > 0
    AND "max_seat_replacements_per_cycle" >= 0
    AND "monthly_content_credits" > 0
    AND "images_per_distribution" > 0
    AND "storage_quota_bytes" > 0
);

ALTER TABLE "quota_periods" ADD CONSTRAINT "quota_periods_date_range_check"
CHECK ("period_end" > "period_start");

ALTER TABLE "quota_periods" ADD CONSTRAINT "quota_periods_counters_check" CHECK (
    "employee_seat_limit" > 0
    AND "content_credit_limit" > 0
    AND "content_credit_reserved" >= 0
    AND "content_credit_consumed" >= 0
    AND "employee_seat_replacement_count" >= 0
    AND "content_credit_reserved" + "content_credit_consumed" <= "content_credit_limit"
);

ALTER TABLE "usage_ledgers" ADD CONSTRAINT "usage_ledgers_positive_amount_check"
CHECK ("amount" > 0);

ALTER TABLE "seat_change_ledgers" ADD CONSTRAINT "seat_change_ledgers_replacement_count_check"
CHECK ("replacement_count" >= 0);

ALTER TABLE "departments" ADD CONSTRAINT "departments_status_check"
CHECK ("status" IN ('ACTIVE', 'DISABLED'));

ALTER TABLE "enterprise_memberships" ADD CONSTRAINT "enterprise_memberships_seat_timestamp_check" CHECK (
    "seat_status" = 'NOT_ENABLED' OR "seat_enabled_at" IS NOT NULL
);
