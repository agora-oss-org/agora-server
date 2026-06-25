# Getting Started

Run Agora locally in a few minutes. The only hard requirement is a Postgres `DATABASE_URL` (a Supabase
transaction-pooler URL by default).

## Prerequisites

- **Node 22+** and **pnpm** (pinned via corepack).
- A **Postgres** database — a Supabase project (default) or a local Postgres (see [[Deployment]] /
  self-hosting).

## Quick start

```bash
corepack enable          # activate the pinned pnpm
pnpm install             # install all workspaces (from the repo root)
pnpm -r build            # build every package (contract first, topologically)

# Backend — the only hard requirement is a DATABASE_URL
cd apps/api
cp .env.example .env      # fill in DATABASE_URL
pnpm db:migrate:run       # apply migrations (idempotent; safe to re-run)
pnpm dev                  # http://localhost:4000/v7   (GET /health to verify)

# Admin dashboard (optional)
cd ../admin && pnpm dev   # http://localhost:5173
```

> Use `pnpm db:migrate:run` (the runtime migrator the container uses), **not** `db:migrate`.

## Environment

The root `.env` is the single source (symlinked into `apps/api/.env`). `DATABASE_URL` is the only hard
requirement; everything else gates a specific feature and is validated as optional — e.g.
`SUPABASE_*` (Auth + Storage), `VOYAGE_API_KEY` (semantic search), `NEO4J_URI` (the [[Social Graph]]),
`OPERATOR_USER_IDS`/`OPERATOR_EMAILS` (the operator allowlist).

The deploy-oriented env reference lives in
[`docs/CHEAT-SHEET.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/CHEAT-SHEET.md),
which maps each recipe to the variables it needs and where to obtain each value.

## Running the whole ecosystem

Agora is one of [[three repos|Ecosystem]]. To exercise the SDK end-to-end, run the server, seed a demo
user, then run the [`agora-demo`](https://github.com/jenova-marie/agora-demo) harness against it. The
full local-dev walkthrough is in the
[repo CLAUDE.md](https://github.com/agora-oss-org/agora-server/blob/root/CLAUDE.md) and each app's
README.

## Next

- **[[Architecture]]** — how the pieces fit together.
- **[[Deployment]]** — Docker Compose and production recipes.
- The backend's own setup, configuration, and conventions:
  [`apps/api/README.md`](https://github.com/agora-oss-org/agora-server/blob/root/apps/api/README.md).
