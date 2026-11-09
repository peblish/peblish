#!/bin/sh
# Boots the image's three processes against a Postgres the containers reach on <network>:
# migrate, then worker (it starts, its healthcheck passes, it stops on SIGTERM and exits 0),
# then web (/healthz and /readyz answer, the healthcheck passes and fails on a closed port,
# and it runs as a non-root user). First, a process command that disagrees with
# PEBLISH_PROCESS must be refused. CI's image job runs it; locally:
#
#   sh scripts/image-smoke.sh peblish:local peblish-dev_default \
#     postgres://peblish:peblish@postgres:5432/peblish_g0 18388
set -eu
image=${1:?usage: sh scripts/image-smoke.sh <image> <network> <database-url> [host-port]}
network=${2:?usage: sh scripts/image-smoke.sh <image> <network> <database-url> [host-port]}
url=${3:?usage: sh scripts/image-smoke.sh <image> <network> <database-url> [host-port]}
port=${4:-3000}
worker=peblish-smoke-worker
web=peblish-smoke-web

fail() {
  echo "image-smoke: $1" >&2
  for name in "$worker" "$web"; do docker logs "$name" 2>&1 | sed "s/^/$name: /" >&2 || true; done
  exit 1
}
cleanup() { docker rm -f "$worker" "$web" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo 'image-smoke: a process command that disagrees with PEBLISH_PROCESS is refused'
status=0
docker run --rm "$image" worker >/dev/null 2>&1 || status=$?
[ "$status" = 64 ] || fail "worker without PEBLISH_PROCESS=worker exited $status, expected 64"

echo 'image-smoke: migrate'
docker run --rm --network "$network" -e PEBLISH_PROCESS=migrate -e DATABASE_URL="$url" -e PUBLIC_ORIGIN=https://ci.peblish.test "$image"

echo 'image-smoke: worker'
docker run -d --name "$worker" --network "$network" -e PEBLISH_PROCESS=worker -e DATABASE_URL="$url" "$image" >/dev/null
started=no
for _ in $(seq 1 30); do
  if docker logs "$worker" 2>&1 | grep -q 'worker: running outbox consumers'; then started=yes; break; fi
  sleep 1
done
[ "$started" = yes ] || fail 'worker did not start'
docker exec "$worker" node /app/healthcheck.mjs || fail 'the healthcheck failed for a running worker'
docker stop -t 15 "$worker" >/dev/null
docker logs "$worker" 2>&1 | grep -q 'worker: stopped' || fail 'worker did not stop cleanly on SIGTERM'
[ "$(docker inspect -f '{{.State.ExitCode}}' "$worker")" = 0 ] || fail 'worker exited non-zero'

echo 'image-smoke: web'
docker run -d --name "$web" --network "$network" -p "127.0.0.1:$port:3000" -e DATABASE_URL="$url" "$image" >/dev/null
healthy=no
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then healthy=yes; break; fi
  sleep 1
done
[ "$healthy" = yes ] || fail 'web did not answer /healthz'
docker exec "$web" node /app/healthcheck.mjs || fail 'the healthcheck failed for a serving web'
status=0
docker exec -e PORT=1 "$web" node /app/healthcheck.mjs >/dev/null 2>&1 || status=$?
[ "$status" = 1 ] || fail "the healthcheck exited $status probing a closed port, expected 1"
curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null || fail 'web is not ready against the migrated database'
uid=$(docker exec "$web" id -u)
[ "$uid" != 0 ] || fail 'web runs as root'
echo "image-smoke: ok (web uid $uid)"
