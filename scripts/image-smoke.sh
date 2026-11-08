#!/bin/sh
# Boots the image's three commands against a Postgres the containers reach on <network>:
# migrate, then worker (it starts, stops on SIGTERM and exits 0), then web (/healthz and
# /readyz answer, and it runs as a non-root user). CI's image job runs it; locally:
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

echo 'image-smoke: migrate'
docker run --rm --network "$network" -e DATABASE_URL="$url" -e PUBLIC_ORIGIN=https://ci.peblish.test "$image" migrate

echo 'image-smoke: worker'
docker run -d --name "$worker" --network "$network" -e DATABASE_URL="$url" "$image" worker >/dev/null
started=no
for _ in $(seq 1 30); do
  if docker logs "$worker" 2>&1 | grep -q 'worker: running outbox consumers'; then started=yes; break; fi
  sleep 1
done
[ "$started" = yes ] || fail 'worker did not start'
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
curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null || fail 'web is not ready against the migrated database'
uid=$(docker exec "$web" id -u)
[ "$uid" != 0 ] || fail 'web runs as root'
echo "image-smoke: ok (web uid $uid)"
