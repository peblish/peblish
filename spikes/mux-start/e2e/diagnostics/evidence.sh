#!/bin/sh
# Regenerates every artifact against a running server (default: the production container).
# Usage: sh diagnostics/evidence.sh [baseURL] [artifact prefix]
set -eu
cd "$(dirname "$0")/.."
BASE_URL="${1:-http://127.0.0.1:18110}"
PREFIX="${2:-start}"
export BASE_URL

rm -rf "artifacts/$PREFIX" "artifacts/$PREFIX-repeat" test-results
ARTIFACT_PREFIX="$PREFIX" pnpm exec playwright test
ARTIFACT_PREFIX="$PREFIX-repeat" pnpm exec playwright test tests/first-click.spec.ts --repeat-each=5
# Clicks right after the shell marker (route content may still be dehydrated), then after the page marker.
ARTIFACT_PREFIX="$PREFIX" MARKER=shell PATHS=/gate,/gate-quiet DELAYS=0,250 node diagnostics/first-click-probe.mjs "$BASE_URL" 6
ARTIFACT_PREFIX="$PREFIX" MARKER=page PATHS=/gate,/gate-quiet,/gate-plain DELAYS=0 node diagnostics/first-click-probe.mjs "$BASE_URL" 6
