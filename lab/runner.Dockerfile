# syntax=docker/dockerfile:1
# The interop runner and the rogue peer: tools/interop with its workspace dependencies, on the
# same Node as the product image. Context is the repository root (compose `context: ..`).
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /app

# Keyed on the lockfile only, as the product image's deps stage is.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY vendor/muxui/ ./vendor/muxui/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm fetch --frozen-lockfile

FROM deps AS runner
COPY . .
# Offline: only @peblish/interop and what it depends on (core, federation, schema).
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --offline --frozen-lockfile --filter '@peblish/interop...'
# The glob registries (policies, consumers, jobs) are generated, not committed.
RUN node scripts/gen.ts
WORKDIR /app/tools/interop
ENV NODE_ENV=production INTEROP_RESULTS_DIR=/results
CMD ["node", "src/run.ts"]
