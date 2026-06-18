# syntax=docker/dockerfile:1
# Built from the REPO ROOT as context (the api depends on the @agora-server/contract workspace package):
#   docker build -f apps/api/Dockerfile -t agora-api .

# ── Builder: install workspace deps, build @agora-server/contract then @agora/api ─────
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /repo

# Root manifests + lockfile, then full source for the api + its workspace deps (@agora-server/contract
# + @agora/core — the shared kernel). Source is copied BEFORE install so pnpm links them into node_modules.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages/contract ./packages/contract
COPY packages/core ./packages/core
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @agora/api...

# Build the workspace lib deps before the api (topological: contract → core → api).
RUN pnpm --filter @agora-server/contract build && pnpm --filter @agora/core build && pnpm --filter @agora/api build

# Self-contained, prod-only deployment for the api (flattens the workspace:* @agora-server/contract
# dependency into real files — no pnpm store / symlinks at runtime).
# --legacy: pnpm v10 gates non-injected deploys behind this flag (flattens the workspace
# @agora-server/contract dep into /out/node_modules as real files — exactly what a standalone image needs).
RUN pnpm deploy --filter=@agora/api --legacy --prod /out

# ── Runtime: the pruned standalone only ────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV PORT=4000
ENV LOG_CONSOLE=json
ENV LOG_LEVEL=info
# OpenTelemetry exporters default to a local collector. Set OTEL_*_ENDPOINT to your collector in
# deployment, or OTEL_SDK_DISABLED=true to turn telemetry off. Prometheus metrics are on :9464.
WORKDIR /app

# /out carries package.json, dist/, node_modules/ (incl. @agora-server/contract + @agora/core), drizzle/ + scripts/.
COPY --from=builder /out ./
# The logger now lives in @agora/core and resolves wonder-logger.yaml module-relative to the core package
# root (node_modules/@agora/core/wonder-logger.yaml). pnpm deploy includes it via core's "files", but COPY
# it explicitly as a guarantee (createLoggerFromConfig is required:true → crash if the config is missing).
COPY --from=builder /repo/packages/core/wonder-logger.yaml ./node_modules/@agora/core/wonder-logger.yaml

USER node
EXPOSE 4000
EXPOSE 9464

# Liveness probe against the app's /health endpoint (uses Node's built-in fetch).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
