-- Immutable versions intentionally reuse the same business identity inside a
-- scope. Active-version conflicts are serialized and enforced by the service;
-- these legacy partial indexes would reject every v2 row.
DROP INDEX IF EXISTS "sensitive_rules_tenant_public_term_key";
DROP INDEX IF EXISTS "sensitive_rules_enterprise_term_key";
DROP INDEX IF EXISTS "geo_entities_tenant_public_name_type_key";
DROP INDEX IF EXISTS "geo_entities_enterprise_name_type_key";
