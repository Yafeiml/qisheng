#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 BACKUP_DIRECTORY TARGET_DATABASE TARGET_BUCKET" >&2
  exit 2
fi

backup_dir=$(realpath "$1")
target_database="$2"
target_bucket="$3"
validate_database_name "$target_database"
validate_bucket_name "$target_bucket"

for required_file in COMPLETE manifest.json database.dump database.sha256 objects.sha256; do
  if [[ ! -f "$backup_dir/$required_file" ]]; then
    echo "Backup is incomplete; missing $required_file" >&2
    exit 1
  fi
done

source_database=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sourceDatabase' "$backup_dir/manifest.json")
source_bucket=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sourceBucket' "$backup_dir/manifest.json")
validate_database_name "$source_database"
validate_bucket_name "$source_bucket"
if [[ "$target_database" == "$source_database" || "$target_bucket" == "$source_bucket" ]]; then
  echo "Restore targets must be isolated from the source database and bucket" >&2
  exit 1
fi

(
  cd "$backup_dir"
  sha256sum --check database.sha256 >/dev/null
  if [[ -s objects.sha256 ]]; then sha256sum --check objects.sha256 >/dev/null; fi
)

postgres_container="${XHS_DEV_POSTGRES_CONTAINER:-dev-postgresql}"
minio_container="${XHS_DEV_MINIO_CONTAINER:-dev-minio}"
require_running_container "$postgres_container"
require_running_container "$minio_container"

database_url=$(read_project_env DATABASE_URL)
database_user=$(database_url_part "$database_url" username)
database_password=$(database_url_part "$database_url" password)
validate_role_name "$database_user"
object_endpoint=$(read_project_env OBJECT_STORAGE_ENDPOINT)
object_access_key=$(read_project_env OBJECT_STORAGE_ACCESS_KEY)
object_secret_key=$(read_project_env OBJECT_STORAGE_SECRET_KEY)
mc_binary=$(resolve_mc_command)

database_exists=$(docker exec "$postgres_container" psql -U postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$target_database'")
if [[ "$database_exists" == "1" ]]; then
  echo "Target database already exists; refusing to overwrite: $target_database" >&2
  exit 1
fi

mc_config=$(mktemp -d /tmp/xhs-agentic-mc.XXXXXX)
configure_mc_alias \
  "$mc_binary" "$mc_config" xhs_target \
  "$object_endpoint" "$object_access_key" "$object_secret_key"
if MC_CONFIG_DIR="$mc_config" "$mc_binary" stat "xhs_target/$target_bucket" >/dev/null 2>&1; then
  echo "Target bucket already exists; refusing to overwrite: $target_bucket" >&2
  safe_remove_host_temp "$mc_config"
  exit 1
fi

created_database=false
created_bucket=false
restore_succeeded=false
cleanup() {
  if [[ "$restore_succeeded" != true ]]; then
    if [[ "$created_bucket" == true ]]; then
      MC_CONFIG_DIR="$mc_config" "$mc_binary" rb --force "xhs_target/$target_bucket" \
        >/dev/null 2>&1 || true
    fi
    if [[ "$created_database" == true ]]; then
      docker exec "$postgres_container" dropdb -U postgres --force "$target_database" \
        >/dev/null 2>&1 || true
    fi
  fi
  safe_remove_host_temp "$mc_config"
}
trap cleanup EXIT

docker exec "$postgres_container" createdb -U postgres -O "$database_user" "$target_database"
created_database=true
docker exec -i -e "PGPASSWORD=$database_password" "$postgres_container" \
  pg_restore --exit-on-error --no-acl --no-owner -h 127.0.0.1 -U "$database_user" \
  -d "$target_database" <"$backup_dir/database.dump"

MC_CONFIG_DIR="$mc_config" "$mc_binary" mb "xhs_target/$target_bucket" >/dev/null
created_bucket=true
MC_CONFIG_DIR="$mc_config" "$mc_binary" mirror --overwrite --preserve --quiet \
  "$backup_dir/objects" "xhs_target/$target_bucket" >/dev/null

restore_succeeded=true
printf 'Restore complete: database=%s bucket=%s\n' "$target_database" "$target_bucket"
