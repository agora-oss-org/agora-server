# @agora/admin

> The Agora admin frontend — a role-aware dashboard for operators and moderators.

A Vite + React + TypeScript single-page app that consumes [`@agora/api`](../api) (and, for AI
moderation aids, [`services/scorer`](../../services/scorer)). It's how you run a deployment day-to-day:
review the moderation queue, tune the feed, configure webhooks, and watch project health.

For the project overview, see the [root README](../../README.md).

## Stack

- **Vite 6** + **React 18** + **TypeScript** — fast dev server, `tsc -b && vite build` for prod
- **Tailwind v4** (`@tailwindcss/vite`) + **Radix UI** primitives — accessible, unstyled components
  in `src/components/ui/` wrapped with `class-variance-authority`
- **TanStack Query** — server-state cache for the API
- **react-router v7** — routing + the operator auth gate
- **`@agora-server/contract`** — shares the API's response types + zod schemas, so the admin never
  redefines a wire shape

## Layout

```
apps/admin/src/
├── App.tsx / main.tsx        # bootstrap + router
├── config.ts                 # reads VITE_* env (API base, project id, moderator base)
├── auth/                     # AuthContext, session storage, RequireAuth operator gate
├── lib/                      # api client, dashboard, moderation, moderation-ai, settings, time
├── routes/
│   ├── LoginPage.tsx
│   ├── DashboardPage.tsx     # project health + usage metrics
│   ├── ModerationPage.tsx    # report queue + AI-flag queue (ReviewDialog)
│   ├── SettingsPage.tsx      # feed ranking, webhooks, moderation panels
│   └── settings/             # FeedRankingPanel, WebhooksPanel, ModerationPanel
└── components/               # ui/ primitives + layout/ (Sidebar, Topbar, AppLayout)
```

## Features

- **Login + operator gate** — signs in against the API and admits only deployment operators
  (`OPERATOR_USER_IDS` / `OPERATOR_EMAILS` on the API); everyone else is space-scoped and rejected.
- **Dashboard** — project health and per-project usage metering (the API's `api_usage` product
  metrics) plus infra figures (e.g. `pg_database_size`).
- **Moderation** — the report queue with per-item resolution, plus an **AI-flag queue** and an
  **AI assessment** panel in the report `ReviewDialog` (both backed by `services/scorer`). Reports
  deep-link into the consumer app ("Open in app") via `VITE_DEMO_URL`.
- **Settings** — feed-ranking config (`GET`/`PATCH /settings/feed`), project webhooks, and
  per-project moderation visibility (**hide** vs **placeholder** for removed content).

## Getting started

From the **repo root** (the admin depends on the built `@agora-server/contract` package):

```bash
corepack enable
pnpm install
pnpm -r build              # build contract first
```

Then, from `apps/admin`:

```bash
cp .env.example .env       # all vars are optional — see Configuration
pnpm dev                   # http://localhost:5173 (vite proxies /v7 + /moderator to the services)
```

The dev server expects the API on `:4000` and (for AI moderation) the moderator on `:4001`; its vite
proxy forwards `/v7` and `/moderator` to them, so the admin runs same-origin with no CORS.

## Commands

Run from `apps/admin`, or `pnpm --filter @agora/admin <script>` from the repo root:

```bash
pnpm dev          # vite dev server -> http://localhost:5173
pnpm build        # tsc -b && vite build -> dist/
pnpm preview      # serve the production build locally
pnpm typecheck    # tsc --noEmit — run before considering work done
```

## Configuration (`.env`)

Vite only exposes `VITE_`-prefixed vars to the client. **All of these are optional** — same-origin
defaults work behind the bundled nginx image (and the dev proxy).

```ini
# Base URL of the @agora/api server. Defaults to "/v7" (same-origin; the dev proxy and the prod
# nginx image both forward /v7 to the API). Override for a cross-origin API.
# VITE_API_BASE_URL=/v7

# Base URL of the services/scorer moderation service (AI-flag queue + per-item analysis). Defaults to
# "/moderator" (same-origin; forwarded, prefix stripped). Override for a cross-origin scorer.
# VITE_MODERATOR_BASE_URL=/moderator

# The project this admin manages (the API is multi-tenant). For a single-project deployment, bake it
# in; if unset, the login form asks for it.
# VITE_PROJECT_ID=11111111-1111-1111-1111-111111111111

# Origin of your consumer app, for the moderation "Open in app" deep link.
# VITE_DEMO_URL=https://demo.example.com/

# Dev-only: prefill the login form with the seeded demo user. Leave unset in any real deployment.
# VITE_DEMO_EMAIL=agora-admin@gmail.com
# VITE_DEMO_PASSWORD=DemoPass123!
```

## Docker

The admin ships a multi-stage `Dockerfile` that builds the Vite SPA and serves it from **nginx**,
reverse-proxying `/v7` + `/socket.io` to the api container and `/moderator` to the moderator
container (same origin, no CORS).

```bash
# build context = repo root (depends on the @agora-server/contract workspace package)
docker build -f apps/admin/Dockerfile -t agora-admin .
docker run  --rm \
  -e API_UPSTREAM=http://<api-host>:4000 \
  -e MODERATOR_UPSTREAM=http://<moderator-host>:4001 \
  -p 8080:80 agora-admin
```

See the [root README](../../README.md#docker) for the full `docker compose` stack.

## License

[Apache-2.0](../../LICENSE) — matching Replyke.
