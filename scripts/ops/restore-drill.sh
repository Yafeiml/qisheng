#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

postgres_container="${XHS_DEV_POSTGRES_CONTAINER:-dev-postgresql}"
minio_container="${XHS_DEV_MINIO_CONTAINER:-dev-minio}"
require_running_container "$postgres_container"
require_running_container "$minio_container"

drill_id="$(date -u +%Y%m%d%H%M%S)_$$"
target_database="dev_xhs_restore_$drill_id"
target_bucket="dev-xhs-restore-${drill_id//_/-}"
validate_database_name "$target_database"
validate_bucket_name "$target_bucket"

work_dir=$(mktemp -d /tmp/xhs-agentic-restore-drill.XXXXXX)
backup_dir="$work_dir/backup"
verify_dir="$work_dir/verify"
mkdir -p "$verify_dir"

database_url=$(read_project_env DATABASE_URL)
source_database=$(database_url_part "$database_url" database)
object_endpoint=$(read_project_env OBJECT_STORAGE_ENDPOINT)
object_access_key=$(read_project_env OBJECT_STORAGE_ACCESS_KEY)
object_secret_key=$(read_project_env OBJECT_STORAGE_SECRET_KEY)
mc_binary=$(resolve_mc_command)

mc_config=""
cleanup() {
  docker exec "$postgres_container" dropdb -U postgres --force "$target_database" \
    >/dev/null 2>&1 || true
  if [[ -n "$mc_config" ]]; then
    MC_CONFIG_DIR="$mc_config" "$mc_binary" rb --force "xhs_verify/$target_bucket" \
      >/dev/null 2>&1 || true
    safe_remove_host_temp "$mc_config"
  fi
  if [[ "${KEEP_RESTORE_DRILL:-false}" != "true" ]]; then safe_remove_host_temp "$work_dir"; fi
}
trap cleanup EXIT

"$script_dir/backup.sh" "$backup_dir"
"$script_dir/restore.sh" "$backup_dir" "$target_database" "$target_bucket"

source_migrations=$(docker exec "$postgres_container" psql -U postgres -d "$source_database" -tAc \
  'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')
target_migrations=$(docker exec "$postgres_container" psql -U postgres -d "$target_database" -tAc \
  'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')
source_tables=$(docker exec "$postgres_container" psql -U postgres -d "$source_database" -tAc \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'")
target_tables=$(docker exec "$postgres_container" psql -U postgres -d "$target_database" -tAc \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'")
if [[ "$source_migrations" != "$target_migrations" || "$source_tables" != "$target_tables" ]]; then
  echo "PostgreSQL restore verification failed" >&2
  exit 1
fi

mc_config=$(mktemp -d /tmp/xhs-agentic-mc.XXXXXX)
configure_mc_alias \
  "$mc_binary" "$mc_config" xhs_verify \
  "$object_endpoint" "$object_access_key" "$object_secret_key"
MC_CONFIG_DIR="$mc_config" "$mc_binary" mirror --overwrite --quiet \
  "xhs_verify/$target_bucket" "$verify_dir" >/dev/null
(
  cd "$work_dir"
  find verify -type f -print0 | sort -z | xargs -0 -r sha256sum | sed 's#  verify/#  objects/#' \
    >verify.sha256
)
if ! cmp -s "$backup_dir/objects.sha256" "$work_dir/verify.sha256"; then
  echo "Object-storage restore verification failed" >&2
  exit 1
fi

object_count=$(find "$verify_dir" -type f | wc -l | tr -d ' ')
printf 'Restore drill passed: migrations=%s tables=%s objects=%s\n' \
  "$target_migrations" "$target_tables" "$object_count"
if [[ "${KEEP_RESTORE_DRILL:-false}" == "true" ]]; then
  printf 'Drill artifacts retained: %s\n' "$work_dir"
fi
