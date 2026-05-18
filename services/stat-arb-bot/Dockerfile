# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the @sotama/stat-arb-bot Fly app.
# The Dockerfile is invoked from the REPO ROOT as build context so the
# parent pnpm-workspace.yaml and sister packages/* are present:
#
#   fly deploy --config services/stat-arb-bot/fly.toml \
#              --dockerfile services/stat-arb-bot/Dockerfile

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN npm i -g pnpm@9.15.4

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/market-core/package.json packages/market-core/
COPY packages/db/package.json packages/db/
COPY services/stat-arb-bot/package.json services/stat-arb-bot/
# tsconfigs are needed for build, copy them now so layer caching works
COPY tsconfig.base.json ./

RUN pnpm install --frozen-lockfile \
    --filter '@sotama/market-core...' \
    --filter '@sotama/db...' \
    --filter '@sotama/stat-arb-bot...'

# ── Build stage ──────────────────────────────────────────────────────
FROM deps AS build
COPY packages/market-core packages/market-core
COPY packages/db packages/db
COPY services/stat-arb-bot services/stat-arb-bot

# Build in topological order: market-core → db (composite ref pulls
# market-core's d.ts) → stat-arb-bot.
RUN pnpm --filter '@sotama/stat-arb-bot' run build

# ── Runtime stage ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy compiled output + the production-only node_modules from the build
# stage. We carry the whole workspace's node_modules because pnpm uses a
# content-addressable store that hard-links into the workspace.
COPY --from=build /app /app

WORKDIR /app/services/stat-arb-bot
EXPOSE 8080
CMD ["node", "dist/index.js"]
