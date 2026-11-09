#!/bin/sh
# Image entrypoint. PEBLISH_PROCESS (container environment, default web) names the process:
# `web` serves HTTP on $PORT, `worker` runs the outbox consumers, `migrate` applies the
# migrations (and creates the local instance row from PUBLIC_ORIGIN). A command argument may
# repeat it (`peblish worker`) but must agree, because the healthcheck reads the variable:
# a worker that a healthcheck took for web would be probed on a port it never opens.
# Anything else is executed as given.
set -e
process=${1:-${PEBLISH_PROCESS:-}}
case "$process" in
  web | worker | migrate)
    if [ "$process" != "${PEBLISH_PROCESS:-}" ]; then
      echo "peblish: '$process' needs PEBLISH_PROCESS=$process in the container environment (the healthcheck reads it)" >&2
      exit 64
    fi
    ;;
esac
case "$process" in
  web) exec node /app/.output/server/index.mjs ;;
  worker) exec node --enable-source-maps /app/processes/worker.mjs ;;
  migrate) exec node --enable-source-maps /app/processes/migrate.mjs ;;
  '') echo 'peblish: set PEBLISH_PROCESS to web, worker or migrate' >&2; exit 64 ;;
  *) exec "$@" ;;
esac
