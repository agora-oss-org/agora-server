# syntax=docker/dockerfile:1
# Built from the REPO ROOT as context (the moderator depends on the @agora-server/contract workspace pkg):
#   docker build -f apps/moderator/Dockerfile -t agora-moderator .

# ── Builder: install workspace deps, build @agora-server/contract then @agora/moderator ─────
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /repo

# Root manifests + lockfile, then full source for the moderator + its @agora-server/contract workspace dep.
# Source is copied BEFORE install so pnpm links @agora-server/contract into apps/moderator/node_modules.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages/contract ./packages/contract
COPY apps/moderator ./apps/moderator
RUN pnpm install --frozen-lockfile --filter @agora/moderator...

# Build contract before the moderator (topological).
RUN pnpm --filter @agora-server/contract build && pnpm --filter @agora/moderator build

# Self-contained, prod-only deployment (flattens the workspace:* @agora-server/contract dependency into
# real files — no pnpm store / symlinks at runtime). --legacy: pnpm v10 gates non-injected deploys.
RUN pnpm deploy --filter=@agora/moderator --legacy --prod /out

# ── Runtime: the pruned standalone only ────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV MODERATOR_PORT=4001
ENV LOG_CONSOLE=json
ENV LOG_LEVEL=info
# OpenTelemetry exporters default to a local collector. Set OTEL_*_ENDPOINT to your collector in
# deployment, or OTEL_SDK_DISABLED=true to turn telemetry off. Prometheus metrics are on :9465.
WORKDIR /app

# /out carries package.json, dist/, node_modules/ (incl. @agora-server/contract).
COPY --from=builder /out ./
# Guarantee the logging config is present (lives at the app root, outside dist/). lib/logger.ts
# resolves it module-relative → /app/wonder-logger.yaml.
COPY --from=builder /repo/apps/moderator/wonder-logger.yaml ./wonder-logger.yaml

USER node
EXPOSE 4001
EXPOSE 9465

# Liveness probe against the app's /health endpoint (uses Node's built-in fetch).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MODERATOR_PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
