#!/bin/sh
# Image entrypoint: `web` (default) serves HTTP on $PORT, `worker` runs the outbox
# consumers, `migrate` applies the migrations (and creates the local instance row from
# PUBLIC_ORIGIN). Anything else is executed as given.
set -e
case "${1:-web}" in
  web) exec node /app/.output/server/index.mjs ;;
  worker) exec node --enable-source-maps /app/processes/worker.mjs ;;
  migrate) exec node --enable-source-maps /app/processes/migrate.mjs ;;
  *) exec "$@" ;;
esac
