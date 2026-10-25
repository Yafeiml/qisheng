INSERT INTO "permissions" ("id", "code", "name", "description", "created_at", "updated_at")
VALUES (
  'sprint9_platform_access_manage',
  'platform.access.manage',
  '管理平台管理员',
  '治理平台管理员账号、角色绑定和管理会话',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "updated_at" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("role_id", "permission_id", "created_at")
SELECT role."id", permission."id", CURRENT_TIMESTAMP
FROM "roles" AS role
CROSS JOIN "permissions" AS permission
WHERE role."code" = 'PLATFORM_ADMIN'
  AND permission."code" = 'platform.access.manage'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
