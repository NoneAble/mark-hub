#!/usr/bin/env bash
# Build/serve the SPA and run the release browser journey without repository-local output.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOUNDED_RUN="$ROOT/scripts/lib/bounded-run.mjs"

if [[ "${MARKHUB_E2E_BOUNDED:-}" != "1" ]]; then
  [[ -f "$BOUNDED_RUN" ]] || { echo "bounded-run missing: $BOUNDED_RUN" >&2; exit 1; }
  exec env MARKHUB_E2E_BOUNDED=1 node "$BOUNDED_RUN" \
    --timeout-ms 300000 --kill-after-ms 10000 -- bash "$0"
fi

cd "$ROOT"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/markhub-browser-e2e.XXXXXX")"
WEB_DIST="$TEMP_ROOT/web-dist"
SPA_MARKER="markhub-browser-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
OWNED_PIDS=()
OWNED_PGIDS=()
OWNED_PORTS=()
RESERVED_PORTS=()

cleanup_owned() {
  local pid port attempt cleanup_status=0
  for pid in "${OWNED_PIDS[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${OWNED_PIDS[@]:-}"; do
    [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
  done
  for port in "${OWNED_PORTS[@]:-}"; do
    for attempt in $(seq 1 50); do
      if [[ -z "$port" ]] || ! lsof -n -P -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if [[ -n "$port" ]] && lsof -n -P -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "owned listener still bound after cleanup: 127.0.0.1:$port" >&2
      cleanup_status=1
    fi
  done
  OWNED_PIDS=()
  OWNED_PGIDS=()
  OWNED_PORTS=()
  return "$cleanup_status"
}

cleanup() {
  local status=$?
  local cleanup_status
  set +e
  cleanup_owned
  cleanup_status=$?
  rm -rf "$TEMP_ROOT"
  set -e
  if [[ "$status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
    status=$cleanup_status
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

pick_port() {
  local candidate seen port
  for _ in $(seq 1 256); do
    candidate="$(python3 - <<'PY'
import random
import socket

for _ in range(256):
    port = random.randint(49152, 65535)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        sock.close()
        continue
    sock.close()
    print(port)
    break
PY
)"
    [[ -n "$candidate" ]] || continue
    seen=0
    for port in "${OWNED_PORTS[@]:-}" "${RESERVED_PORTS[@]:-}"; do
      [[ "$port" == "$candidate" ]] && seen=1
    done
    if [[ "$seen" -eq 0 ]] && ! lsof -n -P -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "could not preflight a unique high loopback port" >&2
  return 1
}

assert_unbound() {
  local port=$1
  if lsof -n -P -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "preflight failed: 127.0.0.1:$port became bound" >&2
    return 1
  fi
}

start_daemon() {
  local port=$1 log_file=$2
  shift 2
  assert_unbound "$port"
  set -m
  node "$BOUNDED_RUN" --timeout-ms 150000 --kill-after-ms 5000 -- "$@" \
    >"$log_file" 2>&1 &
  local pid=$!
  set +m
  local pgid
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || printf '%s' "$pid")"
  OWNED_PIDS+=("$pid")
  OWNED_PGIDS+=("$pgid")
  OWNED_PORTS+=("$port")
}

wait_api() {
  local port=$1 log_file=$2
  for _ in $(seq 1 80); do
    if curl --fail --silent --show-error --max-time 2 \
      "http://127.0.0.1:${port}/api/v1/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  sed -n '1,240p' "$log_file" >&2
  return 1
}

wait_spa() {
  local port=$1 log_file=$2 body
  for _ in $(seq 1 80); do
    body="$(curl --fail --silent --show-error --max-time 2 \
      "http://127.0.0.1:${port}/" 2>/dev/null || true)"
    if [[ "$body" == *"$SPA_MARKER"* ]]; then
      return 0
    fi
    sleep 0.1
  done
  sed -n '1,240p' "$log_file" >&2
  return 1
}

PYTHON="$ROOT/server/.venv/bin/python"
[[ -x "$PYTHON" ]] || PYTHON="$(command -v python3)"

echo "E2E: building temporary SPA at $WEB_DIST" >&2
node "$ROOT/apps/worker/scripts/build-temp-spa.mjs" "$WEB_DIST" "$SPA_MARKER"

if [[ -d "$ROOT/.pw-browsers" ]]; then
  export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.pw-browsers"
fi
export MARKHUB_ADMIN_USERNAME="admin"
export MARKHUB_ADMIN_PASSWORD="${MARKHUB_ADMIN_PASSWORD:-admin123}"
export MARKHUB_NEW_PASSWORD="${MARKHUB_NEW_PASSWORD:-E2eAdminPass99!}"

for project in desktop-chromium mobile-chromium; do
  API_PORT="$(pick_port)"
  RESERVED_PORTS+=("$API_PORT")
  PREVIEW_PORT="$(pick_port)"
  RESERVED_PORTS=()
  DB="$TEMP_ROOT/${project}.db"
  API_LOG="$TEMP_ROOT/${project}-api.log"
  PREVIEW_LOG="$TEMP_ROOT/${project}-preview.log"

  export DATABASE_URL="sqlite+aiosqlite:///${DB}"
  export JWT_SECRET="e2e-jwt-secret-markhub-2026"
  export MARKHUB_MASTER_KEY="e2e-master-key-32-bytes-long!!"
  export DEFAULT_ADMIN_USERNAME="admin"
  export DEFAULT_ADMIN_PASSWORD="$MARKHUB_ADMIN_PASSWORD"
  export FORCE_ADMIN_PASSWORD_CHANGE="true"
  export ALLOW_INSECURE_DEFAULTS="true"
  export MARKHUB_TESTING="1"

  start_daemon "$API_PORT" "$API_LOG" \
    "$PYTHON" -m uvicorn app.main:app --app-dir "$ROOT/server" --host 127.0.0.1 --port "$API_PORT"
  wait_api "$API_PORT" "$API_LOG"

  export MARKHUB_E2E_API_URL="http://127.0.0.1:${API_PORT}"
  export MARKHUB_E2E_WEB_DIST="$WEB_DIST"
  start_daemon "$PREVIEW_PORT" "$PREVIEW_LOG" \
    "$ROOT/apps/web/node_modules/.bin/vite" preview "$ROOT/apps/web" \
      --config "$ROOT/apps/web/playwright.preview.config.mjs" --configLoader native \
      --outDir "$WEB_DIST" --host 127.0.0.1 --port "$PREVIEW_PORT" --strictPort
  wait_spa "$PREVIEW_PORT" "$PREVIEW_LOG"

  export MARKHUB_E2E_BASE_URL="http://127.0.0.1:${PREVIEW_PORT}"
  export MARKHUB_E2E_OUTPUT_ROOT="$TEMP_ROOT/playwright/${project}"
  echo "E2E: running $project on owned preview port $PREVIEW_PORT" >&2
  set +e
  node "$BOUNDED_RUN" --timeout-ms 90000 --kill-after-ms 5000 -- \
    pnpm --dir "$ROOT/apps/web" exec playwright test e2e/smoke.spec.ts \
      --grep '@release' --project="$project"
  PROJECT_STATUS=$?
  set -e
  if [[ "$PROJECT_STATUS" -ne 0 ]]; then
    sed -n '1,240p' "$API_LOG" >&2
    sed -n '1,240p' "$PREVIEW_LOG" >&2
  fi
  cleanup_owned
  [[ "$PROJECT_STATUS" -eq 0 ]] || exit "$PROJECT_STATUS"
done

echo "E2E: desktop and mobile release journeys passed" >&2
