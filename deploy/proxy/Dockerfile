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
# Admin feature flags are Vite BUILD-TIME vars — they're inlined into the static bundle here and cannot
# be set at container runtime. Pass them as build args (empty default = feature off) so a deployment
# that wired NEO4J_URI can surface the Social tab / lock Settings read-only.
ARG VITE_SOCIAL_GRAPH_ENABLED=
ENV VITE_SOCIAL_GRAPH_ENABLED=$VITE_SOCIAL_GRAPH_ENABLED
ARG VITE_SETTINGS_READ_ONLY=
ENV VITE_SETTINGS_READ_ONLY=$VITE_SETTINGS_READ_ONLY
# Optional one-click "Log in as admin" button on the login screen — shown only when BOTH are set,
# inlined into the bundle here (the admin SPA has no runtime config seam). Point them at the
# deployment's seeded demo operator account; leave empty and only the ordinary sign-in form shows.
ARG VITE_DEMO_EMAIL=
ENV VITE_DEMO_EMAIL=$VITE_DEMO_EMAIL
ARG VITE_DEMO_PASSWORD=
ENV VITE_DEMO_PASSWORD=$VITE_DEMO_PASSWORD
RUN pnpm --filter @agora-server/contract build && pnpm --filter @agora/admin build

# ── Runtime: Caddy serving the static build + routing every service ─────────────
FROM caddy:2-alpine AS runtime
# Static SPA served from /srv (matches `root * /srv` in deploy/proxy/agora-routes.caddy).
COPY --from=builder /repo/apps/admin/dist /srv
# Bake the DEFAULT auto-ACME Caddyfile + the shared routing snippet so a bare `docker run` (or a
# mount-free compose) Just Works on the common HTTPS path — no host-side config files required. Both
# resolve everything at RUNTIME: {$SERVER_NAME:localhost} drives cert issuance (real domain → Let's
# Encrypt; localhost → internal CA; `:80` → plain HTTP, no ACME), and the upstreams are {$ENV:default}
# placeholders. Operators can still MOUNT over either at /etc/caddy to override — e.g. the .onion /
# static-cert variant (advanced; mount Caddyfile.onion → /etc/caddy/Caddyfile + certs). See deploy/proxy/README.md.
COPY deploy/proxy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/proxy/agora-routes.caddy /etc/caddy/agora-routes.caddy
# Runtime config seam for the admin SPA: the entrypoint rewrites /srv/config.js from the container env
# (AGORA_PUBLIC_APP_URL) before starting Caddy, so a PULLED image can be pointed at a deployment's real
# public site with no rebuild. Unset vars leave the SPA on its build-time defaults.
COPY deploy/proxy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
EXPOSE 80 443
# CMD above restates the base caddy image's default command, since our ENTRYPOINT replaces its
# entrypoint (which supplied it) and ends by `exec "$@"`.
