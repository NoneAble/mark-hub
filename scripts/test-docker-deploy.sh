#!/usr/bin/env bash
# Owned Docker SQLite/Postgres lifecycle regression for RQG-F010/F011.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOUND="$HOME/.pi/agent/extensions/trio-workflow/bounded-run.mjs"

# A direct invocation self-wraps the complete Docker lifecycle in the repository's
# process-group deadline helper. CI may set the marker when it supplies the same
# outer wrapper explicitly.
if [[ "${MARKHUB_BOUNDED_DOCKER_CHILD:-}" != "1" ]]; then
  test -f "$BOUND" || { echo "Missing deadline wrapper: $BOUND" >&2; exit 1; }
  exec env MARKHUB_BOUNDED_DOCKER_CHILD=1 node "$BOUND" \
    --timeout-ms 900000 --kill-after-ms 30000 -- bash "$0"
fi

cd "$ROOT"
COMPOSE_FILE="$ROOT/docker/docker-compose.integration.yml"
RUN_ID="$(date +%s)-$$"
PROJECT="markhub-it-${RUN_ID}"
export MARKHUB_TEST_IMAGE="markhub-integration:${RUN_ID}"
export DEFAULT_ADMIN_USERNAME="admin"
export DEFAULT_ADMIN_PASSWORD="Mh$(openssl rand -hex 12)!"
export JWT_SECRET="$(openssl rand -hex 32)"
export MARKHUB_MASTER_KEY="$(openssl rand -base64 32 | tr -d '\n')"
export POSTGRES_USER="markhub"
export POSTGRES_PASSWORD="$(openssl rand -hex 18)"
export POSTGRES_DB="markhub"

pick_port() {
  python3 - <<'PY'
import secrets
import socket

for _ in range(1000):
    port = 49152 + secrets.randbelow(65535 - 49152 + 1)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        sock.close()
        continue
    sock.close()
    print(port)
    break
else:
    raise SystemExit("no unused high loopback port")
PY
}

export MARKHUB_SQLITE_PORT="$(pick_port)"
export MARKHUB_POSTGRES_PORT="$(pick_port)"
while [[ "$MARKHUB_POSTGRES_PORT" == "$MARKHUB_SQLITE_PORT" ]]; do
  export MARKHUB_POSTGRES_PORT="$(pick_port)"
done
export MARKHUB_LEGACY_PORT="$(pick_port)"
while [[ "$MARKHUB_LEGACY_PORT" == "$MARKHUB_SQLITE_PORT" || "$MARKHUB_LEGACY_PORT" == "$MARKHUB_POSTGRES_PORT" ]]; do
  export MARKHUB_LEGACY_PORT="$(pick_port)"
done

compose() {
  docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" "$@"
}

CLEANED=0
cleanup() {
  local cleanup_status=0 down_status remaining port
  if [[ "$CLEANED" == "1" ]]; then
    return 0
  fi
  CLEANED=1
  set +e
  compose down --volumes --remove-orphans --timeout 20
  down_status=$?
  remaining="$(compose ps --all --quiet 2>/dev/null)"
  for port in "$MARKHUB_SQLITE_PORT" "$MARKHUB_POSTGRES_PORT" "$MARKHUB_LEGACY_PORT"; do
    if lsof -n -P -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Owned listener remained on 127.0.0.1:$port" >&2
      cleanup_status=1
    fi
  done
  if [[ "$down_status" -ne 0 || -n "$remaining" ]]; then
    echo "Compose cleanup failed for project $PROJECT (remaining: $remaining)" >&2
    cleanup_status=1
  fi
  if ! docker image rm "$MARKHUB_TEST_IMAGE" >/dev/null 2>&1; then
    echo "Could not remove owned image $MARKHUB_TEST_IMAGE" >&2
    cleanup_status=1
  fi
  set -e
  return "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

assert_unbound() {
  local port=$1
  if lsof -n -P -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Preflight failed: 127.0.0.1:$port became bound" >&2
    exit 1
  fi
}

wait_healthy() {
  local service=$1 port=$2
  local attempt container_id health
  for attempt in $(seq 1 90); do
    if curl --fail --silent --show-error --max-time 2 \
      "http://127.0.0.1:${port}/api/v1/health" >/dev/null 2>&1; then
      return 0
    fi
    container_id="$(compose ps --quiet "$service")"
    [[ -n "$container_id" ]] || { compose logs "$service"; return 1; }
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
    if [[ "$health" == "unhealthy" || "$health" == "exited" || "$health" == "dead" ]]; then
      compose logs "$service"
      return 1
    fi
    sleep 1
  done
  compose logs "$service"
  return 1
}

login_token() {
  local port=$1 response
  response="$(curl --fail --silent --show-error --max-time 5 \
    -H 'content-type: application/json' \
    --data "$(node -e 'process.stdout.write(JSON.stringify({username:process.env.DEFAULT_ADMIN_USERNAME,password:process.env.DEFAULT_ADMIN_PASSWORD}))')" \
    "http://127.0.0.1:${port}/api/v1/auth/login")"
  LOGIN_RESPONSE="$response" node -e '
    const body = JSON.parse(process.env.LOGIN_RESPONSE);
    if (!body.access_token || body.must_change_password) process.exit(1);
    process.stdout.write(body.access_token);
  '
}

create_bookmark() {
  local port=$1 marker=$2 token response
  token="$(login_token "$port")"
  response="$(curl --fail --silent --show-error --max-time 5 \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $token" \
    --data "$(MARKER="$marker" node -e 'process.stdout.write(JSON.stringify({title:process.env.MARKER,url:`https://${process.env.MARKER}.example/item`,visibility:"private"}))')" \
    "http://127.0.0.1:${port}/api/v1/bookmarks")"
  BOOKMARK_RESPONSE="$response" MARKER="$marker" node -e '
    const body = JSON.parse(process.env.BOOKMARK_RESPONSE);
    if (!body.id || body.title !== process.env.MARKER) process.exit(1);
  '
}

assert_bookmark() {
  local port=$1 marker=$2 token response
  token="$(login_token "$port")"
  response="$(curl --fail --silent --show-error --max-time 5 \
    -H "authorization: Bearer $token" \
    "http://127.0.0.1:${port}/api/v1/bookmarks?q=${marker}&limit=50")"
  BOOKMARK_RESPONSE="$response" MARKER="$marker" node -e '
    const body = JSON.parse(process.env.BOOKMARK_RESPONSE);
    if (!Array.isArray(body.items) || !body.items.some((item) => item.title === process.env.MARKER)) process.exit(1);
  '
}

echo "Docker integration project=$PROJECT sqlite_port=$MARKHUB_SQLITE_PORT postgres_port=$MARKHUB_POSTGRES_PORT legacy_port=$MARKHUB_LEGACY_PORT" >&2
compose version
compose build markhub-sqlite

# Actual image + SQLite volume: authenticate, write, restart, and prove persistence.
assert_unbound "$MARKHUB_SQLITE_PORT"
compose up --detach --no-build markhub-sqlite
wait_healthy markhub-sqlite "$MARKHUB_SQLITE_PORT"
export MARKHUB_E2E_BASE_URL="http://127.0.0.1:${MARKHUB_SQLITE_PORT}"
export MARKHUB_ADMIN_USERNAME="$DEFAULT_ADMIN_USERNAME"
export MARKHUB_ADMIN_PASSWORD="$DEFAULT_ADMIN_PASSWORD"
if [[ -d "$ROOT/.pw-browsers" ]]; then
  export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.pw-browsers"
fi
(
  cd apps/web
  pnpm exec playwright test e2e/smoke.spec.ts \
    --project=desktop-chromium \
    --grep='public navigation loads|login leaves /login'
)
create_bookmark "$MARKHUB_SQLITE_PORT" "sqlite-persist-${RUN_ID}"
compose restart --timeout 20 markhub-sqlite
wait_healthy markhub-sqlite "$MARKHUB_SQLITE_PORT"
assert_bookmark "$MARKHUB_SQLITE_PORT" "sqlite-persist-${RUN_ID}"

# Actual image + fresh Postgres chain: authenticate, write, restart, and persist.
assert_unbound "$MARKHUB_POSTGRES_PORT"
compose up --detach postgres
compose up --detach --no-build markhub-postgres
wait_healthy markhub-postgres "$MARKHUB_POSTGRES_PORT"
create_bookmark "$MARKHUB_POSTGRES_PORT" "postgres-persist-${RUN_ID}"
compose restart --timeout 20 markhub-postgres
wait_healthy markhub-postgres "$MARKHUB_POSTGRES_PORT"
assert_bookmark "$MARKHUB_POSTGRES_PORT" "postgres-persist-${RUN_ID}"

# Populated legacy database: install the baseline without a ledger, insert rows,
# then let the real application stamp 0001 and execute the remaining chain.
compose exec --no-TTY postgres psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 --command 'CREATE DATABASE markhub_legacy'
compose exec --no-TTY postgres psql --username "$POSTGRES_USER" --dbname markhub_legacy \
  --set ON_ERROR_STOP=1 < server/migrations/0001_init.postgres.sql
compose exec --no-TTY postgres psql --username "$POSTGRES_USER" --dbname markhub_legacy \
  --set ON_ERROR_STOP=1 <<'SQL'
INSERT INTO users (id, username, password_hash, must_change_password)
VALUES ('legacy-user', 'legacy-admin', 'not-used-by-this-check', FALSE);
INSERT INTO folders (id, user_id, name, visibility, is_system)
VALUES ('legacy-inbox', 'legacy-user', 'Legacy Inbox', 'private', TRUE);
INSERT INTO bookmarks (id, user_id, folder_id, title, url, url_normalized)
VALUES ('legacy-bookmark', 'legacy-user', 'legacy-inbox', 'Preserved legacy row',
        'https://legacy.example/item', 'https://legacy.example/item');
SQL

assert_unbound "$MARKHUB_LEGACY_PORT"
compose up --detach --no-build markhub-postgres-legacy
wait_healthy markhub-postgres-legacy "$MARKHUB_LEGACY_PORT"
compose exec --no-TTY postgres psql --username "$POSTGRES_USER" --dbname markhub_legacy \
  --set ON_ERROR_STOP=1 --tuples-only --command \
  "SELECT CASE WHEN COUNT(*) = 1 THEN 'ok' ELSE 'bad' END FROM bookmarks WHERE id = 'legacy-bookmark'" \
  | tr -d '[:space:]' | grep -qx ok
compose exec --no-TTY postgres psql --username "$POSTGRES_USER" --dbname markhub_legacy \
  --set ON_ERROR_STOP=1 --tuples-only --command \
  "SELECT CASE WHEN COUNT(*) = 2 THEN 'ok' ELSE 'bad' END FROM schema_migrations WHERE version IN ('0001_init', '0002_fk_constraints')" \
  | tr -d '[:space:]' | grep -qx ok
if compose exec --no-TTY postgres psql --username "$POSTGRES_USER" --dbname markhub_legacy \
  --set ON_ERROR_STOP=1 --command \
  "INSERT INTO bookmarks (id, user_id, folder_id, title, url, url_normalized) VALUES ('bad-fk', 'legacy-user', 'missing-folder', 'bad', 'https://bad.example', 'https://bad.example')"; then
  echo "Postgres accepted an orphan bookmark after migration" >&2
  exit 1
fi

echo "Docker SQLite/Postgres integration passed for project $PROJECT" >&2
