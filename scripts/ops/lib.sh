#!/usr/bin/env bash

ops_project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ops_env_file="${XHS_ENV_FILE:-$ops_project_root/.env}"

read_project_env() {
  local name="$1"
  local current="${!name-}"
  if [[ -n "$current" ]]; then
    printf '%s' "$current"
    return
  fi
  if [[ ! -f "$ops_env_file" ]]; then
    echo "Missing environment value $name and environment file $ops_env_file" >&2
    return 1
  fi
  local value
  value=$(sed -n "s/^${name}=//p" "$ops_env_file" | tail -n 1 | tr -d '\r')
  if [[ -z "$value" ]]; then
    echo "Missing environment value: $name" >&2
    return 1
  fi
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command is unavailable: $1" >&2
    return 1
  fi
}

require_running_container() {
  local container_name="$1"
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)" != "true" ]]; then
    echo "Required Docker container is not running: $container_name" >&2
    return 1
  fi
}

database_url_part() {
  local database_url="$1"
  local part="$2"
  node -e '
    const url = new URL(process.argv[1]);
    const part = process.argv[2];
    const values = {
      database: decodeURIComponent(url.pathname.replace(/^\//u, "")),
      password: decodeURIComponent(url.password),
      username: decodeURIComponent(url.username),
    };
    const value = values[part];
    if (!value) process.exit(2);
    process.stdout.write(value);
  ' "$database_url" "$part"
}

validate_database_name() {
  if [[ ! "$1" =~ ^[a-zA-Z][a-zA-Z0-9_]{0,62}$ ]]; then
    echo "Unsafe PostgreSQL database name: $1" >&2
    return 1
  fi
}

validate_role_name() {
  if [[ ! "$1" =~ ^[a-zA-Z][a-zA-Z0-9_]{0,62}$ ]]; then
    echo "Unsafe PostgreSQL role name" >&2
    return 1
  fi
}

validate_bucket_name() {
  if [[ ! "$1" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
    echo "Unsafe object-storage bucket name: $1" >&2
    return 1
  fi
}

resolve_mc_command() {
  if command -v mc >/dev/null 2>&1; then
    command -v mc
    return
  fi
  if [[ -x "$ops_project_root/.tools/bin/mc" ]]; then
    printf '%s' "$ops_project_root/.tools/bin/mc"
    return
  fi
  echo "MinIO Client is unavailable; run scripts/dev/setup-toolchain.sh" >&2
  return 1
}

configure_mc_alias() {
  local mc_binary="$1"
  local config_dir="$2"
  local alias_name="$3"
  local endpoint="$4"
  local access_key="$5"
  local secret_key="$6"
  MC_CONFIG_DIR="$config_dir" "$mc_binary" alias set \
    "$alias_name" "$endpoint" "$access_key" "$secret_key" --api S3v4 >/dev/null
}

safe_remove_host_temp() {
  local target="$1"
  case "$target" in
    /tmp/xhs-agentic-* | /var/tmp/xhs-agentic-*) rm -rf -- "$target" ;;
    *) echo "Refusing to remove unexpected temporary path: $target" >&2 ;;
  esac
}
