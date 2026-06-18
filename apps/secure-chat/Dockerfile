# syntax=docker/dockerfile:1
# Built from the REPO ROOT as context (secure-chat depends on the @agora/core + @agora-server/contract
# workspace packages):
#   docker build -f apps/secure-chat/Dockerfile -t agora-secure-chat .

# ── Builder: install workspace deps, build contract → core → secure-chat ─────
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /repo

# Root manifests + lockfile, then full source for secure-chat + its workspace deps (@agora-server/contract
# + @agora/core). Source is copied BEFORE install so pnpm links them into node_modules.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages/contract ./packages/contract
COPY packages/core ./packages/core
COPY apps/secure-chat ./apps/secure-chat
RUN pnpm install --frozen-lockfile --filter @agora/secure-chat...

# Build the workspace lib deps before the app (topological: contract → core → secure-chat).
RUN pnpm --filter @agora-server/contract build && pnpm --filter @agora/core build && pnpm --filter @agora/secure-chat build

# Self-contained, prod-only deployment (flattens the workspace:* deps into real files — no pnpm
# store / symlinks at runtime). --legacy: pnpm v10 gates non-injected deploys behind this flag.
RUN pnpm deploy --filter=@agora/secure-chat --legacy --prod /out

# ── Runtime: the pruned standalone only ────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV SECURE_CHAT_PORT=4002
ENV LOG_CONSOLE=json
ENV LOG_LEVEL=info
WORKDIR /app

# /out carries package.json, dist/, node_modules/ (incl. @agora-server/contract + @agora/core) + scripts/.
COPY --from=builder /out ./
# The logger lives in @agora/core and resolves wonder-logger.yaml module-relative to the core package
# root. pnpm deploy includes it via core's "files", but COPY it explicitly as a guarantee
# (createLoggerFromConfig is required:true → crash if the config is missing).
COPY --from=builder /repo/packages/core/wonder-logger.yaml ./node_modules/@agora/core/wonder-logger.yaml

USER node
EXPOSE 4002

# Liveness probe against /health — which returns 503 until the Redis suspension index has hydrated, so
# the orchestrator won't route traffic to a not-yet-ready (fail-open-risk) instance.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SECURE_CHAT_PORT||4002)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
