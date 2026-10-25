#!/usr/bin/env bash
set -euo pipefail

postgres_container="${XHS_DEV_POSTGRES_CONTAINER:-dev-postgresql}"
redis_container="${XHS_DEV_REDIS_CONTAINER:-dev-redis}"
minio_container="${XHS_DEV_MINIO_CONTAINER:-dev-minio}"
minio_image="${XHS_DEV_MINIO_IMAGE:-quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z}"

postgres_role="dev_xhs_agentic"
postgres_database="dev_xhs_agentic"
postgres_shadow_database="dev_xhs_agentic_shadow"
postgres_password="dev_xhs_agentic_password"

redis_user="dev_xhs_agentic"
redis_password="dev_xhs_agentic_password"
redis_prefix="xhs-agentic:dev"
minio_access_key="dev_xhs_agentic"
minio_secret_key="dev_xhs_agentic_password"

require_running_container() {
  local container_name="$1"
  local running
  running=$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)
  if [[ "$running" != "true" ]]; then
    echo "Required Docker container is not running: $container_name" >&2
    exit 1
  fi
}

require_running_container "$postgres_container"
require_running_container "$redis_container"

if ! docker inspect "$minio_container" >/dev/null 2>&1; then
  docker run -d \
    --name "$minio_container" \
    --restart unless-stopped \
    -p 127.0.0.1:9000:9000 \
    -p 127.0.0.1:9001:9001 \
    -e "MINIO_ROOT_USER=$minio_access_key" \
    -e "MINIO_ROOT_PASSWORD=$minio_secret_key" \
    -v dev-minio-data:/data \
    "$minio_image" server /data --console-address :9001 >/dev/null
elif [[ "$(docker inspect --format '{{.State.Running}}' "$minio_container")" != "true" ]]; then
  docker start "$minio_container" >/dev/null
fi

minio_ready=false
for _ in {1..60}; do
  if curl --fail --silent --noproxy '*' http://127.0.0.1:9000/minio/health/live >/dev/null; then
    minio_ready=true
    break
  fi
  sleep 0.5
done

if [[ "$minio_ready" != true ]]; then
  echo "Development MinIO did not become ready" >&2
  exit 1
fi

role_exists=$(docker exec "$postgres_container" psql -U postgres -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname = '$postgres_role'")

if [[ "$role_exists" != "1" ]]; then
  docker exec "$postgres_container" psql -U postgres -v ON_ERROR_STOP=1 -c \
    "CREATE ROLE $postgres_role LOGIN PASSWORD '$postgres_password'"
else
  docker exec "$postgres_container" psql -U postgres -v ON_ERROR_STOP=1 -c \
    "ALTER ROLE $postgres_role WITH LOGIN PASSWORD '$postgres_password'" >/dev/null
fi

docker exec "$postgres_container" psql -U postgres -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE $postgres_role SET timezone TO 'UTC'" >/dev/null

database_exists=$(docker exec "$postgres_container" psql -U postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$postgres_database'")

if [[ "$database_exists" != "1" ]]; then
  docker exec "$postgres_container" createdb -U postgres -O "$postgres_role" "$postgres_database"
fi

shadow_database_exists=$(docker exec "$postgres_container" psql -U postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$postgres_shadow_database'")

if [[ "$shadow_database_exists" != "1" ]]; then
  docker exec "$postgres_container" createdb -U postgres -O "$postgres_role" "$postgres_shadow_database"
fi

docker exec "$postgres_container" psql -U postgres -v ON_ERROR_STOP=1 -c \
  "ALTER DATABASE $postgres_database OWNER TO $postgres_role" >/dev/null
docker exec "$postgres_container" psql -U postgres -v ON_ERROR_STOP=1 -c \
  "ALTER DATABASE $postgres_shadow_database OWNER TO $postgres_role" >/dev/null
docker exec "$postgres_container" psql -U postgres -v ON_ERROR_STOP=1 -c \
  "ALTER DATABASE $postgres_database SET timezone TO 'UTC'" >/dev/null
docker exec "$postgres_container" psql -U postgres -v ON_ERROR_STOP=1 -c \
  "ALTER DATABASE $postgres_shadow_database SET timezone TO 'UTC'" >/dev/null
docker exec "$postgres_container" psql -U postgres -d "$postgres_database" -v ON_ERROR_STOP=1 -c \
  "GRANT ALL ON SCHEMA public TO $postgres_role" >/dev/null

redis_admin_password=$(
  docker inspect "$redis_container" --format '{{range .Config.Cmd}}{{println .}}{{end}}' |
    awk 'found { print; exit } $0 == "--requirepass" { found = 1 }'
)

if [[ -z "$redis_admin_password" ]]; then
  echo "Unable to resolve the development Redis admin credential" >&2
  exit 1
fi

docker exec "$redis_container" redis-cli --no-auth-warning -a "$redis_admin_password" \
  ACL SETUSER "$redis_user" on ">$redis_password" "~$redis_prefix:*" +@all \
  -acl -config -flushall -flushdb -module -shutdown >/dev/null

docker exec "$redis_container" redis-cli --no-auth-warning --user "$redis_user" \
  --pass "$redis_password" SET "$redis_prefix:bootstrap" ready EX 30 >/dev/null

echo "Development PostgreSQL, Redis namespace and MinIO are ready."
