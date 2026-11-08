# syntax=docker/dockerfile:1
# One image, three processes selected by command: web (default), worker, migrate.
# node:24-bookworm-slim, pinned to the patch release the mux-start spike verified and to its
# digest (Renovate docker:pinDigests moves both).
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
# CI=true lets pnpm replace the modules directory pnpm fetch created without asking.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /app

# Dependencies first, keyed on the lockfile only: pnpm fetch fills the store without the
# package manifests, so source changes keep this layer cached.
# vendor/muxui/ holds the packed Mux rc once root swaps it in (vendor/muxui/README.md): a
# file: tarball dependency must be in the context before pnpm fetch reads the lockfile.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY vendor/muxui/ ./vendor/muxui/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm fetch --frozen-lockfile

FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm build

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 PEBLISH_MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /app/packages/web/.output ./.output
COPY --from=build /app/packages/web/dist/processes ./processes
COPY --from=build /app/packages/core/drizzle ./migrations
COPY deploy/entrypoint.sh /usr/local/bin/peblish
COPY deploy/healthcheck.mjs ./healthcheck.mjs
USER node
EXPOSE 3000
# Probes /healthz when the container runs web; worker and migrate containers pass (see the
# script and deploy/README.md). The image has no curl, so node does the request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "/app/healthcheck.mjs"]
ENTRYPOINT ["peblish"]
CMD ["web"]
