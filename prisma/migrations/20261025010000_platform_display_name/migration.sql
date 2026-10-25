UPDATE "platform_settings"
SET "value" = to_jsonb('企声发布'::text),
    "version" = "version" + 1,
    "updated_at" = CURRENT_TIMESTAMP,
    "updated_by" = 'system:migration:platform_display_name'
WHERE "key" = 'general.platform_name'
  AND "value" = to_jsonb('XHS Agentic'::text);
