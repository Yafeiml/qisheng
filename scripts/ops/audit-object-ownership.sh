#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

mode="${1:-audit}"
if [[ "$mode" != "audit" && "$mode" != "--delete-orphans" ]]; then
  echo "Usage: $0 [audit|--delete-orphans]" >&2
  exit 2
fi

postgres_container="${XHS_DEV_POSTGRES_CONTAINER:-dev-postgresql}"
minio_container="${XHS_DEV_MINIO_CONTAINER:-dev-minio}"
require_running_container "$postgres_container"
require_running_container "$minio_container"

database_url=$(read_project_env DATABASE_URL)
database_name=$(database_url_part "$database_url" database)
bucket=$(read_project_env OBJECT_STORAGE_BUCKET)
validate_database_name "$database_name"
validate_bucket_name "$bucket"

work_dir=$(mktemp -d /tmp/xhs-agentic-object-ownership.XXXXXX)
mc_config=$(mktemp -d /tmp/xhs-agentic-mc.XXXXXX)
cleanup() {
  safe_remove_host_temp "$work_dir"
  safe_remove_host_temp "$mc_config"
}
trap cleanup EXIT

mc_binary=$(resolve_mc_command)
configure_mc_alias \
  "$mc_binary" "$mc_config" xhs_ownership \
  "$(read_project_env OBJECT_STORAGE_ENDPOINT)" \
  "$(read_project_env OBJECT_STORAGE_ACCESS_KEY)" \
  "$(read_project_env OBJECT_STORAGE_SECRET_KEY)"

list_bucket_keys() {
  MC_CONFIG_DIR="$mc_config" "$mc_binary" ls --recursive --json "xhs_ownership/$bucket" |
    node -e '
      const readline = require("node:readline");
      const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      lines.on("line", (line) => {
        if (!line.trim()) return;
        const item = JSON.parse(line);
        if (item.status === "success" && item.type === "file" && typeof item.key === "string") {
          process.stdout.write(`${item.key}\n`);
        }
      });
    ' |
    sort -u
}

list_database_keys() {
  docker exec "$postgres_container" psql -U postgres -d "$database_name" -Atc "
    SELECT DISTINCT key
    FROM (
      SELECT storage_key AS key
      FROM storage_reservations
      WHERE storage_key IS NOT NULL AND status <> 'RELEASED'
      UNION ALL
      SELECT storage_key
      FROM generated_images
      WHERE storage_key IS NOT NULL
      UNION ALL
      SELECT object_key
      FROM material_artifacts
      WHERE object_key IS NOT NULL
      UNION ALL
      SELECT image->>'storageKey'
      FROM employee_content_revisions,
           LATERAL jsonb_array_elements(COALESCE(snapshot->'images', '[]'::jsonb)) AS image
      WHERE image->>'storageKey' IS NOT NULL
    ) AS object_refs
    ORDER BY key
  "
}

list_bucket_keys >"$work_dir/bucket.keys"
list_database_keys >"$work_dir/database.keys"
comm -23 "$work_dir/bucket.keys" "$work_dir/database.keys" >"$work_dir/orphan.keys"
comm -13 "$work_dir/bucket.keys" "$work_dir/database.keys" >"$work_dir/missing.keys"

bucket_count=$(wc -l <"$work_dir/bucket.keys" | tr -d ' ')
reference_count=$(wc -l <"$work_dir/database.keys" | tr -d ' ')
orphan_count=$(wc -l <"$work_dir/orphan.keys" | tr -d ' ')
missing_count=$(wc -l <"$work_dir/missing.keys" | tr -d ' ')
printf 'Object ownership: bucket=%s references=%s orphans=%s missing=%s\n' \
  "$bucket_count" "$reference_count" "$orphan_count" "$missing_count"

if [[ "$missing_count" != "0" ]]; then
  echo "Refusing cleanup because database references are missing from object storage" >&2
  exit 1
fi
if [[ "$mode" != "--delete-orphans" || "$orphan_count" == "0" ]]; then exit 0; fi

while IFS= read -r key; do
  if [[ ! "$key" =~ ^tenants/[A-Za-z0-9_-]{1,128}/(campaigns|materials)/[A-Za-z0-9_./-]{1,900}$ ]]; then
    echo "Refusing unsafe orphan object key" >&2
    exit 1
  fi
  MC_CONFIG_DIR="$mc_config" "$mc_binary" rm --quiet "xhs_ownership/$bucket/$key" >/dev/null
done <"$work_dir/orphan.keys"

list_bucket_keys >"$work_dir/bucket-after.keys"
remaining_orphans=$(comm -23 "$work_dir/bucket-after.keys" "$work_dir/database.keys" | wc -l | tr -d ' ')
if [[ "$remaining_orphans" != "0" ]]; then
  echo "Object ownership cleanup did not converge" >&2
  exit 1
fi
printf 'Deleted %s orphan object(s); versioned noncurrent data remains recoverable by lifecycle policy.\n' \
  "$orphan_count"
