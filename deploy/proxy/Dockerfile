# syntax=docker/dockerfile:1
# Single front-door image for Agora: Caddy + the admin SPA static build baked in. Caddy serves the
# SPA AND reverse-proxies every service (see deploy/proxy/agora-routes.caddy) — it replaces the old
# admin nginx. Built from the REPO ROOT as context (the admin build depends on the
# @agora-server/contract workspace package):
#   docker build -f deploy/proxy/Dockerfile -t agora-proxy .

# ── Builder: build @agora-server/contract, then the admin SPA (Vite → static dist) ────
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages/contract ./packages/contract
COPY apps/admin ./apps/admin
RUN pnpm install --frozen-lockfile --filter @agora/admin...

# API base is same-origin (/v7) — Caddy reverse-proxies it, so the browser never needs an absolute
# API URL baked in. Override at build time if you prefer a direct cross-origin URL (then the API must
# allow CORS).
ARG VITE_API_BASE_URL=/v7
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --filter @agora-server/contract build && pnpm --filter @agora/admin build

# ── Runtime: Caddy serving the static build + routing every service ─────────────
FROM caddy:2-alpine AS runtime
# Static SPA served from /srv (matches `root * /srv` in deploy/proxy/agora-routes.caddy).
COPY --from=builder /repo/apps/admin/dist /srv
EXPOSE 80 443
# The Caddyfile (auto-ACME or onion variant) AND the shared routing snippet are MOUNTED at /etc/caddy
# by docker-compose.yml — NOT baked — so operators can swap variants / edit routing without a rebuild.
# The base caddy image's entrypoint runs `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile`.
