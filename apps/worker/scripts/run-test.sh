#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOUNDED_RUN="${HOME}/.pi/agent/extensions/trio-workflow/bounded-run.mjs"

if [[ ! -f "${BOUNDED_RUN}" ]]; then
  echo "required bounded-run helper missing: ${BOUNDED_RUN}" >&2
  exit 2
fi

# The harness generates a disposable config without an assets binding, so a
# clean checkout does not depend on apps/web/dist or a prior frontend build.
exec node "${BOUNDED_RUN}" \
  --timeout-ms 300000 \
  --kill-after-ms 5000 \
  -- node "${SCRIPT_DIR}/worker-d1-runtime-test.mjs" "$@"
