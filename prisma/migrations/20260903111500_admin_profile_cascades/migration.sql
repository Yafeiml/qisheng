-- Organization-scoped administrator profile data is owned by both the account and
-- its organization. It must not block deliberate account or tenant removal after
-- role bindings and business records have been handled.
ALTER TABLE "admin_organization_profiles"
DROP CONSTRAINT "admin_organization_profiles_user_id_fkey";

ALTER TABLE "admin_organization_profiles"
DROP CONSTRAINT "admin_organization_profiles_tenant_id_fkey";

ALTER TABLE "admin_organization_profiles"
DROP CONSTRAINT "admin_organization_profiles_enterprise_id_tenant_id_fkey";

ALTER TABLE "admin_organization_profiles"
ADD CONSTRAINT "admin_organization_profiles_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "admin_users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "admin_organization_profiles"
ADD CONSTRAINT "admin_organization_profiles_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "admin_organization_profiles"
ADD CONSTRAINT "admin_organization_profiles_enterprise_id_tenant_id_fkey"
FOREIGN KEY ("enterprise_id", "tenant_id") REFERENCES "enterprises"("id", "tenant_id")
ON DELETE CASCADE ON UPDATE CASCADE;
