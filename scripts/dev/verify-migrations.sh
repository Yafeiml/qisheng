#!/usr/bin/env bash
set -Eeuo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pnpm_runner="$project_root/scripts/dev/pnpm.sh"
postgres_container="${XHS_DEV_POSTGRES_CONTAINER:-dev-postgresql}"
postgres_role="dev_xhs_agentic"
postgres_password="dev_xhs_agentic_password"
primary_database="dev_xhs_agentic"
shadow_database="dev_xhs_agentic_shadow"
unused_shadow_database="dev_xhs_agentic_migrate_unused"

if [[ "$shadow_database" != "dev_xhs_agentic_shadow" || "$shadow_database" == "$primary_database" ]]; then
  echo "Refusing to recreate an unexpected migration verification database: $shadow_database" >&2
  exit 1
fi

if [[ "$(docker inspect --format '{{.State.Running}}' "$postgres_container" 2>/dev/null || true)" != "true" ]]; then
  echo "Required Docker container is not running: $postgres_container" >&2
  exit 1
fi

database_inventory=$(docker exec "$postgres_container" psql -U postgres -tAc \
  "SELECT datname || ':' || pg_get_userbyid(datdba) FROM pg_database WHERE datname IN ('$primary_database', '$shadow_database') ORDER BY datname")

if ! grep -qx "$primary_database:$postgres_role" <<<"$database_inventory"; then
  echo "Primary development database identity check failed; no database was changed." >&2
  exit 1
fi

if ! grep -qx "$shadow_database:$postgres_role" <<<"$database_inventory"; then
  echo "Shadow database identity check failed; no database was changed." >&2
  exit 1
fi

unused_shadow_exists=$(docker exec "$postgres_container" psql -U postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$unused_shadow_database'")
if [[ -n "$unused_shadow_exists" ]]; then
  echo "Reserved non-existent safety database unexpectedly exists: $unused_shadow_database" >&2
  exit 1
fi

docker exec "$postgres_container" dropdb -U postgres --force "$shadow_database"
docker exec "$postgres_container" createdb -U postgres -O "$postgres_role" "$shadow_database"

shadow_url="postgresql://$postgres_role:$postgres_password@127.0.0.1:5432/$shadow_database?schema=public"
unused_shadow_url="postgresql://$postgres_role:$postgres_password@127.0.0.1:5432/$unused_shadow_database?schema=public"

cd "$project_root"
DATABASE_URL="$shadow_url" SHADOW_DATABASE_URL="$unused_shadow_url" \
  "$pnpm_runner" exec prisma migrate deploy --schema prisma/schema.prisma
DATABASE_URL="$shadow_url" SHADOW_DATABASE_URL="$unused_shadow_url" \
  "$pnpm_runner" exec prisma migrate status --schema prisma/schema.prisma
DATABASE_URL="$shadow_url" SHADOW_DATABASE_URL="$unused_shadow_url" \
  "$pnpm_runner" exec prisma migrate diff \
    --exit-code \
    --from-config-datasource \
    --to-schema prisma/schema.prisma

expected_migrations=$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d -name '20*' | wc -l | tr -d ' ')
applied_migrations=$(docker exec -e PGPASSWORD="$postgres_password" "$postgres_container" \
  psql -h 127.0.0.1 -U "$postgres_role" -d "$shadow_database" -tAc \
  'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')

if [[ "$applied_migrations" != "$expected_migrations" ]]; then
  echo "Migration count mismatch: expected=$expected_migrations applied=$applied_migrations" >&2
  exit 1
fi

primary_identity=$(docker exec "$postgres_container" psql -U postgres -tAc \
  "SELECT datname || ':' || pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$primary_database'")
if [[ "$primary_identity" != "$primary_database:$postgres_role" ]]; then
  echo "Primary development database identity changed unexpectedly." >&2
  exit 1
fi

echo "Migration verification passed: database=$shadow_database migrations=$applied_migrations schema-diff=empty"
