-- CreateEnum
CREATE TYPE "tenant_customer_type" AS ENUM ('SINGLE_ENTERPRISE', 'GROUP');

-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "enterprise_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "global_user_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "membership_status" AS ENUM ('PENDING_BIND', 'ACTIVE', 'DISABLED', 'LEFT');

-- CreateEnum
CREATE TYPE "seat_status" AS ENUM ('NOT_ENABLED', 'ENABLED');

-- CreateEnum
CREATE TYPE "access_scope_type" AS ENUM ('PLATFORM', 'TENANT', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "role_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('USER', 'SYSTEM', 'INTEGRATION');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "customer_type" "tenant_customer_type" NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'ACTIVE',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprises" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "brand_name" VARCHAR(160),
    "industry" VARCHAR(100),
    "city" VARCHAR(100),
    "status" "enterprise_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_users" (
    "id" TEXT NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "phone_verified_at" TIMESTAMP(3),
    "wechat_open_id" VARCHAR(128),
    "wechat_union_id" VARCHAR(128),
    "status" "global_user_status" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "global_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_memberships" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enterprise_id" TEXT NOT NULL,
    "global_user_id" TEXT,
    "name" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "employee_no" VARCHAR(64),
    "department_id" TEXT,
    "status" "membership_status" NOT NULL DEFAULT 'PENDING_BIND',
    "seat_status" "seat_status" NOT NULL DEFAULT 'NOT_ENABLED',
    "bound_at" TIMESTAMP(3),
    "seat_enabled_at" TIMESTAMP(3),
    "seat_disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "scope_type" "access_scope_type" NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "status" "role_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(120) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "role_bindings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "scope_type" "access_scope_type" NOT NULL,
    "scope_id" VARCHAR(64) NOT NULL,
    "tenant_id" TEXT,
    "enterprise_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "enterprise_id" TEXT,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_user_id" TEXT,
    "action" VARCHAR(120) NOT NULL,
    "resource_type" VARCHAR(120) NOT NULL,
    "resource_id" VARCHAR(64),
    "reason" VARCHAR(500),
    "request_id" VARCHAR(100),
    "state_before" JSONB,
    "state_after" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "enterprises_tenant_id_status_idx" ON "enterprises"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "enterprises_tenant_id_code_key" ON "enterprises"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "enterprises_id_tenant_id_key" ON "enterprises"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "global_users_phone_key" ON "global_users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "global_users_wechat_open_id_key" ON "global_users"("wechat_open_id");

-- CreateIndex
CREATE UNIQUE INDEX "global_users_wechat_union_id_key" ON "global_users"("wechat_union_id");

-- CreateIndex
CREATE INDEX "global_users_status_idx" ON "global_users"("status");

-- CreateIndex
CREATE INDEX "enterprise_memberships_tenant_id_status_idx" ON "enterprise_memberships"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "enterprise_memberships_enterprise_id_status_seat_status_idx" ON "enterprise_memberships"("enterprise_id", "status", "seat_status");

-- CreateIndex
CREATE INDEX "enterprise_memberships_global_user_id_idx" ON "enterprise_memberships"("global_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_memberships_enterprise_id_phone_key" ON "enterprise_memberships"("enterprise_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_memberships_enterprise_id_global_user_id_key" ON "enterprise_memberships"("enterprise_id", "global_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE INDEX "roles_scope_type_status_idx" ON "roles"("scope_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "roles_id_scope_type_key" ON "roles"("id", "scope_type");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE INDEX "role_bindings_tenant_id_user_id_idx" ON "role_bindings"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "role_bindings_enterprise_id_user_id_idx" ON "role_bindings"("enterprise_id", "user_id");

-- CreateIndex
CREATE INDEX "role_bindings_scope_type_scope_id_idx" ON "role_bindings"("scope_type", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_bindings_user_id_role_id_scope_type_scope_id_key" ON "role_bindings"("user_id", "role_id", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_enterprise_id_created_at_idx" ON "audit_logs"("enterprise_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- AddForeignKey
ALTER TABLE "enterprises" ADD CONSTRAINT "enterprises_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_memberships" ADD CONSTRAINT "enterprise_memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_memberships" ADD CONSTRAINT "enterprise_memberships_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_memberships" ADD CONSTRAINT "enterprise_memberships_global_user_id_fkey" FOREIGN KEY ("global_user_id") REFERENCES "global_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "global_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_role_id_scope_type_fkey" FOREIGN KEY ("role_id", "scope_type") REFERENCES "roles"("id", "scope_type") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_enterprise_id_tenant_id_fkey" FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "global_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Scope shape is enforced in PostgreSQL as well as in application code. This prevents
-- a malformed binding from escaping tenant filters even if it is inserted outside Prisma.
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_scope_shape_check" CHECK (
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

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_scope_shape_check" CHECK (
    "enterprise_id" IS NULL OR "tenant_id" IS NOT NULL
);
