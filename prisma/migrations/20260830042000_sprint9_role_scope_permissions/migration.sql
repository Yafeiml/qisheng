DELETE FROM "role_permissions" AS role_permission
USING "roles" AS role, "permissions" AS permission
WHERE role_permission."role_id" = role."id"
  AND role_permission."permission_id" = permission."id"
  AND role."code" IN ('CONTENT_OPERATOR_ENTERPRISE', 'DATA_VIEWER_ENTERPRISE')
  AND permission."code" LIKE 'tenant.%';
