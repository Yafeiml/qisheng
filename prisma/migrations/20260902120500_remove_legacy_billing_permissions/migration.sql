-- Remove authorization artifacts that referred to the retired package, quota and paid-seat model.
DELETE FROM "role_permissions"
WHERE "permission_id" IN (
  SELECT "id"
  FROM "permissions"
  WHERE "code" IN ('platform.plan.manage', 'tenant.quota.read', 'enterprise.quota.read')
);

DELETE FROM "permissions"
WHERE "code" IN ('platform.plan.manage', 'tenant.quota.read', 'enterprise.quota.read');
