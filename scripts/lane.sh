#!/bin/sh
# Per-lane environment on the shared dev Postgres (compose.yaml). Creates the lane's
# database peblish_<lane> if needed, applies the migrations, and prints the exports:
#
#   eval "$(sh scripts/lane.sh az)"
#
# Ports come from the Phase 1 plan's table (G0 18300 ... root 18399); spike ports
# 18100-18299 are never used. Tests recreate peblish_<lane>_test themselves.
set -eu

lane=$(printf '%s' "${1:?usage: sh scripts/lane.sh <lane>}" | tr 'A-Z-' 'a-z_')
case "$lane" in
  g0) port=18300 ;; az) port=18301 ;; a) port=18302 ;; fit) port=18303 ;; md) port=18304 ;;
  ui) port=18305 ;; b1) port=18306 ;; b2) port=18307 ;; f) port=18308 ;; fed_a) port=18309 ;;
  fed_b) port=18310 ;; rem) port=18311 ;; d) port=18312 ;; c1) port=18313 ;; composer) port=18314 ;;
  e1) port=18315 ;; e2) port=18316 ;; disc) port=18317 ;; safe) port=18318 ;; rep) port=18319 ;;
  modf) port=18320 ;; adm) port=18321 ;; lab) port=18322 ;; b06) port=18323 ;; root) port=18399 ;;
  *) echo "lane.sh: unknown lane '$1'" >&2; exit 1 ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd)
compose="docker compose -f $root/compose.yaml"
db="peblish_$lane"
host=$(printf '%s' "$lane" | tr '_' '-')
server="postgres://peblish:peblish@127.0.0.1:18432"

$compose up -d --wait postgres >&2
exists=$($compose exec -T postgres psql -U peblish -d peblish -tAc "select 1 from pg_database where datname = '$db'")
[ "$exists" = 1 ] || $compose exec -T postgres createdb -U peblish "$db" >&2
DATABASE_URL="$server/$db" PUBLIC_ORIGIN="https://$host.peblish.test" pnpm --dir "$root" --silent db:migrate >&2

cat <<ENV
export PEBLISH_LANE=$lane
export PORT=$port
export DATABASE_URL=$server/$db
export TEST_DATABASE_URL=$server/${db}_test
export PUBLIC_ORIGIN=https://$host.peblish.test
export SMTP_URL=smtp://127.0.0.1:18425
export S3_ENDPOINT=http://127.0.0.1:18490
export S3_BUCKET=peblish-$host
ENV
