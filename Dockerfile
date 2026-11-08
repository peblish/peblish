# syntax=docker/dockerfile:1
# One image, three processes selected by command: web (default), worker, migrate.
# node:24-bookworm-slim, pinned to the patch release the mux-start spike verified.
FROM node:24.21.0-bookworm-slim AS base
# CI=true lets pnpm replace the modules directory pnpm fetch created without asking.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /app

# Dependencies first, keyed on the lockfile only: pnpm fetch fills the store without the
# package manifests, so source changes keep this layer cached.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm fetch --frozen-lockfile

FROM deps AS build
COPY . .
# vendor/ (the packed Mux rc, once the MUX lane delivers it) arrives with the source above.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm build

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 PEBLISH_MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /app/packages/web/.output ./.output
COPY --from=build /app/packages/web/dist/processes ./processes
COPY --from=build /app/packages/core/drizzle ./migrations
COPY deploy/entrypoint.sh /usr/local/bin/peblish
USER node
EXPOSE 3000
ENTRYPOINT ["peblish"]
CMD ["web"]
