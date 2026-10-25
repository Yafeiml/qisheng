#!/usr/bin/env bash
set -Eeuo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pnpm_runner="$project_root/scripts/dev/pnpm.sh"
server_log="$project_root/.artifacts/e2e-admin-web.log"
api_log="$project_root/.artifacts/e2e-api.log"
worker_log="$project_root/.artifacts/e2e-worker.log"
server_pid=""
api_pid=""
worker_pid=""
configured_redis_prefix="${REDIS_PREFIX:-}"

if [[ -z "$configured_redis_prefix" && -f "$project_root/.env" ]]; then
  configured_redis_prefix=$(sed -n 's/^REDIS_PREFIX=//p' "$project_root/.env" | tail -n 1)
  configured_redis_prefix=${configured_redis_prefix#\"}
  configured_redis_prefix=${configured_redis_prefix%\"}
  configured_redis_prefix=${configured_redis_prefix#\'}
  configured_redis_prefix=${configured_redis_prefix%\'}
fi

if [[ -z "$configured_redis_prefix" ]]; then
  echo "REDIS_PREFIX must be configured before running E2E tests." >&2
  exit 1
fi

e2e_redis_prefix="${configured_redis_prefix}:e2e-$(date -u +%Y%m%d%H%M%S)-$$"

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ -n "$api_pid" ]] && kill -0 "$api_pid" 2>/dev/null; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

cd "$project_root"
mkdir -p "$project_root/.artifacts"

require_port_free() {
  local port="$1"
  if ss -H -ltn "sport = :$port" | rg -q .; then
    echo "Port $port is already in use. Stop the existing development service before running isolated E2E tests." >&2
    exit 1
  fi
}

require_port_free 3100
require_port_free 3101

"$pnpm_runner" --filter @xhs-agentic/database... build
"$pnpm_runner" --filter @xhs-agentic/network-security build
"$pnpm_runner" --filter @xhs-agentic/ai-gateway build
"$pnpm_runner" --filter @xhs-agentic/content-safety build
"$pnpm_runner" --filter @xhs-agentic/object-storage build
"$pnpm_runner" --filter @xhs-agentic/observability build
"$pnpm_runner" --filter @xhs-agentic/api build
"$pnpm_runner" --filter @xhs-agentic/admin-web build
"$pnpm_runner" --filter @xhs-agentic/worker build
"$pnpm_runner" prisma:seed
REDIS_PREFIX="$e2e_redis_prefix" "$pnpm_runner" --filter @xhs-agentic/worker lifecycle:once

REDIS_PREFIX="$e2e_redis_prefix" \
  "$pnpm_runner" --filter @xhs-agentic/worker lifecycle >"$worker_log" 2>&1 &
worker_pid=$!

RATE_LIMIT_NAMESPACE="e2e-$(date -u +%Y%m%d%H%M%S)-$$" \
  RATE_LIMIT_GLOBAL_MAX=10000 RATE_LIMIT_DEV_AUTH_MAX=10000 \
  RATE_LIMIT_AUTH_IP_MAX=1000 RATE_LIMIT_AUTH_SUBJECT_MAX=100 \
  RATE_LIMIT_EXPENSIVE_MAX=1000 RATE_LIMIT_INTEGRATION_MAX=1000 \
  REDIS_PREFIX="$e2e_redis_prefix" LOG_LEVEL=warn \
  "$pnpm_runner" --filter @xhs-agentic/api start >"$api_log" 2>&1 &
api_pid=$!

api_ready=false
for _ in {1..60}; do
  if ! kill -0 "$api_pid" 2>/dev/null; then
    echo "API server exited before becoming ready." >&2
    tail -n 100 "$api_log" >&2
    exit 1
  fi

  if curl --fail --silent --noproxy '*' http://127.0.0.1:3100/health/live >/dev/null; then
    api_ready=true
    break
  fi

  sleep 0.5
done

if [[ "$api_ready" != true ]]; then
  echo "API server did not become ready within 30 seconds." >&2
  tail -n 100 "$api_log" >&2
  exit 1
fi

"$pnpm_runner" --filter @xhs-agentic/admin-web start >"$server_log" 2>&1 &
server_pid=$!

server_ready=false
for _ in {1..60}; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "Admin web server exited before becoming ready." >&2
    tail -n 100 "$server_log" >&2
    exit 1
  fi

  if curl --fail --silent --noproxy '*' http://127.0.0.1:3101/ >/dev/null; then
    server_ready=true
    break
  fi

  sleep 0.5
done

if [[ "$server_ready" != true ]]; then
  echo "Admin web server did not become ready within 30 seconds." >&2
  tail -n 100 "$server_log" >&2
  exit 1
fi

export NO_PROXY="127.0.0.1,localhost"
export no_proxy="$NO_PROXY"
"$pnpm_runner" exec playwright test "$@"
