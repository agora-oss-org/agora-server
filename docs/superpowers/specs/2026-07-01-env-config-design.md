# Env & Compose Configuration Cleanup — Design

**Date:** 2026-07-01
**Status:** Approved (design), pending implementation plan
**Approach:** Option A — "one complete file per mode" (explicit `cp`, zero interpolation magic)

## Problem

Agora has an unmanaged pile of environment configuration:

- **6 env files on disk** (`.env`, `.env.local`, `.env.prod`, plus `apps/api/.env` symlink and `apps/admin/.env`) and **3 example files that disagree** (`.env.example` is a 15-var stub covering only compose interpolation + OTEL; `apps/api/.env.example` is a stale Supabase direct-connection shape; `.env.local.example` is the only complete, correct one).
- **3 compose files** (`docker-compose.dev.yml`, `docker-compose.yml`, `docker-compose.prod.yml`) for three app-location topologies.
- The **active file is selected by manually `cp`-ing** one filled-in file over `.env` — with no marker of which configuration it represents. This directly caused a near-miss where a destructive schema-rebuild (`genesis.mjs --force`) was about to run against the **cloud** database because `.env` was cloud-shaped.
- **Self-host has never actually worked** end-to-end, despite being the most important adoption path.

The consequence: the project is hard to adopt. Nobody can tell which env goes with which way of running Agora, the examples don't match reality, and the one path an evaluator most wants (fully self-contained, no cloud account) is broken.

Secrets are **not** committed — `.gitignore` ignores `.env*` and tracks only `*.example` files — so this is a clarity/correctness problem, not a secret-leak incident.

## Goals

1. Make it unambiguous which env configuration goes with which way of running Agora.
2. Ship **complete, self-consistent, correct** templates — readable top-to-bottom, no cross-referencing, no stale hostnames.
3. Prevent destructive DB scripts from silently targeting a cloud database.
4. **Make self-host actually work** — validated end-to-end, not just documented.

## Non-goals

- No env-file layering / base+overlay / merged config (rejected: fights the clarity goal; host `dotenv/config` reads a single file anyway).
- No config generator / interactive `agora init` CLI (deferred; can layer on later without rework).
- No changes to `apps/admin/.env` lifecycle (Vite build-time SPA vars — intentionally separate; tidy its example only if trivial).
- No new deployment configurations beyond the three first-class ones below.

## First-class configurations

Three, agreed with the user. Each maps to exactly one compose file + one profile + one env template:

| # | Name | App runs | Data plane | Compose file | Profile | Template |
|---|------|----------|-----------|--------------|---------|----------|
| 1 | **dev** | Host (`pnpm dev`, HMR) | Cloud Supabase | `docker-compose.dev.yml` | `supabase` | `.env.dev.example` |
| 4 | **selfhost** | Container (from source) | Local `db` + MinIO | `docker-compose.yml` | `selfhost` | `.env.selfhost.example` |
| 5 | **prod** | Container (pulled image) | Cloud Supabase | `docker-compose.prod.yml` | `supabase` | `.env.prod.example` |

Configs #2 (host+selfhost), #3 (from-source+cloud), #6 (pulled+selfhost) remain *possible* (the compose profiles still allow them) but are **not first-class**: not templated, not in the primary docs.

## Design

### 1. Three template files; delete the rest

**Create / promote (tracked):**

- `.env.dev.example` — config #1. Mirrors today's working `.env` (cloud pooler `DATABASE_URL`, `SUPABASE_*` set), but with **host-side** hostnames for the container-published backing services (`NEO4J_URI=bolt://localhost:7687`, `REDIS_URL=redis://localhost:6379`, `API_BASE_URL=http://localhost:4000`) and secrets as `<GENERATE>` placeholders. `docker-compose.dev.yml` already overrides the container-side hostnames (scorer → `neo4j:7687`, `host.docker.internal:4000`), so nothing in the template needs to know about that.
- `.env.selfhost.example` — config #4. **Rename of the existing `.env.local.example`** (already the one good, well-documented template), reviewed/updated as needed. In-container hostnames (`db:5432`, `minio:9000`, `neo4j:7687`, `redis:6379`), `STORAGE_PROVIDER=s3` + `S3_*`, `DEFAULT_AUTH_PROVIDER=native`, `POSTGRES_PASSWORD`/`MINIO_ROOT_*` that must match the URLs.
- `.env.prod.example` — config #5. Cleaned form of today's `.env.prod`: in-container + cloud pooler `DATABASE_URL`, `SUPABASE_*`, real-domain `SERVER_NAME` + ACME guidance, `PUBLIC_BASE_URL=https://…`, `RATE_LIMIT_TRUSTED_HOPS=1`. **Placeholders only — no real secrets.**

**Delete:** `.env.example` (misleading stub), `apps/api/.env.example` (stale).

**Keep:** `apps/api/.env → ../../.env` symlink (how the host app reads root `.env`); document it. `apps/admin/.env` untouched.

**`.gitignore`:** replace the per-file tracked exceptions with a single pattern so any mode template is tracked automatically:

```gitignore
.env
.env.*
!.env.*.example
```

### 2. Mode marker

Every template's first non-comment line:

```bash
AGORA_ENV=dev            # or: selfhost | prod
```

Consumed by the destructive-script guardrail (§3). Read directly from `process.env` by the scripts; not required by the app env schema (extra var, ignored by the app). May optionally be added to the env schema as a documented optional field.

### 3. Destructive-script guardrail

`genesis.mjs` and `drop.mjs` gain a target-safety check. Define **target is local** as:

```
AGORA_ENV === "selfhost"  OR  DATABASE_URL host ∈ { db, localhost, 127.0.0.1 }
```

Behavior:

- **Local target:** `--force` auto-confirms (current convenience preserved — a throwaway local DB).
- **Cloud target** (`dev`/`prod`, or any non-local host): `--force` **alone is refused** with a clear error naming the target host + `AGORA_ENV`. To proceed you must either pass the existing interactive typed-project-ref confirm, or an explicit `--force-cloud` flag (for CI against a known-disposable cloud test DB).

Both scripts print `AGORA_ENV` + the resolved DB host prominently before acting. This closes the "`genesis --force` wiped cloud" footgun.

### 4. Variable matrix (source of truth for the templates)

**Shared across all three** (same value or same `<GENERATE>` placeholder): `ACCESS_TOKEN_SECRET`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`, `REFRESH_TOKEN_GRACE_SECONDS`, `PORT`, `CRON_SECRET`, `MODERATION_SERVICE_SECRET`, `MODERATION_BLOCK/REVIEW_AUTO_ACTION_THRESHOLD`, `ANTHROPIC_*` (optional), `VOYAGE_*` (optional), `OPERATOR_EMAILS`, `LOG_LEVEL`, `LOG_CONSOLE`, `OTEL_*` (off by default), the `NEO4J_*` tuning/license vars for the neo4j container.

**Differ by mode:**

| Var | dev (#1) | selfhost (#4) | prod (#5) |
|---|---|---|---|
| `AGORA_ENV` | `dev` | `selfhost` | `prod` |
| `DATABASE_URL` | cloud pooler `:6543` | `postgres://postgres:<PW>@db:5432/postgres` | cloud pooler `:6543` |
| `SUPABASE_URL` / `_ANON_KEY` / `_SERVICE_ROLE_KEY` | set | *(unset)* | set |
| `DEFAULT_AUTH_PROVIDER` | *(unset → supabase)* | `native` | *(unset → supabase)* |
| `STORAGE_PROVIDER` | *(supabase default)* | `s3` | *(supabase default)* |
| `S3_*` (endpoint/public-url/creds/bucket/region/path-style) | — | set (MinIO) | — |
| `POSTGRES_PASSWORD` | — | set (== `DATABASE_URL` pw) | — |
| `MINIO_ROOT_USER` / `_PASSWORD` | — | set (== `S3_*` creds) | — |
| `NEO4J_URI` | `bolt://localhost:7687` | `bolt://neo4j:7687` | `bolt://neo4j:7687` |
| `NEO4J_AUTH` | `neo4j/<PW>` | `neo4j/<PW>` | `neo4j/<PW>` |
| `REDIS_URL` | `redis://localhost:6379` | `redis://redis:6379` | `redis://redis:6379` |
| `API_BASE_URL` | `http://localhost:4000` | *(compose sets internal)* | *(compose sets internal)* |
| `SERVER_NAME` | `:80` | `:80` | `<your.domain>` (ACME) or `:80` behind external TLS |
| `PUBLIC_BASE_URL` | `http://localhost` | `http://localhost` | `https://<your.domain>` |
| `RATE_LIMIT_TRUSTED_HOPS` | `1` | `1` | `1` |

`dev` uses `localhost` for `NEO4J_URI`/`REDIS_URL`/`API_BASE_URL` because the app runs on the **host** against container-published ports; `docker-compose.dev.yml` overrides the container-side consumers (scorer/cron) to service names. `selfhost`/`prod` run the app **in-container**, so they use service names directly.

### 5. Documentation

- A single **Configuration** section (README + `docs/SELF-HOSTING.md`): a 3-row table — mode → `cp` line → `up` line → what it needs. Each template's header states exactly which config it is and the exact `up` command.
- Remove/replace the misleading inline comments in the compose files that reference the old `.env`/`.env.local` copy dance.
- Document the `apps/api/.env → ../../.env` symlink and the `AGORA_ENV` marker.

## Validation / acceptance criteria

This work is **not done** until:

1. **Config #4 (selfhost) boots end-to-end from a clean checkout** using only `.env.selfhost.example`: `docker compose --profile selfhost up --build` → `genesis` → seed admin → admin login → create a post → media upload to MinIO resolves. Whatever is currently broken in the selfhost path is **fixed** as part of this work.
2. **Config #1 (dev)** continues to work with `.env.dev.example` (it is today's `.env`; regression check only).
3. **Config #5 (prod)** template validated as far as a cloud test project allows (schema/migrate/boot against a disposable cloud DB; ACME/domain steps documented, not executed).
4. The destructive-script guardrail is covered by a unit test: local target → `--force` proceeds; cloud target → `--force` refused.
5. `pnpm -r typecheck` and `pnpm test` pass.

## Risks & open questions

- **Selfhost breakage is unknown-depth.** "Never worked" may hide more than env (image build, migration extensions, MinIO bucket bootstrap, native-auth seed). Validation step #1 is where we discover and fix it; if it balloons, we surface it rather than silently descoping.
- **`.env.prod` currently holds real secrets** (gitignored). It stays a local operator file; we add `.env.prod.example` (placeholders) alongside. We do **not** delete anyone's local `.env.prod`.
- **`AGORA_ENV` host-detection heuristic** (`db`/`localhost`/`127.0.0.1` = local) is deliberately conservative: unknown hosts are treated as cloud (fail-safe toward *more* confirmation).

## Out of scope

- `apps/admin/.env` lifecycle, config generator CLI, env layering, non-first-class configs (#2/#3/#6), and any change to the compose topology set (the three compose files stay).
