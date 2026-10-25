#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

require_command docker
require_command node
require_command sha256sum

postgres_container="${XHS_DEV_POSTGRES_CONTAINER:-dev-postgresql}"
minio_container="${XHS_DEV_MINIO_CONTAINER:-dev-minio}"
require_running_container "$postgres_container"
require_running_container "$minio_container"

database_url=$(read_project_env DATABASE_URL)
source_database=$(database_url_part "$database_url" database)
source_bucket=$(read_project_env OBJECT_STORAGE_BUCKET)
object_endpoint=$(read_project_env OBJECT_STORAGE_ENDPOINT)
object_access_key=$(read_project_env OBJECT_STORAGE_ACCESS_KEY)
object_secret_key=$(read_project_env OBJECT_STORAGE_SECRET_KEY)
mc_binary=$(resolve_mc_command)
validate_database_name "$source_database"
validate_bucket_name "$source_bucket"

backup_id=$(date -u +%Y%m%dT%H%M%SZ)
target_arg="${1:-$ops_project_root/.artifacts/backups/$backup_id}"
target_dir=$(realpath -m "$target_arg")
if [[ "$target_dir" == "/" || "$target_dir" == "$ops_project_root" ]]; then
  echo "Refusing unsafe backup target: $target_dir" >&2
  exit 1
fi
if [[ -d "$target_dir" && -n "$(find "$target_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Backup target must be empty: $target_dir" >&2
  exit 1
fi
mkdir -p "$target_dir/objects"
touch "$target_dir/.incomplete"

mc_config=""
cleanup() {
  if [[ -n "$mc_config" ]]; then safe_remove_host_temp "$mc_config"; fi
}
trap cleanup EXIT

database_url_without_query="${database_url%%\?*}"
docker exec -e "XHS_DATABASE_URL=$database_url_without_query" "$postgres_container" \
  sh -eu -c 'pg_dump --dbname="$XHS_DATABASE_URL" --format=custom --no-acl --no-owner' \
  >"$target_dir/database.dump"
docker exec -i "$postgres_container" pg_restore --list <"$target_dir/database.dump" >/dev/null

mc_config=$(mktemp -d /tmp/xhs-agentic-mc.XXXXXX)
configure_mc_alias \
  "$mc_binary" "$mc_config" xhs_source \
  "$object_endpoint" "$object_access_key" "$object_secret_key"
MC_CONFIG_DIR="$mc_config" "$mc_binary" mirror --overwrite --preserve --quiet \
  "xhs_source/$source_bucket" "$target_dir/objects" >/dev/null

(
  cd "$target_dir"
  sha256sum database.dump >database.sha256
  find objects -type f -print0 | sort -z | xargs -0 -r sha256sum >objects.sha256
)
database_checksum=$(cut -d ' ' -f 1 "$target_dir/database.sha256")
object_count=$(find "$target_dir/objects" -type f | wc -l | tr -d ' ')
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{\n  "formatVersion": 1,\n  "createdAt": "%s",\n  "sourceDatabase": "%s",\n  "sourceBucket": "%s",\n  "databaseSha256": "%s",\n  "objectCount": %s\n}\n' \
  "$created_at" "$source_database" "$source_bucket" "$database_checksum" "$object_count" \
  >"$target_dir/manifest.json"
rm "$target_dir/.incomplete"
touch "$target_dir/COMPLETE"

printf 'Backup complete: %s\n' "$target_dir"
printf 'PostgreSQL: %s\nObject storage: %s object(s)\n' "$source_database" "$object_count"
