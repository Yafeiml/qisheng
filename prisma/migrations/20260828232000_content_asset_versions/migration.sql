ALTER TABLE "materials"
  ADD COLUMN "series_id" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "supersedes_id" TEXT,
  ADD COLUMN "change_note" VARCHAR(500);

UPDATE "materials" SET "series_id" = "id" WHERE "series_id" IS NULL;
ALTER TABLE "materials" ALTER COLUMN "series_id" SET NOT NULL;

ALTER TABLE "sensitive_rules"
  ADD COLUMN "series_id" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "supersedes_id" TEXT,
  ADD COLUMN "change_note" VARCHAR(500),
  ADD COLUMN "scope_key" VARCHAR(64),
  ADD COLUMN "key" VARCHAR(240);

UPDATE "sensitive_rules"
SET
  "series_id" = "id",
  "scope_key" = COALESCE("enterprise_id", "tenant_id"),
  "key" = lower(trim("term"))
WHERE "series_id" IS NULL OR "scope_key" IS NULL OR "key" IS NULL;

WITH ranked AS (
  SELECT
    "id",
    first_value("id") OVER (
      PARTITION BY "tenant_id", "scope_key", "key"
      ORDER BY "created_at", "id"
    ) AS "resolved_series_id",
    row_number() OVER (
      PARTITION BY "tenant_id", "scope_key", "key"
      ORDER BY "created_at", "id"
    ) AS "resolved_version",
    count(*) OVER (PARTITION BY "tenant_id", "scope_key", "key") AS "version_count"
  FROM "sensitive_rules"
)
UPDATE "sensitive_rules" AS target
SET
  "series_id" = ranked."resolved_series_id",
  "version" = ranked."resolved_version",
  "status" = CASE
    WHEN ranked."resolved_version" < ranked."version_count" THEN 'DISABLED'::"material_status"
    ELSE target."status"
  END
FROM ranked
WHERE target."id" = ranked."id";
ALTER TABLE "sensitive_rules" ALTER COLUMN "series_id" SET NOT NULL;
ALTER TABLE "sensitive_rules" ALTER COLUMN "scope_key" SET NOT NULL;
ALTER TABLE "sensitive_rules" ALTER COLUMN "key" SET NOT NULL;

ALTER TABLE "geo_entities"
  ADD COLUMN "series_id" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "supersedes_id" TEXT,
  ADD COLUMN "change_note" VARCHAR(500),
  ADD COLUMN "scope_key" VARCHAR(64),
  ADD COLUMN "key" VARCHAR(240);

UPDATE "geo_entities"
SET
  "series_id" = "id",
  "scope_key" = COALESCE("enterprise_id", "tenant_id"),
  "key" = lower("type"::text || ':' || trim("name"))
WHERE "series_id" IS NULL OR "scope_key" IS NULL OR "key" IS NULL;

WITH ranked AS (
  SELECT
    "id",
    first_value("id") OVER (
      PARTITION BY "tenant_id", "scope_key", "key"
      ORDER BY "created_at", "id"
    ) AS "resolved_series_id",
    row_number() OVER (
      PARTITION BY "tenant_id", "scope_key", "key"
      ORDER BY "created_at", "id"
    ) AS "resolved_version",
    count(*) OVER (PARTITION BY "tenant_id", "scope_key", "key") AS "version_count"
  FROM "geo_entities"
)
UPDATE "geo_entities" AS target
SET
  "series_id" = ranked."resolved_series_id",
  "version" = ranked."resolved_version",
  "status" = CASE
    WHEN ranked."resolved_version" < ranked."version_count" THEN 'DISABLED'::"material_status"
    ELSE target."status"
  END
FROM ranked
WHERE target."id" = ranked."id";
ALTER TABLE "geo_entities" ALTER COLUMN "series_id" SET NOT NULL;
ALTER TABLE "geo_entities" ALTER COLUMN "scope_key" SET NOT NULL;
ALTER TABLE "geo_entities" ALTER COLUMN "key" SET NOT NULL;

ALTER TABLE "geo_topics"
  ADD COLUMN "series_id" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "supersedes_id" TEXT,
  ADD COLUMN "change_note" VARCHAR(500);

UPDATE "geo_topics" SET "series_id" = "id" WHERE "series_id" IS NULL;
ALTER TABLE "geo_topics" ALTER COLUMN "series_id" SET NOT NULL;

CREATE UNIQUE INDEX "materials_series_id_version_key" ON "materials"("series_id", "version");
CREATE INDEX "materials_supersedes_id_idx" ON "materials"("supersedes_id");

CREATE UNIQUE INDEX "sensitive_rules_series_id_version_key" ON "sensitive_rules"("series_id", "version");
CREATE INDEX "sensitive_rules_tenant_id_scope_key_key_status_idx"
  ON "sensitive_rules"("tenant_id", "scope_key", "key", "status");
CREATE INDEX "sensitive_rules_supersedes_id_idx" ON "sensitive_rules"("supersedes_id");

CREATE UNIQUE INDEX "geo_entities_series_id_version_key" ON "geo_entities"("series_id", "version");
CREATE INDEX "geo_entities_tenant_id_scope_key_key_status_idx"
  ON "geo_entities"("tenant_id", "scope_key", "key", "status");
CREATE INDEX "geo_entities_supersedes_id_idx" ON "geo_entities"("supersedes_id");

CREATE UNIQUE INDEX "geo_topics_series_id_version_key" ON "geo_topics"("series_id", "version");
CREATE INDEX "geo_topics_supersedes_id_idx" ON "geo_topics"("supersedes_id");
