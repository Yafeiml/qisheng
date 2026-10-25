-- Back-office administrators and publishing employees are separate identity domains.
-- Existing administrator ids are preserved during the copy so active role bindings,
-- sessions, audit references and signed access tokens continue to work after deploy.
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100),
    "phone" VARCHAR(32) NOT NULL,
    "email" VARCHAR(254),
    "email_verified_at" TIMESTAMP(3),
    "avatar_url" VARCHAR(1000),
    "phone_verified_at" TIMESTAMP(3),
    "status" "global_user_status" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_users_phone_key" ON "admin_users"("phone");
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");
CREATE INDEX "admin_users_status_idx" ON "admin_users"("status");
CREATE INDEX "admin_users_name_idx" ON "admin_users"("name");

INSERT INTO "admin_users" (
    "id",
    "phone",
    "phone_verified_at",
    "status",
    "last_login_at",
    "created_at",
    "updated_at"
)
SELECT DISTINCT
    user_row."id",
    user_row."phone",
    user_row."phone_verified_at",
    user_row."status",
    user_row."last_login_at",
    user_row."created_at",
    user_row."updated_at"
FROM "global_users" AS user_row
WHERE EXISTS (
    SELECT 1 FROM "role_bindings" AS binding WHERE binding."user_id" = user_row."id"
)
OR EXISTS (
    SELECT 1 FROM "admin_sessions" AS session WHERE session."user_id" = user_row."id"
);

CREATE TABLE "admin_organization_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scope_type" "access_scope_type" NOT NULL,
    "scope_id" VARCHAR(64) NOT NULL,
    "tenant_id" TEXT,
    "enterprise_id" TEXT,
    "job_title" VARCHAR(100),
    "department" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_organization_profiles_pkey" PRIMARY KEY ("id")
);

INSERT INTO "admin_organization_profiles" (
    "id",
    "user_id",
    "scope_type",
    "scope_id",
    "tenant_id",
    "enterprise_id",
    "created_at",
    "updated_at"
)
SELECT
    CONCAT('migrated_', MD5(binding."user_id" || ':' || binding."scope_type"::TEXT || ':' || binding."scope_id")),
    binding."user_id",
    binding."scope_type",
    binding."scope_id",
    binding."tenant_id",
    binding."enterprise_id",
    MIN(binding."created_at"),
    CURRENT_TIMESTAMP
FROM "role_bindings" AS binding
GROUP BY
    binding."user_id",
    binding."scope_type",
    binding."scope_id",
    binding."tenant_id",
    binding."enterprise_id";

CREATE UNIQUE INDEX "admin_organization_profiles_user_id_scope_type_scope_id_key"
ON "admin_organization_profiles"("user_id", "scope_type", "scope_id");
CREATE INDEX "admin_organization_profiles_tenant_id_user_id_idx"
ON "admin_organization_profiles"("tenant_id", "user_id");
CREATE INDEX "admin_organization_profiles_enterprise_id_user_id_idx"
ON "admin_organization_profiles"("enterprise_id", "user_id");
CREATE INDEX "admin_organization_profiles_scope_type_scope_id_idx"
ON "admin_organization_profiles"("scope_type", "scope_id");

ALTER TABLE "role_bindings" DROP CONSTRAINT "role_bindings_user_id_fkey";
ALTER TABLE "admin_sessions" DROP CONSTRAINT "admin_sessions_user_id_fkey";
ALTER TABLE "idempotency_records" DROP CONSTRAINT "idempotency_records_user_id_fkey";
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_user_id_fkey";

ALTER TABLE "role_bindings"
ADD CONSTRAINT "role_bindings_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "admin_users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "admin_sessions"
ADD CONSTRAINT "admin_sessions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "admin_users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "admin_organization_profiles"
ADD CONSTRAINT "admin_organization_profiles_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "admin_users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "admin_organization_profiles"
ADD CONSTRAINT "admin_organization_profiles_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "admin_organization_profiles"
ADD CONSTRAINT "admin_organization_profiles_enterprise_id_tenant_id_fkey"
FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "admin_organization_profiles"
ADD CONSTRAINT "admin_organization_profiles_scope_shape_check" CHECK (
    (
        "scope_type" = 'PLATFORM'
        AND "scope_id" = 'platform'
        AND "tenant_id" IS NULL
        AND "enterprise_id" IS NULL
    )
    OR (
        "scope_type" = 'TENANT'
        AND "scope_id" = "tenant_id"
        AND "tenant_id" IS NOT NULL
        AND "enterprise_id" IS NULL
    )
    OR (
        "scope_type" = 'ENTERPRISE'
        AND "scope_id" = "enterprise_id"
        AND "tenant_id" IS NOT NULL
        AND "enterprise_id" IS NOT NULL
    )
);
