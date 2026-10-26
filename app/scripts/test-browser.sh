#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Own every resource; never use a configured database or publish host ports.
run="excalidraw-browser-test-$$-$RANDOM"
network="$run-network"
database="$run-db"
runner="$run-node"
image="$run-image"
cleanup() {
  local status=$?
  trap - EXIT
  if ((status != 0)); then
    printf 'Browser harness failed (run=%s, exit=%s). Container logs follow.\n' "$run" "$status" >&2
    docker logs "$runner" >&2 2>/dev/null || true
    docker logs "$database" >&2 2>/dev/null || true
  fi
  docker rm -f -v "$runner" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker build -f scripts/browser-runner.Dockerfile -t "$image" ..
docker network create --internal "$network" >/dev/null
docker run -d --name "$database" --network "$network" \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=isolated-browser-test \
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
  echo 'Disposable PostgreSQL did not become ready within 60 seconds.' >&2
  exit 1
fi

docker run -i --name "$runner" --network "$network" --init --shm-size=1g \
  -e BROWSER_TEST_BASE_URL=http://127.0.0.1:3030 -e PORT=3030 \
  -e PGHOST="$database" -e PGPORT=5432 -e PGUSER=postgres \
  -e PGDATABASE=postgres -e PGPASSWORD=isolated-browser-test \
  -e PGSCHEMA=browser_test -e PGSSL=false \
  -e DATA_DIR=/tmp/excalidraw-browser-data \
  -e SESSION_SECRET=isolated-browser-fixture-secret \
  -e BROWSER_TEST_FILTER="${BROWSER_TEST_FILTER:-}" \
  -e OPENROUTER_API_KEY= -e GROQ_API_KEY= \
  "$image" bash -se <<'RUNNER'
node server.mjs &
server=$!
trap 'kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true' EXIT
node --input-type=module <<'FIXTURE'
import pg from "pg";
import bcrypt from "bcryptjs";
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(`${process.env.BROWSER_TEST_BASE_URL}/api/auth/session`, {
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!ready) throw new Error("Browser server did not become ready within 120 seconds.");
const pool = new pg.Pool();
try {
  const hash = await bcrypt.hash("fixture-password", 4);
  for (const username of ["owner", "member"]) {
    await pool.query("INSERT INTO browser_test.users (username, password_hash) VALUES ($1, $2)", [username, hash]);
  }
} finally {
  await pool.end();
}
FIXTURE
if [[ -n "${BROWSER_TEST_FILTER:-}" ]]; then
  ./node_modules/.bin/playwright test "$BROWSER_TEST_FILTER"
else
  ./node_modules/.bin/playwright test
fi
RUNNER
