# syntax=docker/dockerfile:1

# ── Builder: install all deps + compile TypeScript -> dist/ ───────────────────
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── Runtime: production deps + compiled output only ───────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app

# Prod deps only. sharp resolves the correct prebuilt binary for this platform here
# (so we install fresh rather than copying the builder's node_modules).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server + migration assets (drizzle journal + the drizzle-kit-free migrate script,
# runnable as a one-off via `npm run db:migrate:run`).
COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle
COPY scripts/migrate.mjs ./scripts/migrate.mjs

USER node
EXPOSE 4000

# Liveness probe against the app's /health endpoint (uses Node's built-in fetch).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
