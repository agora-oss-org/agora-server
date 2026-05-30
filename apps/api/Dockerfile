# syntax=docker/dockerfile:1
# Built from the REPO ROOT as context (the api depends on the @agora/contract workspace package):
#   docker build -f apps/api/Dockerfile -t agora-api .

# ── Builder: install workspace deps, build @agora/contract then @agora/api ─────
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /repo

# Root manifests + lockfile, then full source for the api + its @agora/contract workspace dep.
# Source is copied BEFORE install so pnpm links @agora/contract into apps/api/node_modules.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages/contract ./packages/contract
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @agora/api...

# Build contract before the api (topological).
RUN pnpm --filter @agora/contract build && pnpm --filter @agora/api build

# Self-contained, prod-only deployment for the api (flattens the workspace:* @agora/contract
# dependency into real files — no pnpm store / symlinks at runtime).
# --legacy: pnpm v10 gates non-injected deploys behind this flag (flattens the workspace
# @agora/contract dep into /out/node_modules as real files — exactly what a standalone image needs).
RUN pnpm deploy --filter=@agora/api --legacy --prod /out

# ── Runtime: the pruned standalone only ────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV PORT=4000
ENV LOG_CONSOLE=json
WORKDIR /app

# /out carries package.json, dist/, node_modules/ (incl. @agora/contract), drizzle/ + scripts/.
COPY --from=builder /out ./
# Guarantee the logging config is present (lives at the app root, outside dist/). lib/logger.ts
# resolves it module-relative → /app/wonder-logger.yaml.
COPY --from=builder /repo/apps/api/wonder-logger.yaml ./wonder-logger.yaml

USER node
EXPOSE 4000

# Liveness probe against the app's /health endpoint (uses Node's built-in fetch).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
