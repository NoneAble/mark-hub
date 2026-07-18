#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BOUNDED_RUN="${REPO_ROOT}/scripts/lib/bounded-run.mjs"

if [[ ! -f "${BOUNDED_RUN}" ]]; then
  echo "required bounded-run helper missing: ${BOUNDED_RUN}" >&2
  exit 2
fi

# The harness generates a disposable config without an assets binding, so a
# clean checkout does not depend on apps/web/dist or a prior frontend build.
# Override the watchdog for long runs (e.g. the 50k large-restore gate).
exec node "${BOUNDED_RUN}" \
  --timeout-ms "${MARKHUB_RUNTIME_TIMEOUT_MS:-480000}" \
  --kill-after-ms 5000 \
  -- node "${SCRIPT_DIR}/worker-d1-runtime-test.mjs" "$@"
