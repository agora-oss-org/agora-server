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
  deep-link into the consumer app ("Open in app") via `AGORA_PUBLIC_APP_URL` (runtime) /
  `VITE_PUBLIC_APP_URL` (build-time).
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

# Origin of your PUBLIC consumer app, for the "Open in app" deep links on reports, AI flags, and
# steward cases. Build-time default; on a containerized deploy prefer the RUNTIME knob
# AGORA_PUBLIC_APP_URL (see below), which works on a pulled image. `VITE_DEMO_URL` is the old name and
# is still honoured as a last resort. Non-http(s) values are ignored.
# VITE_PUBLIC_APP_URL=https://community.example.com/

# Which project this admin manages. Defaults to the seed project UUID.
# VITE_PROJECT_ID=11111111-1111-1111-1111-111111111111

# Feature flags. Social needs NEO4J_URI wired up server-side, or the panels 503.
# VITE_SOCIAL_GRAPH_ENABLED=true
# VITE_SETTINGS_READ_ONLY=true

# Dev-only: prefill the login form with the seeded demo user. Leave unset in any real deployment.
# ⚠️ Whatever you set here ships to every visitor's browser.
# VITE_DEMO_EMAIL=agora-admin@agora-oss.org
# VITE_DEMO_PASSWORD=DemoPass123!
```

On a containerized deploy these are only **build-time defaults** — prefer the `AGORA_*` runtime
equivalents below, which work on a pulled image.

### Runtime configuration (`/config.js`)

Every `VITE_*` var above is inlined at **build** time, so a deployment that *pulls* the published
`agora-proxy` image can't change them. **Every** setting is therefore also readable from `/config.js`,
which the proxy container's entrypoint (`deploy/proxy/docker-entrypoint.sh`) rewrites from its env on
every start — served `no-store` so a stale copy can't pin the SPA to an old deployment's config.

Precedence is **`/config.js` → `VITE_*` → built-in default**. Each candidate is *type-validated* and an
invalid one **falls through to the next** rather than winning, so a typo or an unsubstituted
placeholder degrades to the default instead of breaking the app.

| env on the `proxy` service | `/config.js` key | validated as | what it sets |
| --- | --- | --- | --- |
| `AGORA_PUBLIC_APP_URL` | `publicAppUrl` | http(s) URL | origin of the public consumer app, for "Open in app" deep links |
| `AGORA_ADMIN_PROJECT_ID` | `projectId` | uuid | which project this admin manages (default: the seed project) |
| `AGORA_ADMIN_API_BASE_URL` | `apiBaseUrl` | rooted path or http(s) URL | the API base (default `/v7`, same-origin) |
| `AGORA_ADMIN_MODERATOR_BASE_URL` | `moderatorBaseUrl` | rooted path or http(s) URL | the scorer base (default `/moderator`, same-origin) |
| `AGORA_ADMIN_SOCIAL_GRAPH_ENABLED` | `socialGraphEnabled` | boolean | show the Social tab + Weather card (needs `NEO4J_URI` server-side) |
| `AGORA_ADMIN_SETTINGS_READ_ONLY` | `settingsReadOnly` | boolean | render Settings view-only — **UI guard only**, see below |
| `AGORA_ADMIN_DEMO_EMAIL` | `demoEmail` | string | one-click demo login — ⚠️ **public**, see below |
| `AGORA_ADMIN_DEMO_PASSWORD` | `demoPassword` | string | one-click demo login — ⚠️ **public**, see below |
| `AGORA_ADMIN_UMAMI_URL` | `umamiUrl` | http(s) URL | Umami mount for admin analytics (may carry a path prefix) — set **with** the id or it stays off |
| `AGORA_ADMIN_UMAMI_ID` | `umamiId` | uuid | the **admin** site's Umami website id — set **with** the URL or it stays off |

Booleans accept `true`/`1`/`yes`/`on` and their negatives; anything else reads as *unset* (not `false`),
so garbage can't silently switch off a feature the image enabled.

Retarget a running deployment with no rebuild:

```bash
AGORA_PUBLIC_APP_URL=https://community.example.com/ docker compose up -d proxy
```

#### Two things that are not what they look like

**`AGORA_ADMIN_DEMO_EMAIL` / `_PASSWORD` are public.** They are served to every visitor in
`/config.js` (and were equally public inlined in the bundle). A browser-side login prefill cannot be
otherwise — there is no way to hand the browser a credential without handing it to whoever loads the
page. Point them at an account you are deliberately publishing, i.e. the shared demo login the server
restricts via `OPERATOR_RO_EMAILS`; **never** a real operator account.

**`AGORA_ADMIN_SETTINGS_READ_ONLY` is a UI guard, not a security boundary.** It disables the Save
controls; it does not stop anyone from calling the API directly with the same operator token. Real
enforcement is server-side `OPERATOR_RO_EMAILS` → the `settingsReadonly` JWT claim →
`assertSettingsWritable`. Set that too, and treat this flag purely as the matching UI.

**Umami analytics are browser-side only.** The admin loads Umami's script and posts events straight
from the browser to your Umami instance — the `@agora/api` server has no analytics code and never sees
them (`8b72364` removed analytics from the API; only the admin's browser tracking came back). Both
`AGORA_ADMIN_UMAMI_URL` and `AGORA_ADMIN_UMAMI_ID` must be set or nothing is injected. Pageviews
(including SPA route changes) are automatic; `lib/analytics.ts` `track()` adds custom events for
login/logout, moderation actions, re-analysis, and settings saves. There is no Analytics page in the
admin — read the stats in Umami's own dashboard.

**`apiBaseUrl` / `moderatorBaseUrl`** accept a root-relative path (`/v7`) or an absolute `http(s)` URL.
Protocol-relative values (`//host`) are rejected: they read like a path but silently repoint every API
call — and the Bearer token it carries — at another origin.

Adding a key: `emit` it in the entrypoint, relay it on `proxy` in the three compose files, and read it
via `runtimeConfig()` in `src/config.ts`.

## Docker

The admin SPA has no Docker image of its own — it's built and served by the **Caddy front door**
(`proxy` service). [`deploy/proxy/Dockerfile`](../../deploy/proxy/Dockerfile) builds this Vite SPA into
its `dist`, bakes it into a Caddy image, and Caddy serves it same-origin while reverse-proxying `/v7` +
`/socket.io` to the api, `/moderator` to the scorer-worker, secure-chat + `/media` to their services (no
CORS, no build-time API URL). See [`deploy/proxy/README.md`](../../deploy/proxy/README.md).

```bash
# build context = repo root (depends on the @agora-server/contract workspace package)
docker build -f deploy/proxy/Dockerfile -t agora-proxy .
```

See the [root README](../../README.md#docker) for the full `docker compose` stack.

## License

[Apache-2.0](../../LICENSE) — matching Replyke.
