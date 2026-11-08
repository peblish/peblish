# Node 24 runs the TypeScript sources directly (type stripping), no build step.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scenarios ./scenarios
ENV NODE_ENV=production
EXPOSE 8000
CMD ["node", "src/main.ts"]
