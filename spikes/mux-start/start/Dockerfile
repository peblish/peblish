# node:24-bookworm-slim, pinned to the patch release the cached image resolves to.
FROM node:24.21.0-bookworm-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# The dev target is the deps stage with the source bind-mounted (see compose.yaml).
FROM deps AS dev
CMD ["pnpm", "dev"]

FROM deps AS build
COPY . .
# Build first: the router plugin writes src/routeTree.gen.ts, which the typecheck reads.
RUN pnpm build && pnpm typecheck

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/.output ./.output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
