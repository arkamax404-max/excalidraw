#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# This runner owns all resources below; it never connects to a configured database.
run="excalidraw-api-test-$$-$RANDOM"
network="$run-network"
database="$run-db"
runner="$run-node"
cleanup() {
  local status=$?
  trap - EXIT
  docker rm -f -v "$runner" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker network create --internal "$network" >/dev/null
docker run -d --name "$database" --network "$network" \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=isolated-api-test \
  postgres:16-alpine >/dev/null

ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$database" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs "$database" >&2
  echo 'Disposable PostgreSQL did not become ready within 60 seconds.' >&2
  exit 1
fi

docker run --name "$runner" --network "$network" \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD,target=/workspace,readonly" \
  --workdir /workspace \
  -e API_TEST_ISOLATED=1 -e PGHOST="$database" \
  -e PGPORT=5432 -e PGUSER=postgres -e PGDATABASE=postgres \
  -e PGPASSWORD=isolated-api-test \
  node:22-alpine node --test --test-concurrency=1 tests/api.integration.mjs tests/permissions.integration.mjs tests/membership.integration.mjs
