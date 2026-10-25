#!/usr/bin/env bash
set -Eeuo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pnpm_runner="$project_root/scripts/dev/pnpm.sh"
log_dir="${XHS_DEV_LOG_DIR:-$project_root/.artifacts/dev}"
postgres_container="${XHS_DEV_POSTGRES_CONTAINER:-dev-postgresql}"
redis_container="${XHS_DEV_REDIS_CONTAINER:-dev-redis}"

api_url="http://127.0.0.1:3100/health/ready"
admin_url="http://127.0.0.1:3101/console"
worker_pattern="$project_root.*tsx.*watch.*src/lifecycle"

is_healthy() {
  curl --fail --silent --noproxy '*' --max-time 2 "$1" >/dev/null
}

ensure_container_running() {
  local container_name="$1"

  if ! docker inspect "$container_name" >/dev/null 2>&1; then
    echo "Required development container does not exist: $container_name" >&2
    echo "Create it using the local infrastructure setup before running dev:all." >&2
    return 1
  fi

  if [[ "$(docker inspect --format '{{.State.Running}}' "$container_name")" != "true" ]]; then
    docker start "$container_name" >/dev/null
    echo "Started development container: $container_name"
  fi
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local log_file="$3"

  for _ in {1..60}; do
    if is_healthy "$url"; then return 0; fi
    sleep 0.5
  done

  echo "$name did not become ready. Recent log output:" >&2
  tail -n 100 "$log_file" >&2 || true
  return 1
}

wait_for_process() {
  local name="$1"
  local pattern="$2"
  local log_file="$3"

  for _ in {1..20}; do
    if pgrep -f "$pattern" >/dev/null; then return 0; fi
    sleep 0.5
  done

  echo "$name did not remain running. Recent log output:" >&2
  tail -n 100 "$log_file" >&2 || true
  return 1
}

start_background() {
  local name="$1"
  local log_file="$2"
  shift 2

  nohup setsid "$@" </dev/null >"$log_file" 2>&1 &
  printf '%s started (pid %s).\n' "$name" "$!"
}

cd "$project_root"
mkdir -p "$log_dir"

ensure_container_running "$postgres_container"
ensure_container_running "$redis_container"

if ! "$pnpm_runner" infra:check; then
  echo "Infrastructure check failed; restoring development infrastructure."
  "$pnpm_runner" infra:bootstrap
  "$pnpm_runner" infra:check
fi

api_log="$log_dir/api.log"
if is_healthy "$api_url"; then
  echo "API is already ready."
else
  start_background "API" "$api_log" "$pnpm_runner" dev:api
  wait_for_http "API" "$api_url" "$api_log"
fi

admin_log="$log_dir/admin.log"
if is_healthy "$admin_url"; then
  echo "Admin web is already ready."
else
  start_background "Admin web" "$admin_log" "$pnpm_runner" dev:admin
  wait_for_http "Admin web" "$admin_url" "$admin_log"
fi

worker_log="$log_dir/worker.log"
if pgrep -f "$worker_pattern" >/dev/null; then
  echo "Worker is already running."
else
  start_background "Worker" "$worker_log" "$pnpm_runner" dev:worker
  wait_for_process "Worker" "$worker_pattern" "$worker_log"
fi

echo "All local development services are ready."
echo "Platform administration: http://localhost:3101/platform"
echo "User / enterprise administration: http://localhost:3101/console"
echo "API health: http://localhost:3100/health/ready"
echo "Logs: $log_dir"
