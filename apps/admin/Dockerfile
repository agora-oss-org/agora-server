# syntax=docker/dockerfile:1
# Built from the REPO ROOT as context (admin depends on the @agora-server/contract workspace package):
#   docker build -f apps/admin/Dockerfile -t agora-admin .

# ── Builder: build @agora-server/contract, then the admin SPA (Vite → static dist) ────
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages/contract ./packages/contract
COPY apps/admin ./apps/admin
RUN pnpm install --frozen-lockfile --filter @agora/admin...

# API base is same-origin (/v7) — nginx (runtime stage) reverse-proxies it to the API, so the
# browser never needs an absolute API URL baked in. Override at build time if you prefer a direct
# cross-origin URL (then the API must allow CORS).
ARG VITE_API_BASE_URL=/v7
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --filter @agora-server/contract build && pnpm --filter @agora/admin build

# ── Runtime: nginx serving the static build + reverse-proxying the API ─────────
FROM nginx:1.27-alpine AS runtime
# Upstream Agora API + moderator; override per environment. Defaults match the compose service names.
ENV API_UPSTREAM=http://agora:4000
ENV MODERATOR_UPSTREAM=http://moderator:4001
COPY apps/admin/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder /repo/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
# nginx:alpine's default entrypoint runs envsubst over /etc/nginx/templates/*.template, then
# launches `nginx -g 'daemon off;'`.
