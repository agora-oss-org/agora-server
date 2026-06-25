# Self-hosting Agora without Supabase

Agora ships pointed at Supabase by default, but the same `@agora/api` image runs **fully
self-contained** — local Postgres + local object storage + in-API password auth — with no Supabase
account at all. Supabase is one of two interchangeable backends, not a hard dependency.

> ⚠️ **"Local Postgres" means the `supabase/postgres` image — not a vanilla Postgres.** Self-hosting
> drops the Supabase **cloud** (hosted DB / Auth / Storage); it does **not** drop the Supabase Postgres
> **distribution**. Agora's migrations hard-depend on what that image bundles — the **pgvector**,
> **PostGIS**, **pgmq**, and **pgcrypto** extensions plus the `anon`/`authenticated`/`service_role` roles
> and the `auth` schema / `auth.uid()`. A stock `postgres:15` image is missing all of that and the
> migrations will fail. The `selfhost` compose profile already pins `supabase/postgres:15.8.1.060` for
> exactly this reason. You *can* point `DATABASE_URL` at your **own** Postgres if it provides the same
> extensions + roles — see [Running on your own / non-Supabase Postgres](#running-on-your-own--non-supabase-postgres)
> for the exact list and a copy-paste bootstrap (and the one gotcha: pgmq on managed providers).

Three things are pluggable, each chosen by config (nothing is replaced — flip a switch):

| Concern  | Supabase (default)                  | Self-hosted                                  | Selected by            |
|----------|-------------------------------------|----------------------------------------------|------------------------|
| Database | Supabase Postgres (pooler `:6543`)  | `supabase/postgres` container (`db`)         | `DATABASE_URL`         |
| Storage  | Supabase Storage public bucket      | MinIO container (`minio`), S3 API            | `STORAGE_PROVIDER=s3`  |
| Auth     | Supabase Auth (passwords + OAuth)   | Native in-API passwords (`auth_provider`)    | `DEFAULT_AUTH_PROVIDER`|

The `selfhost` compose profile is one of the two data planes: it brings up the API itself plus the two
local backends (you do NOT pair it with `full` to get the API). It's opt-in — a Supabase-backed deploy
runs `--profile supabase` instead and points the env at Supabase. (Compose services are all
profile-gated, so a bare `docker compose up` starts nothing.)

## Quick start (whole stack, no Supabase)

1. **Start from the local template.** [`.env.local.example`](../.env.local.example) is a ready-made
   config for exactly this deploy — `--profile selfhost` (or `--profile full --profile selfhost`) — with
   every self-hosted var pre-wired (local Postgres, MinIO, native auth, the Caddy front door on plain
   HTTP) and an `openssl` command beside each secret placeholder. Copy it, fill the `<GENERATE: …>`
   placeholders, then activate it as `.env` (compose reads `.env` for both `${VAR}` interpolation **and**
   the services' `env_file`):

   ```bash
   cp .env.local.example .env.local        # 1. copy the template
   # 2. fill every <GENERATE: …> placeholder with the openssl command shown beside it, e.g.:
   #    openssl rand -hex 16     → POSTGRES_PASSWORD / MINIO_ROOT_PASSWORD / NEO4J_AUTH password
   #    openssl rand -base64 48  → ACCESS_TOKEN_SECRET / CRON_SECRET / MODERATION_SERVICE_SECRET
   cp .env.local .env                       # 3. make it the active env file
   ```

   The self-hosted block it sets (what you'd otherwise assemble by hand from `.env.example` →
   "Self-hosted"):

   ```bash
   # DB — local Postgres
   POSTGRES_PASSWORD=<strong-password>
   DATABASE_URL=postgres://postgres:<strong-password>@db:5432/postgres

   # Storage — local MinIO
   STORAGE_PROVIDER=s3
   S3_ENDPOINT=http://minio:9000
   S3_PUBLIC_URL=https://your-host/media     # the Caddy front door /media mount (below)
   S3_ACCESS_KEY_ID=agora
   S3_SECRET_ACCESS_KEY=<strong-password>
   MINIO_ROOT_USER=agora
   MINIO_ROOT_PASSWORD=<strong-password>     # must equal S3_SECRET_ACCESS_KEY

   # Auth — native (no Supabase). Leave all SUPABASE_* unset.
   DEFAULT_AUTH_PROVIDER=native

   # Required regardless of backend
   ACCESS_TOKEN_SECRET=<openssl rand -base64 48>
   ```

   > The template uses `SERVER_NAME=:80` (plain HTTP) and `S3_PUBLIC_URL=http://localhost/media` for a
   > friction-free local run — `http://localhost` is a browser "secure context", so secure-chat's
   > WebCrypto still works. For a real host, set `SERVER_NAME=<your.domain>` and
   > `S3_PUBLIC_URL=https://<your.domain>/media` (auto-HTTPS).

2. **Bring the stack up** — `--profile selfhost` is the API + local db + minio (incl. the Caddy front
   door); add `--profile full` for all optional add-ons, or `--profile scorer`/`--profile secure-chat`/
   `--profile scale` individually:

   ```bash
   docker compose --profile selfhost up --build
   ```

   This starts `db`, `minio`, `agora`, `proxy` (the Caddy front door that serves the admin SPA) (+ `cron`).
   `agora` has `restart: unless-stopped`, so if
   it boots before `db` is ready it crash-loops briefly, then connects — no manual ordering needed.

3. **Apply migrations once** (the schema + RLS + triggers + RPC). The `supabase/postgres` image bundles
   everything the migrations assume — **pgvector**, **PostGIS**, **pgmq**, and the
   `authenticated`/`anon`/`service_role` roles + `auth.uid()` — so they apply unchanged (validated against
   `supabase/postgres:15.8.1.060`):

   ```bash
   docker compose run --rm agora node scripts/migrate.mjs
   ```

   > **Use the `postgres` database — don't create your own.** The `auth` schema, `auth.uid()`, and the
   > `anon`/`authenticated`/`service_role` roles are provisioned by the image **only in the default
   > `postgres` database** (schemas are per-database, so a `CREATE DATABASE agora` would be missing them
   > and the RLS migrations would fail with `schema "auth" does not exist`). That's why `DATABASE_URL`
   > points at `…@db:5432/postgres`.

   For a dev box you can instead `node scripts/genesis.mjs` (drop → rebuild → seed); it stamps the seed
   project's `auth_provider` from `DEFAULT_AUTH_PROVIDER`.

4. **Bootstrap the first admin.** A virgin DB has no users, and native auth gates sign-in on email
   confirmation (the default `ConsoleEmailSender` only *logs* the confirm link — no SMTP). So seed a
   **pre-confirmed** native credential directly, then make it an operator:

   ```bash
   # the credential is confirmed in-DB (no email round-trip); -it gives the prompt a TTY
   docker compose run --rm -it agora node scripts/seeds/seed-native-admin.mjs
   #   Admin email: you@example.com
   #   Admin password (hidden): ********   (not echoed, asked twice)
   ```

   The script **prompts** for the email and password (password hidden, entered twice) so no secret
   touches the command line, `ps`, or shell history. For non-interactive/CI use, set `ADMIN_EMAIL` +
   `ADMIN_PASSWORD` in the env instead and it skips the prompt.

   > **Keeping an inline secret out of shell history.** If you do pass `ADMIN_PASSWORD=… node …` on the
   > command line, prefix the whole line with a **single leading space** so your shell skips recording it.
   > That only works once the shell is configured for it (**oh-my-zsh enables this by default** via its
   > `lib/history.zsh`). Otherwise set it in your `~/.bashrc` / `~/.zshrc`:
   >
   > ```bash
   > # bash — also drops duplicate lines:
   > export HISTCONTROL=ignorespace        # (or ignoreboth)
   > # plain zsh (oh-my-zsh already does this):
   > setopt HIST_IGNORE_SPACE
   > ```
   >
   > Then `  ADMIN_PASSWORD='…' docker compose run … ` (note the leading space) won't land in history.
   > It's still visible to `ps` / `/proc` while the process runs, so the interactive prompt above is
   > still the safer default — this is only for the env/CI path.

   Then add that email to **`OPERATOR_EMAILS`** in `.env` (god-view is the env allowlist, not a DB row —
   see "Auth" below) and restart `agora`. Sign in at the admin SPA; the `profiles` row auto-creates on
   first sign-in. Re-run with `--reset` to set a new password if you lock yourself out. (This is the
   native counterpart of `seed-demo-user.mjs`, which is Supabase-only.)

5. **Done.** The Caddy front door serves the admin SPA on `:443` (and `:80`). Uploads land in
   MinIO and are served back through `https://your-host/media/<key>`.

## Running on your own / non-Supabase Postgres

The `selfhost` profile pins `supabase/postgres` so you don't have to think about any of this. But the
image is only a *convenience bundle* — Agora's migrations depend on a small, well-defined set of pieces,
so you **can** point `DATABASE_URL` at your own Postgres (a self-built image, Crunchy, Tembo, etc.) if it
provides them. There are two kinds of requirement.

### 1. Extensions (must be installed at the image / OS level — not addable via SQL)

`CREATE EXTENSION` only works if the compiled extension is already present in the Postgres install, so
this is a "build/choose your image" step, not something you can run as a migration:

| Extension | Notes |
|---|---|
| **pgcrypto** | Ships in standard `postgres-contrib` — the official `postgres` image already has it. |
| **pgvector** | Add the `postgresql-XX-pgvector` package / build it, or base off `pgvector/pgvector:pgXX`. |
| **PostGIS** | Add `postgresql-XX-postgis-3`, or base off `postgis/postgis:XX`. |
| **pgmq** | Tembo's queue extension — install from their apt repo or build it. **This is the usual blocker (see below).** |

### 2. Supabase-isms the migrations *assume but don't create* (pure SQL — a tiny pre-migrate bootstrap)

The `supabase/postgres` init provisions these; on a plain Postgres you create them yourself **once,
before `scripts/migrate.mjs`**, in the database `DATABASE_URL` targets:

```sql
-- roles the GRANTs + RLS policies reference (service_role isn't actually used by the migrations)
create role anon nologin;
create role authenticated nologin;

-- the auth schema + auth.uid() referenced by the 0017 RLS self-access policies.
-- A stub is fine: the API connects as the table-owner and BYPASSES RLS (the server is the trust
-- boundary; RLS is defense-in-depth), so auth.uid() only needs to EXIST for the policies to apply.
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
```

That's the whole surface — no `auth.users` table or FK is required (`profiles.auth_user_id` is a plain
uuid the app links). With `DEFAULT_AUTH_PROVIDER=native`, Supabase Auth/GoTrue isn't used at all.

### The one real gotcha: pgmq on *managed* Postgres

Managed providers (AWS RDS/Aurora, GCP Cloud SQL, Azure Flexible Server) only allow extensions from a
**vetted allowlist** (`rds.allowed_extensions` / `azure.extensions` / the Cloud SQL list) and give you no
superuser or filesystem access to add your own. pgvector, PostGIS, and pgcrypto are old and on every
list; **pgmq is newer, a compiled (untrusted) C extension, and is not on most of them** — so you can't
install it and the provider hasn't pre-installed it. Because migration `0027` runs `CREATE EXTENSION
pgmq` **unconditionally** (even if you don't run the scorer), a managed box that bans pgmq will **fail
migrations outright**. Providers that *do* ship it include Supabase's managed DB and Tembo Cloud; on a VM
or container you control, just install it.

> **Bottom line:** a self-built / self-managed Postgres image is a perfectly good escape hatch — install
> the four extensions and run the bootstrap above. A locked-down *managed* Postgres usually is **not**,
> and pgmq is almost always why.

## How each seam works

### Storage (`STORAGE_PROVIDER`)

`lib/storage.ts` (`uploadBytes`/`publicUrl`) delegates to a `StorageProvider` chosen once at boot
(`lib/storage/`): `supabase` → Supabase Storage, `s3` → any S3-compatible store. The S3 provider
(`lib/storage/s3.ts`) lazily creates the bucket and applies an anonymous **public-read** policy on the
first upload — no `mc` bootstrap sidecar. Object keys are unguessable UUID paths
(`<projectId>/files/<uuid>.<ext>`).

**Public URLs never point at MinIO directly.** The stored URL is built from `S3_PUBLIC_URL`, and the
Caddy front door serves a `/media/` route that rewrites `/media/<key>` → `/<bucket>/<key>` on the
internal `minio:9000` upstream. So set `S3_PUBLIC_URL=<your public origin>/media` — i.e.
`https://<SERVER_NAME>/media`.

The `files` table is unchanged — it stores the resolved public URL in `original_path`, so switching
backends doesn't migrate existing rows (already-stored URLs keep resolving against whatever wrote them;
this is a fresh-deploy choice, not a live migration — see "Switching an existing deployment").

### Auth (`DEFAULT_AUTH_PROVIDER` + `projects.auth_provider`)

Identity is already pluggable per project: `getAuthProvider()` reads `projects.auth_provider`
(`native` | `supabase`). Native auth (in-API Argon2 passwords + confirmation/reset email links) needs
**no Supabase**. `DEFAULT_AUTH_PROVIDER` only decides what a **newly created** project gets stamped
with at genesis; it's never a runtime fallback. An existing project switches via the admin project
settings or SQL:

```sql
update projects set auth_provider = 'native' where id = '<project-id>';
```

**OAuth (social login) is Supabase-brokered** and therefore unavailable in a Supabase-less deploy:
`/oauth/authorize` and `/oauth/callback` return `oauth/not-configured`. Native email/password is the
full self-hosted auth surface.

**Operator (god-view) is an env allowlist, not a DB role.** `OPERATOR_EMAILS` / `OPERATOR_USER_IDS`
(`lib/operators.ts`) are matched at token-mint time and stamped as `isOperator` in the access JWT — a
project-wide admin with no DB grant. So "the admin" is simply a user whose email is in `OPERATOR_EMAILS`;
that's why bootstrapping is *create a native user* (step 4) *+ add its email to the allowlist*, not a
migration. (Within-project owner/admin/steward grants are separate DB roles in `project_roles` — see
`CLAUDE.md`.) There is no native-mode confirmation email transport by default: the `ConsoleEmailSender`
logs confirm/reset links at `debug`, so either run `seed-native-admin.mjs` (pre-confirmed) or read the
link out of the server log.

### Database (`DATABASE_URL`)

Just a connection string. Self-host points it at the `db` container
(`postgres://postgres:<pw>@db:5432/postgres`, a direct `:5432` connection — `prepare:false` stays
valid). No schema or migration changes; the same `scripts/migrate.mjs` runs against either backend.

## Switching an existing deployment

The seams are designed for **fresh** self-hosted deploys. Moving a *live* Supabase deployment to
self-hosted means migrating the data, which is out of scope for the seam:

- **Files** already in Supabase Storage keep their old absolute URLs in `files.original_path`; new
  uploads go to MinIO. Copy the objects + rewrite the URLs if you need the old media on the new store.
- **Auth users** in Supabase Auth aren't in the native `auth_credentials` table; switching
  `auth_provider` to `native` doesn't move passwords. Plan a migration / re-registration.

## Security posture

The S3 public bucket carries the **same posture as the Supabase public bucket** documented in
`SECURITY.md`: media is public-read by design, protected by unguessable UUID keys, never by ACLs.
Don't put private data behind it. MinIO root credentials and `POSTGRES_PASSWORD` are real secrets —
set strong values and keep `.env` out of version control. In production the Caddy front door (which
rides the data-plane profiles — it comes up with the API; auto-HTTPS + HSTS + body cap) is the public
entrypoint — firewall the now-internal `:4000`/`:4001`/
`:9000` host ports.
