#!/usr/bin/env bash
set -euo pipefail

postgres_container="${XHS_DEV_POSTGRES_CONTAINER:-dev-postgresql}"
redis_container="${XHS_DEV_REDIS_CONTAINER:-dev-redis}"
minio_container="${XHS_DEV_MINIO_CONTAINER:-dev-minio}"

postgres_result=$(docker exec -e PGPASSWORD=dev_xhs_agentic_password "$postgres_container" \
  psql -h 127.0.0.1 -U dev_xhs_agentic -d dev_xhs_agentic -tAc \
  "SELECT current_database() || ':' || current_user || ':' || current_setting('TimeZone')")

postgres_shadow_result=$(docker exec -e PGPASSWORD=dev_xhs_agentic_password "$postgres_container" \
  psql -h 127.0.0.1 -U dev_xhs_agentic -d dev_xhs_agentic_shadow -tAc \
  "SELECT current_database() || ':' || current_user || ':' || current_setting('TimeZone')")

redis_result=$(docker exec "$redis_container" redis-cli --no-auth-warning \
  --user dev_xhs_agentic --pass dev_xhs_agentic_password PING)

if [[ "$postgres_result" != "dev_xhs_agentic:dev_xhs_agentic:UTC" ]]; then
  echo "PostgreSQL check failed" >&2
  exit 1
fi

if [[ "$postgres_shadow_result" != "dev_xhs_agentic_shadow:dev_xhs_agentic:UTC" ]]; then
  echo "PostgreSQL shadow database check failed" >&2
  exit 1
fi

if [[ "$redis_result" != "PONG" ]]; then
  echo "Redis check failed" >&2
  exit 1
fi

if [[ "$(docker inspect --format '{{.State.Running}}' "$minio_container" 2>/dev/null || true)" != "true" ]]; then
  echo "MinIO check failed" >&2
  exit 1
fi

if ! curl --fail --silent --noproxy '*' http://127.0.0.1:9000/minio/health/live >/dev/null; then
  echo "MinIO health check failed" >&2
  exit 1
fi

echo "PostgreSQL: $postgres_result"
echo "PostgreSQL shadow: $postgres_shadow_result"
echo "Redis: $redis_result"
echo "MinIO: ready"
