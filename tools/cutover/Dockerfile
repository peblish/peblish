# syntax=docker/dockerfile:1
# The cutover tool as a temporary service inside an Easypanel project (deploy/cutover.md): it
# reaches the project's Postgres on the internal network, so the database is never exposed and
# no tunnel is opened. Build context is the repository root (the same uploaded archive as web
# and worker), with this file as the Dockerfile. It runs nothing by itself: the operator runs
# the commands in its console, and the service is destroyed when the run is done. No bundle,
# key or secret is ever part of the image.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
# pg_dump and pg_restore must be the server's major version (17) or newer for the drill; Debian
# bookworm ships 15, so they come from the PostgreSQL project's apt repository. psql and curl
# serve the console steps (site settings, Mailpit).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY vendor/muxui/ ./vendor/muxui/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm fetch --frozen-lockfile

FROM deps AS tool
COPY . .
# Only the tool and what it depends on (core, federation, schema), offline from the fetched store.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --offline --frozen-lockfile --filter '@peblish/cutover...'
# The glob registries (policies, consumers, jobs, events) are generated, not committed.
RUN node scripts/gen.ts && chown -R node:node /app
USER node
# Files the operator writes in the console (the bundle, backups) go under /tmp/cutover, mode 700.
RUN install -d -m 700 /tmp/cutover
CMD ["sleep", "infinity"]
