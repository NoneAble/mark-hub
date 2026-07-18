#!/usr/bin/env bash
# Single release gate (MH-TEST-001): every suite that must pass before a
# release, in one entry point. CI and final acceptance call ONLY this.
# Skip the slow 50k restore gate with MARKHUB_RELEASE_SKIP_LARGE=1 (dev loops).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PYTHON="$ROOT/server/.venv/bin/python"
[[ -x "$PYTHON" ]] || PYTHON="$(command -v python3)"

PASSED=()
run_gate() {
  local name=$1
  shift
  echo "=== release gate: $name ===" >&2
  local started=$SECONDS
  if ! "$@"; then
    echo "=== release gate FAILED: $name (after $((SECONDS - started))s) ===" >&2
    echo "gates passed before failure: ${PASSED[*]:-none}" >&2
    exit 1
  fi
  PASSED+=("$name")
  echo "=== release gate passed: $name ($((SECONDS - started))s) ===" >&2
}

run_gate "lint:ts"        pnpm -r --if-present run lint
run_gate "lint:python"    bash -c "cd server && '$PYTHON' -m ruff check app tests"
run_gate "core-unit"      pnpm --filter @markhub/core test
run_gate "worker-suite"   pnpm --filter @markhub/worker test
run_gate "server-pytest"  bash -c "cd server && '$PYTHON' -m pytest -q"
run_gate "e2e-browser"    bash scripts/e2e-smoke.sh
run_gate "docker-deploy"  bash scripts/test-docker-deploy.sh
if [[ "${MARKHUB_RELEASE_SKIP_LARGE:-0}" != "1" ]]; then
  run_gate "worker-50k-restore" pnpm --filter @markhub/worker run test:runtime:large
else
  echo "=== release gate SKIPPED by request: worker-50k-restore ===" >&2
fi

echo "=== release gates all passed: ${PASSED[*]} ===" >&2
