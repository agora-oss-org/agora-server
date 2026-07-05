# Agora Deployment Cheat-Sheet

A one-page map of **what to run** (compose profiles) and **what to set** (env vars) for each
deployment shape — and **where to get** each value. The complete, commented env references are the three
per-mode templates [`.env.dev.example`](../.env.dev.example) / [`.env.selfhost.example`](../.env.selfhost.example)
/ [`.env.prod.example`](../.env.prod.example); the architecture lives in [`CLAUDE.md`](../CLAUDE.md) and
[`docs/SELF-HOSTING.md`](SELF-HOSTING.md).

> **Golden rule:** in `.env`, an **empty string == unset** (optional features stay off when blank).
> Only **`DATABASE_URL`** and **`ACCESS_TOKEN_SECRET`** are hard requirements; everything else gates a
> specific feature.

---

## 1. Pick a recipe (compose)

The compose model is **two axes**: choose **exactly one data plane** (Axis 1, brings up the API), then
add **optional services** (Axis 2). A bare `docker compose up` starts nothing.

| Goal | Command |
|---|---|
| Just the API, **Supabase**-backed | `docker compose --profile supabase up` |
| Just the API, **self-contained** (local Postgres + MinIO) | `docker compose --profile selfhost up` |
| **Everything**, Supabase-backed | `docker compose --profile full --profile supabase up` |
| **Everything**, self-contained | `docker compose --profile full --profile selfhost up` |
| API + moderation only | `docker compose --profile scorer --profile supabase up` |
| Standalone / split **secure-chat** box | `docker compose --profile secure-chat up` *(remote `DATABASE_URL`)* |
| Apply migrations (existing DB, any time) | `docker compose run --rm agora node scripts/migrate.mjs` |
| First-time schema + tenant row (⚠ drops — fresh DB only) | `docker compose run --rm -it agora node scripts/genesis.mjs` |
| Seed admin login + demo content (stack up first) | `docker compose exec agora node scripts/seeds/seed.mjs` |

> **Seeding runs inside the container** (no host `pnpm`/`psql`): `genesis.mjs` applies the schema +
> `seed.sql` in-process, then `seed.mjs` adds the admin login + demo content. Use `exec` (not `run`) for
> `seed.mjs` — the demo posts call the API, and inside the **live** container `localhost:4000` is the
> server (a one-off `run` container would `ECONNREFUSED`). Full flow →
> [`apps/api/README.md`](../apps/api/README.md#seeding-a-running-container-docker).

### Profiles → services

| Profile | Axis | Starts | Pairs with |
|---|---|---|---|
| `supabase` | data plane + API | `agora` + `proxy` (Caddy) + `cron` | — *(external Supabase)* |
| `selfhost` | data plane + API | `agora` + `proxy` + `cron` + `db` + `minio` | — |
| `scorer` | add-on | `scorer-toxicity` + `scorer-relationship` + `scorer-worker` + `neo4j` | a data plane |
| `secure-chat` | add-on | `secure-chat` + `redis` | a data plane *(or remote DB)* |
| `scale` | add-on | `redis` | a data plane |
| `full` | add-on shorthand | = `scorer` + `secure-chat` | a data plane |
| `observability` | add-on | `alloy` + `tempo` + `mimir` + `loki` + `grafana` (LGTM) — Grafana at `/grafana/` | a data plane |
| `demo` | add-on | `demo` — pulled SDK harness at `/demo/` | a data plane |

### Dev build vs. production pull

The commands above use the default [`docker-compose.yml`](../docker-compose.yml), which **builds** the
images from source. For production, [`docker-compose.prod.yml`](../docker-compose.prod.yml) **pulls** the
published images instead (`agoraserver/agora-*`) — no repo checkout needed to build, backend ports stay
internal (only the proxy's `80`/`443` are public), and you can pin a release with `AGORA_TAG`:

```bash
AGORA_TAG=v0.13.0 docker compose -f docker-compose.prod.yml --profile full --profile supabase up -d
```

Same profiles, same `.env`. The default HTTPS/ACME path needs **only** the compose file + `.env` — the
front-door config (Caddyfile + routing snippet) is **baked into the `agora-proxy` image**. The only extra
host files are opt-in: `neo4j/plugins/open-gds-*.jar` (with `scorer`/`full`) and, for the advanced `.onion`
/ static-cert variant, `deploy/proxy/Caddyfile.onion` + certs. The header of `docker-compose.prod.yml`
lists the bundle.

---

## 2. Env by configuration

Set these in your **`.env`** (for the API, that's `apps/api/.env`; see
[Environment files](../README.md#environment-files) for the per-app layout and the optional single-file
setup). ✅ = required for that configuration · ◻️ = optional. Values that compose **injects for you** in
the Docker path are marked *(compose-set)* — you don't put them in `.env`.

### 2.0 — Always required (every deployment)

| Var | | Value & where to get it |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection string. **Supabase:** Dashboard → *Project Settings → Database → Connection string → **Transaction pooler** (port `6543`)*. **Self-host:** `postgres://postgres:<POSTGRES_PASSWORD>@db:5432/postgres`. |
| `ACCESS_TOKEN_SECRET` | ✅ | HS256 signing secret, **≥ 32 chars**. Generate: `openssl rand -base64 48`. Must be **identical** across `agora` + `scorer` + `secure-chat`. |

### 2.1 — Data plane A: **Supabase** (`--profile supabase`)

For Supabase-backed **Auth** (passwords / confirmation emails) and **Storage** uploads. The DB-backed
server boots without these, but identity + uploads stay off until set.

| Var | | Value & where to get it |
|---|---|---|
| `SUPABASE_URL` | ✅ | Dashboard → *Project Settings → API → **Project URL*** (`https://<ref>.supabase.co`). |
| `SUPABASE_ANON_KEY` | ✅ | Dashboard → *Project Settings → API → Project API keys → **anon / public***. |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Dashboard → *Project Settings → API → Project API keys → **service_role*** (secret — server-only). |
| `DEFAULT_AUTH_PROVIDER` | ◻️ | `supabase` (default). Stamps new projects' identity backend. |

### 2.2 — Data plane B: **Self-host** (`--profile selfhost`)

Runs the same API on a local Postgres + MinIO — **no Supabase cloud/account** (no hosted Auth, Storage,
or DB). The local Postgres is still the **`supabase/postgres`** image, though (the profile pins
`15.8.1.060`) — **not** a vanilla Postgres, since the migrations need its bundled pgvector/PostGIS/pgmq +
the `auth` roles. So "self-hosted" drops the Supabase *service*, not the Supabase Postgres
*distribution*. See [`docs/SELF-HOSTING.md`](SELF-HOSTING.md).

| Var | | Value & where to get it |
|---|---|---|
| `POSTGRES_PASSWORD` | ✅ | **You choose.** Then `DATABASE_URL=postgres://postgres:<this>@db:5432/postgres`. |
| `MINIO_ROOT_USER` | ✅ | **You choose** (e.g. `agora`). Also used as `S3_ACCESS_KEY_ID`. |
| `MINIO_ROOT_PASSWORD` | ✅ | **You choose.** Also used as `S3_SECRET_ACCESS_KEY`. |
| `STORAGE_PROVIDER` | ✅ | Set to `s3` (selects MinIO/S3 instead of Supabase Storage). |
| `S3_ENDPOINT` | ✅ | `http://minio:9000` (internal compose DNS). |
| `S3_PUBLIC_URL` | ✅ | Browser-reachable base for public objects — the Caddy `/media` mount, e.g. `https://your-host/media`. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | ✅ | = `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`. |
| `S3_BUCKET` | ◻️ | `agora` (default; auto-created on first upload). |
| `DEFAULT_AUTH_PROVIDER` | ✅ | Set to `native` (in-API passwords, no Supabase Auth). |

> Bootstrap the first user on a virgin self-host DB:
> `docker compose run --rm -it agora node scripts/seeds/helpers/seed-native-auth-admin.mjs`.

### 2.3 — Front door (Caddy `proxy`) — comes up with the API

| Var | | Value & where to get it |
|---|---|---|
| `SERVER_NAME` | ◻️ | Your **domain** (e.g. `agora.example.com`) → auto-HTTPS via Let's Encrypt (DNS must point here; `:80`+`:443` reachable). · `:80` → **plain HTTP**, no TLS/ACME (behind your own terminator/CDN, or local dev). · *unset* → `localhost` with Caddy's internal CA. |
| `RATE_LIMIT_TRUSTED_HOPS` | ◻️ | `1` (default) — one hop = the bundled Caddy. Use `2` only if a CDN/LB sits **in front of** Caddy. |
| `ACME_CA` | ◻️ | ACME directory. **Defaults to Let's Encrypt _staging_** (untrusted certs — browsers warn — but no prod rate-limit risk while you validate DNS/firewall). ⚠️ **Going live:** set `https://acme-v02.api.letsencrypt.org/directory` for real, trusted certs. Only affects a real-domain `SERVER_NAME` (`localhost`/`:80` never hit ACME). |
| `ACME_EMAIL` | ◻️ | Let's Encrypt expiry notices. Certs issue fine without it (also uncomment `email` in the Caddyfile to use). |
| `CADDYFILE` / `CADDY_CERTS_DIR` | ◻️ | **Onion / static-cert mode only:** `./deploy/proxy/Caddyfile.onion` + a dir holding `site.pem`/`site.key`. See [`deploy/proxy/README.md`](../deploy/proxy/README.md). |

### 2.4 — Add-on: **scorer** (`--profile scorer`) — moderation + social graph

| Var | | Value & where to get it |
|---|---|---|
| `MODERATION_SERVICE_SECRET` | ✅ | Shared secret gating `POST /internal/moderation/apply` (scorer → API write-back). `openssl rand -base64 32`; **same value** in API + scorer. |
| `ANTHROPIC_API_KEY` | ◻️ | Borderline-content adjudication (Claude Haiku). [console.anthropic.com](https://console.anthropic.com) → *API Keys*. Unset → escalation off; borderline items go to the human AI-flag queue. |
| `NEO4J_AUTH` | ◻️ | `user/password` for the `neo4j` container (social graph). **You choose** (e.g. `neo4j/<strong-pw>`); same string on both the DB and the clients. |
| `NEO4J_URI` | *(compose-set)* | `bolt://neo4j:7687` injected via `NEO4J_URI_DOCKER`. Only set for an **external** Neo4j. Unset entirely → `/social/*` returns 503, edge writes no-op. |
| `API_BASE_URL`, `SCORER_*_URL` | *(compose-set)* | `http://agora:4000` etc. — wired by compose. Override only off-compose. |
| `MODERATION_BLOCK_AUTO_ACTION_THRESHOLD` | ◻️ | Auto-remove cutoff `0..1` (default `0.85`). Per-project overrides live in admin *Settings → Moderator*. |
| `SCORER_GRAYZONE_LOW`/`HIGH`, `SCORER_CO_PARTICIPATES_*`, `llmProvider`/`llmApiKey`/`llmModel` | ◻️ | Env values are now just the **default** — all per-project overridable via `projects.moderator_config`, editable in admin *Settings → Agent moderation* (base-url stays env-only; fixed provider host). |

### 2.5 — Add-on: **secure-chat** (`--profile secure-chat`, also rides `full`)

| Var | | Value & where to get it |
|---|---|---|
| `REDIS_URL` | ✅ | **Hard dependency** (fail-closed suspension index). In compose: `redis://redis:6379` (or `redis://<acl-user>:<pw>@redis:6379` with a least-privilege ACL — see [`apps/api/README.md`](../apps/api/README.md)). |
| `DATABASE_URL` | ✅ | Persists `secure_*` tables. v1 **shares the API's Postgres**; a split box points this at the **remote** DB. The DB must already be migrated. |

### 2.6 — Add-on: **scale** (`--profile scale`) — multi-replica rate limiting

| Var | | Value & where to get it |
|---|---|---|
| `REDIS_URL` | ✅ | Shared rate-limit store so the cap holds across **multiple `agora` replicas** (a single replica needs none — it limits in-process). `redis://redis:6379`. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_AUTH_MAX` | ◻️ | Requests per window (rate limiting is **off** until `RATE_LIMIT_MAX` is set). `RATE_LIMIT_WINDOW_SECONDS` defaults to `60`. |

### 2.7 — Optional features (any deployment)

| Feature | Var(s) | | Where to get it |
|---|---|---|---|
| Semantic search (embeddings) | `VOYAGE_API_KEY` | ◻️ | [dashboard.voyageai.com](https://dashboard.voyageai.com) → *API Keys*. Unset → search falls back to ILIKE. |
| RAG `/search/ask` | `ANTHROPIC_API_KEY` | ◻️ | [console.anthropic.com](https://console.anthropic.com). |
| Operators (god-view) | `OPERATOR_EMAILS` / `OPERATOR_USER_IDS` | ◻️ | **You choose** — your admin email(s) / profile UUID(s), comma-separated. Unset → no operators. |
| Cron jobs | `CRON_SECRET` | ◻️ | Gates `POST /internal/cron/*` (503 until set). `openssl rand -base64 32`. |
| OAuth callbacks behind a proxy | `PUBLIC_BASE_URL` | ◻️ | Your public origin, e.g. `https://api.example.com` — used to build absolute OAuth callback URLs. |
| Tracing/metrics (bundled LGTM) | `OTEL_SDK_DISABLED`, `OTEL_*_ENDPOINT` | ◻️ | `--profile observability` brings up Alloy + Tempo/Mimir/Loki/Grafana; the apps already point their OTLP at `alloy`, so just set `OTEL_SDK_DISABLED=false`. Or point `OTEL_*_ENDPOINT` at your own collector. Off by default. |
| Grafana login (prod) | `GRAFANA_ADMIN_PASSWORD` | ◻️ | Served at **`/grafana/`** via the front door. In **prod** anonymous is disabled → set this (with `GRAFANA_ADMIN_USER`, `GRAFANA_ROOT_URL=https://<host>/grafana/`). Dev keeps anonymous-admin on `localhost`. |

### 2.8 — Admin SPA (build-time, in `apps/admin/.env` — **not** the root `.env`)

Only `VITE_`-prefixed vars reach the browser; they're baked at build. See
[`apps/admin/.env.example`](../apps/admin/.env.example).

| Var | | Value |
|---|---|---|
| `VITE_API_BASE_URL` | ◻️ | API base. Default `/v7` (same-origin via the Caddy front door). Override only for a cross-origin API. |
| `VITE_MODERATOR_BASE_URL` | ◻️ | Scorer base. Default `/moderator` (same-origin). |
| `VITE_SETTINGS_READ_ONLY` | ◻️ | `true` → Settings page view-only (UI guard, not a security boundary). |

---

## 3. `.env` — start from a template (local-Postgres-first)

There's **one template per compose file**, each **defaulting to a local Postgres + MinIO** (no cloud
account needed). `cp` the one matching how you run Agora, fill the `<GENERATE:…>` placeholders — the
templates are canonical, so don't hand-assemble an `.env`.

| Template | Compose file | App runs |
|---|---|---|
| `cp .env.dev.example .env` | `docker-compose.dev.yml` | host (HMR) |
| `cp .env.selfhost.example .env` | `docker-compose.yml` | container (from source) |
| `cp .env.prod.example .env` | `docker-compose.prod.yml` | container (pulled image) |

**Local Postgres (default).** Fill the placeholders; **`POSTGRES_PASSWORD` must equal the password inside
`DATABASE_URL`**, and **`MINIO_ROOT_PASSWORD` must equal `S3_SECRET_ACCESS_KEY`**. The template already sets
`STORAGE_PROVIDER=s3` + `DEFAULT_AUTH_PROVIDER=native`. Bring it up with `--profile selfhost`.

**Cloud Supabase (switch).** In the template, comment the LOCAL data-plane block and uncomment the CLOUD
block (`DATABASE_URL` pooler `:6543` + `SUPABASE_URL`/`_ANON_KEY`/`_SERVICE_ROLE_KEY` +
`DEFAULT_AUTH_PROVIDER=supabase`), then run `--profile supabase`.

**Everything (`--profile full`).** Every template already carries the add-on keys; just fill them in:
`MODERATION_SERVICE_SECRET` (scorer write-back), `NEO4J_AUTH` (social graph),
`REDIS_URL=redis://redis:6379` (secure-chat hard dep), and optionally `ANTHROPIC_API_KEY` (Haiku) /
`VOYAGE_API_KEY` (semantic search).

> **Destructive-script guard.** `drop`/`genesis` combine `AGORA_ENV` + the `DATABASE_URL` host: a LOCAL
> throwaway (`db`/`localhost`, non-`prod`) drops on `--force`; a PROTECTED target (any cloud/remote host,
> **or** `AGORA_ENV=prod` even on a local db) requires typing the project ref (`--force` won't skip it).
