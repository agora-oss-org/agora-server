# Self-hosting Agora without Supabase

Agora ships pointed at Supabase by default, but the same `@agora/api` image runs **fully
self-contained** — local Postgres + local object storage + a bundled Supabase Auth (GoTrue) for
passwords **and** social sign-in — with no Supabase account at all. Supabase is one of two interchangeable backends, not a hard dependency.

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
| Auth     | Supabase Auth (passwords + OAuth)   | Bundled **GoTrue** (passwords + Google/Apple/GitHub SSO), or native in-API passwords | `DEFAULT_AUTH_PROVIDER` + `projects.auth_provider` |

The `selfhost` compose profile is one of the two data planes: it brings up the API itself plus the two
local backends (you do NOT pair it with `full` to get the API). It's opt-in — a Supabase-backed deploy
runs `--profile supabase` instead and points the env at Supabase. (Compose services are all
profile-gated, so a bare `docker compose up` starts nothing.)

## Quick start (whole stack, no Supabase)

1. **Start from the local template.** [`.env.selfhost.example`](../.env.selfhost.example) is a ready-made
   config for exactly this deploy — `--profile selfhost` (or `--profile full --profile selfhost`) — with
   every self-hosted var pre-wired (local Postgres, MinIO, bundled GoTrue auth, the Caddy front door on
   plain HTTP) and a generator command beside each secret placeholder. Copy it to `.env` and fill the
   `<GENERATE: …>` placeholders (compose reads `.env` for both `${VAR}` interpolation **and** the
   services' `env_file`):

   ```bash
   cp .env.selfhost.example .env            # copy the template
   # …fill the <GENERATE:…> placeholders (openssl commands are shown inline)…
   ```

   The self-hosted block it sets (what you'd otherwise assemble by hand):

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

   # Auth — bundled GoTrue (Supabase Auth, self-hosted): email+password AND social login.
   # Generate the trio with: node apps/api/scripts/gen-gotrue-keys.mjs
   DEFAULT_AUTH_PROVIDER=supabase
   SUPABASE_URL=http://proxy:9998            # internal shim — server-side calls only
   SUPABASE_PUBLIC_AUTH_URL=http://localhost # public origin used in browser-facing OAuth URLs
   SUPABASE_ANON_KEY=<gen-gotrue-keys.mjs>
   SUPABASE_SERVICE_ROLE_KEY=<gen-gotrue-keys.mjs>
   GOTRUE_JWT_SECRET=<gen-gotrue-keys.mjs>
   GOTRUE_EXTERNAL_URL=http://localhost/auth/v1
   GOTRUE_SITE_URL=http://localhost

   # Required regardless of backend
   ACCESS_TOKEN_SECRET=<openssl rand -base64 48>
   ```

   > Prefer no extra auth container? The template keeps Agora's **native** email+password backend as a
   > commented alternative block (`DEFAULT_AUTH_PROVIDER=native` + the Postmark vars) — email+password
   > only, no social login. See **SSO / social login** below for the full GoTrue story.

   > The template uses `SERVER_NAME=:80` (plain HTTP) and `S3_PUBLIC_URL=http://localhost/media` for a
   > friction-free local run — `http://localhost` is a browser "secure context", so secure-chat's
   > WebCrypto still works. For a real host, set `SERVER_NAME=<your.domain>` and
   > `S3_PUBLIC_URL=https://<your.domain>/media` (auto-HTTPS).
   >
   > ⚠️ **Going to production with a real domain:** the Caddy front door defaults to the Let's Encrypt
   > **staging** CA (untrusted certs, but safe against prod rate limits while you validate DNS/firewall).
   > Set `ACME_CA=https://acme-v02.api.letsencrypt.org/directory` in `.env` for real, browser-trusted
   > certs. See [deploy/proxy/README.md](../deploy/proxy/README.md#run-it).
   >
   > **`AGORA_PUBLIC_APP_URL`** is the origin of your **public consumer app** — the community front end
   > your users actually visit. The admin builds its "Open in app" deep links (on reports, AI flags, and
   > steward cases) from it; leave it unset and those links point at the local demo dev server
   > (`http://localhost:5174/`), which is wrong on a real deployment. If you're serving the demo behind
   > this front door, the natural value is `http://localhost/demo/` (or `https://<your.domain>/demo/`) —
   > what the template sets. The admin is a static Vite build baked into the proxy image, so its `VITE_*`
   > vars are fixed at **build** time and unreachable on a *pulled* image — every admin setting is
   > therefore read at **runtime** from `/config.js`, which the proxy container's entrypoint rewrites from
   > its env on every start. So `AGORA_PUBLIC_APP_URL=https://community.example.com/ docker compose up -d
   > proxy` retargets a running deployment with no rebuild.
   >
   > The same seam carries the rest of the admin's settings as optional **`AGORA_ADMIN_*`** vars (project
   > id, API/moderator bases, the Social tab, the demo login) — all listed, commented out, in the `.env`
   > template, with the full table in [apps/admin/README.md](../apps/admin/README.md). Two carry warnings
   > worth reading before you set them: `AGORA_ADMIN_DEMO_EMAIL`/`_PASSWORD` are **public** (served to
   > every visitor, as any browser-side login prefill must be — use the shared demo account only), and
   > `AGORA_ADMIN_SETTINGS_READ_ONLY` is a **UI guard, not a security boundary** (pair it with the
   > server's `OPERATOR_RO_EMAILS`, which is the real enforcement).

2. **Bring the stack up** — `--profile selfhost` is the API + local db + minio (incl. the Caddy front
   door); add `--profile full` for all optional add-ons, or `--profile scorer`/`--profile secure-chat`/
   `--profile scale` individually:

   ```bash
   docker compose --profile selfhost up --build
   ```

   This starts `db`, `minio`, `gotrue` (bundled Supabase Auth — see **SSO / social login** below),
   `agora`, `proxy` (the Caddy front door that serves the admin SPA) (+ `cron`).
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

   > **`password authentication failed for user "postgres"`?** Postgres only applies `POSTGRES_PASSWORD`
   > when it **first initializes** the data volume. If a `*_db-data` volume already exists from an earlier
   > run, it keeps its old password and ignores the new one. Start the `db` fresh:
   > `docker compose --profile selfhost down -v` (⚠️ wipes local DB + MinIO data) then `up` again.

   For a dev box you can instead `node scripts/genesis.mjs` (drop → rebuild → seed); it stamps the seed
   project's `auth_provider` from `DEFAULT_AUTH_PROVIDER`. When `NEO4J_URI` is set it also **resets the
   social graph** (`NEO4J_DATABASE ?? "neo4j"`) so stale `INTERACTED`/`FOLLOWS`/… edges can't outlive the
   freshly-rebuilt Postgres rows — a **secondary** db is dropped + recreated, the **default/home** db is
   emptied in place with `DETACH DELETE` (recreating the home db at runtime isn't safe on DozerDB). It
   **confirms first** (type the `host/db` graph ref; `--force` skips, non-interactive without `--force`
   refuses), is best-effort (a down Neo4j warns but doesn't fail the run), and is skipped under `--test`.

4. **Bootstrap the first admin.** A virgin DB has no users, and native auth gates sign-in on email
   confirmation. Unless you've configured Postmark (`POSTMARK_SERVER_TOKEN` + a Postmark-verified
   `AUTH_EMAIL_FROM`, and `AUTH_EMAIL_LINK_BASE` = your front-end origin — see `.env.prod.example`), the
   default `ConsoleEmailSender` only *logs* the confirm link and delivers no mail. So seed a
   **pre-confirmed** native credential directly, then make it an operator:

   ```bash
   # the credential is confirmed in-DB (no email round-trip); -it gives the prompt a TTY
   docker compose run --rm -it agora node scripts/seeds/helpers/seed-native-auth-admin.mjs
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
   native half of the admin seed; `helpers/seed-supabase-auth-admin.mjs` is the Supabase counterpart,
   and the `00-seed-auth-admin.mjs` master drives whichever backend is active from one prompt.)

5. **Done.** The Caddy front door serves the admin SPA on `:443` (and `:80`). Uploads land in
   MinIO and are served back through `https://your-host/media/<key>`.

## Try the demo app (the `demo` profile)

Want to *see* the forked Replyke SDK exercising your server? Add `--profile demo` and the prebuilt
[agora-demo](../../agora-demo) compatibility harness comes up behind the same Caddy front door at
**`/demo/`** — same-origin with the API at `/v7`, so there's no CORS and chat sockets just work:

```bash
docker compose --profile selfhost --profile demo up    # API + demo at http://localhost/demo/
```

It's a **pulled, prebuilt image** (`docker.io/agoraserver/agora-demo:latest`) — never built from source
here; the demo is an arms-length consumer of the *published* SDK on purpose. The published bundle bakes
its URLs at build time, so the image is retargeted at container start: its nginx entrypoint writes
`/config.js` from `AGORA_DEMO_API_BASE_URL` (default `http://localhost/v7`) and the app reads it before
the bundle loads. For a real domain, set `AGORA_DEMO_API_BASE_URL=https://<your-host>/v7` in `.env`
(it must be absolute — the SDK derives the socket.io origin from it). Pin a version with
`AGORA_DEMO_IMAGE` instead of `latest`.

**Seed the demo login first.** The demo's login form pre-fills `agora-admin@agora-oss.org` / `DemoPass123!`
against project `11111111-1111-1111-1111-111111111111` — like the API URL, that prefill is
runtime-retargeted (`AGORA_DEMO_EMAIL`/`AGORA_DEMO_PASSWORD` in `.env`, defaulted in
`docker-compose.yml` to match what `00-seed-auth-admin.mjs` itself defaults to). Seed that credential
*after* step 3's genesis (the project must already exist) — press Enter twice to accept both defaults:

```bash
  docker compose run --rm agora node scripts/seeds/00-seed-auth-admin.mjs   # native (selfhost)
```

If you override `AGORA_DEMO_EMAIL`/`AGORA_DEMO_PASSWORD` in `.env`, seed that same address instead
(`ADMIN_EMAIL=... ADMIN_PASSWORD=... docker compose run --rm agora node scripts/seeds/00-seed-auth-admin.mjs`).

**The shared public demo login is settings-read-only.** The second seeded admin,
`demo-admin@agora-oss.org` / `DemoAdmin123!` (a `seed.json` manifest user with a `project_roles` owner
grant — created by the demo-content seeders, see `apps/api/README.md` → "Seeding"), is listed in
`OPERATOR_RO_EMAILS` in `.env.selfhost.example`. That account gets the full operator/admin view
but is server-blocked (`403 settings/read-only`) from the five settings-save endpoints — safe to hand
out as a public demo login without risking the deployment's own config.

`00-seed-auth-admin.mjs` seeds whichever backend the project uses — native (selfhost) or, on a
Supabase-backed deploy, a confirmed Supabase auth user. The full demo experience (secure chat tab) also
needs `--profile secure-chat`; semantic search needs `VOYAGE_API_KEY` — without them those tabs simply
degrade.

> **Note (compose hot-edit on macOS).** Editing `deploy/proxy/agora-routes.caddy` while the proxy is
> running may not take effect: Docker Desktop's bind mount can serve the container a stale view. Force a
> fresh read with `docker compose up -d --force-recreate --no-deps proxy`.

## SSO / social login (bundled GoTrue)

The `selfhost` profile bundles **Supabase Auth (GoTrue)** as its own container — email+password
**and** Google / GitHub / Apple sign-in with **no cloud dependency**. Every Supabase-auth call in the
API already goes through supabase-js (`${SUPABASE_URL}/auth/v1/*` — GoTrue's API), so the existing
`supabase` auth provider and the PKCE OAuth brokering work against the local GoTrue unchanged.

**Architecture.** GoTrue (`supabase/auth`) runs against the local `supabase/postgres` `db` (which
ships the `auth` schema + `supabase_auth_admin` role; GoTrue applies its own migrations there at
boot). It is reached ONLY through the Caddy front door, on two routes:

- **Public `/auth/v1/*`** — what browsers, OAuth provider callbacks (`/auth/v1/callback`), and email
  links (`/auth/v1/verify`) hit. Admin endpoints under `/auth/v1/admin/*` are gated by GoTrue itself
  (the `service_role` JWT) — the same public posture as cloud Supabase.
- **Internal `:9998`** — a proxy-internal listener the API uses as `SUPABASE_URL`
  (`http://proxy:9998`), so server-side calls never hairpin through the public origin. It is not
  published to the host; never expose it. Because browser-facing OAuth authorize URLs are built from
  `SUPABASE_URL`, the API swaps in **`SUPABASE_PUBLIC_AUTH_URL`** (your public origin) before
  returning them — set it or social login buttons will point at the internal name.

**Setup.**

1. Generate the key trio and paste it into `.env` (the anon/service_role "keys" are long-lived HS256
   JWTs signed with the GoTrue secret — exactly what cloud Supabase issues):

   ```bash
   node apps/api/scripts/gen-gotrue-keys.mjs
   # GOTRUE_JWT_SECRET=…  SUPABASE_ANON_KEY=…  SUPABASE_SERVICE_ROLE_KEY=…
   ```

   ⚠️ `SUPABASE_SERVICE_ROLE_KEY` is a **root credential** for the auth store — server-only, never in
   client code or logs.

2. Set the public URLs: `GOTRUE_EXTERNAL_URL=https://<your.domain>/auth/v1` (what OAuth providers
   redirect back to), `GOTRUE_SITE_URL` (your front-end origin), `GOTRUE_URI_ALLOW_LIST`
   (comma-separated globs of every origin your apps return to after sign-in), and
   `SUPABASE_PUBLIC_AUTH_URL=https://<your.domain>`.

3. Email: set the `GOTRUE_SMTP_*` block (host/port/user/pass/sender) for real confirmation +
   password-reset mail. For a quick trial, `GOTRUE_MAILER_AUTOCONFIRM=true` skips email entirely
   (sign-ups confirm instantly; password-reset-by-email is unavailable).

4. `docker compose --profile selfhost up -d` — a **fresh** db volume auto-provisions the
   `supabase_auth_admin` password via [`deploy/db/init-auth-role.sql`](../deploy/db/init-auth-role.sql)
   (the image itself doesn't derive one from `POSTGRES_PASSWORD`). A volume initialized **before**
   that file existed needs the one-time equivalent by hand, then a `gotrue` restart:

   ```bash
   docker compose exec db psql -h 127.0.0.1 -U supabase_admin -d postgres \
     -c "alter role supabase_auth_admin password '<POSTGRES_PASSWORD>'"
   docker compose restart gotrue
   ```

   > direnv users: an `.envrc` that exports repo env vars **shadows `.env`** during compose
   > interpolation (shell env wins). If a value change mysteriously doesn't take, check `direnv` first.

**Per-provider setup.** Every provider's authorized redirect URI is
`${GOTRUE_EXTERNAL_URL}/callback` (e.g. `https://<your.domain>/auth/v1/callback`). Enable each with
its `GOTRUE_EXTERNAL_<PROVIDER>_*` env block (all off by default):

- **Google** — [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → Create
  OAuth client ID (Web application) → add the redirect URI → copy client id + secret into
  `GOTRUE_EXTERNAL_GOOGLE_{ENABLED,CLIENT_ID,SECRET}`.
- **GitHub** — GitHub → Settings → Developer settings → OAuth Apps → New OAuth App → set the
  callback URL → copy into `GOTRUE_EXTERNAL_GITHUB_{ENABLED,CLIENT_ID,SECRET}`.
- **Apple** — needs a paid Apple Developer account: create a **Services ID** (this is the
  `CLIENT_ID`), enable "Sign in with Apple" for it with your domain + the redirect URI, and create a
  **key** (`.p8`) with Sign in with Apple. Apple's client "secret" is itself a signed ES256 JWT that
  **expires (≤180 days)** — generate it, and regenerate before expiry (a recurring operational task):

  ```bash
  node apps/api/scripts/gen-apple-client-secret.mjs --key AuthKey_<KEYID>.p8 \
    --team-id <TEAM_ID> --client-id <SERVICES_ID> --key-id <KEYID>
  # → GOTRUE_EXTERNAL_APPLE_SECRET=… (stderr prints the expiry date)
  ```

  Other GoTrue-supported providers follow the same `GOTRUE_EXTERNAL_<NAME>_*` pattern — add the env
  block to the `gotrue` service in your compose override.

**Migrating an existing native-auth deployment (opt-in).** Native auth keeps working — nothing is
removed — but to move a project onto GoTrue (and gain social login), use the migration script. It
imports each `auth_credentials` row into GoTrue **preserving the argon2id password hash** (users keep
their passwords), remaps `profiles.auth_user_id` to the new GoTrue identity, and flips
`projects.auth_provider`:

```bash
cd apps/api
node scripts/migrate-native-to-gotrue.mjs --project <uuid> --dry-run   # report first
node scripts/migrate-native-to-gotrue.mjs --project <uuid>             # apply
```

Idempotent by email; native rows are never deleted — **rollback = set `projects.auth_provider` back
to `'native'`**. A credential whose hash can't be imported degrades to reset-required (the script
reports which path each account took). The api caches the provider ~30s, so the flip takes effect
within that window (or restart `agora`).

**Redirect allowlist (open-redirect guard).** `/oauth/callback` redirects the browser back to the
client's `redirectAfterAuth` **with a freshly minted Agora session in the URL fragment** — so that
value is server-validated against `OAUTH_REDIRECT_ALLOWED_ORIGINS` (comma-separated origins, or
mobile deep-link scheme prefixes like `myapp://`) before the state is even created, and re-checked on
the callback itself. Unset → falls back to `PUBLIC_BASE_URL` (fine for the common single-origin
deploy — the admin baked into the same Caddy front door, say). If **neither** is set, `/oauth/*` fails
closed with `503 oauth/redirect-not-configured` rather than trusting the client. Add every extra
front end you run (a separately-hosted admin, a Vite dev server, a mobile app's deep link).

**Admin login buttons.** The bundled `@agora/admin` SPA can offer social sign-in buttons on its login
screen — set `AGORA_ADMIN_OAUTH_PROVIDERS=google,github,apple` (comma-separated; unset → email+password
only) via the same runtime `/config.js` seam as the other `AGORA_ADMIN_*` settings. Each listed
provider must ALSO be enabled on `gotrue` (the `GOTRUE_EXTERNAL_<PROVIDER>_*` block above) — the admin
var only decides which buttons render, GoTrue decides whether the provider actually works. The admin
signs in the same way the SDK does: `POST /oauth/authorize` → provider consent → GoTrue callback →
`/oauth/callback` → back to the admin's own `/login` route with tokens in the fragment, which it
exchanges via `POST /auth/request-new-access-token` (rotates the pair and returns the shaped user).

**Trying SSO in dev.** `docker-compose.dev.yml` also ships a `gotrue` service (opt-in, same
`selfhost` profile) — the topology differs slightly because the API runs on your **host**
(`pnpm dev`), not in a container: the browser still uses the public `http://localhost/auth/v1/*`
route, but the host-run API talks to GoTrue through the proxy's **published** internal shim
(`SUPABASE_URL=http://localhost:9998` — published only in dev; a real deploy never exposes it). See
the commented "SSO in dev" block in `.env.dev.example` for the full var list (generate the key trio,
uncomment, `docker compose -f docker-compose.dev.yml --profile selfhost up -d`). Dev still **defaults**
to native auth — this is opt-in, not a change to the zero-infra baseline.

**Deploying GoTrue to production — checklist.** The compose files wire everything for a single-box
deploy; on anything else (Swarm, Kubernetes, a hand-run image) these are the load-bearing facts, in the
order they bite:

1. **Database role first.** `supabase/postgres` → the `init-auth-role.sql` init script covers a *fresh*
   volume; an *existing* volume needs the one-time `ALTER ROLE` above. Any other Postgres → run
   [`bootstrap-gotrue-role.sql`](#3-gotrue-on-your-own-postgres-sso-without-the-supabasepostgres-image)
   before the first start. GoTrue **crash-loops until this exists** — it self-migrates at boot.
2. **One key trio, two services.** `GOTRUE_JWT_SECRET` (on `gotrue`) and `SUPABASE_ANON_KEY` /
   `SUPABASE_SERVICE_ROLE_KEY` (on the API) come from **one** run of `gen-gotrue-keys.mjs`. Mix
   generations and every token is rejected. `SUPABASE_SERVICE_ROLE_KEY` is a root credential for the
   auth store — secrets store only.
3. **The proxy image must carry the `:9998` shim.** `SUPABASE_URL` cannot point at GoTrue directly:
   supabase-js appends `/auth/v1/*` and GoTrue serves at its root, so `http://gotrue:9999/auth/v1/token`
   404s. It must hit the path-stripping listener the `agora-proxy` image exposes internally on `:9998`
   — an image built from a release that predates the GoTrue work has no such listener. Never publish
   that port.
4. **Four URL vars, all your public origin.** `GOTRUE_EXTERNAL_URL` (= what every provider console gets
   as the redirect URI, + `/callback`), `GOTRUE_SITE_URL`, `GOTRUE_URI_ALLOW_LIST`, and the API's
   `SUPABASE_PUBLIC_AUTH_URL`. Forget the last one and the social buttons send browsers to your
   *internal* proxy name.
5. **Every front end in BOTH allowlists** — `GOTRUE_URI_ALLOW_LIST` (GoTrue's hop) *and*
   `OAUTH_REDIRECT_ALLOWED_ORIGINS` (the API's hop). The admin SPA counts: its login button sends
   `redirectAfterAuth=<admin origin>/login`, and an origin missing from the API allowlist fails with
   `400 oauth/redirect-not-allowed`.
6. **Email is GoTrue's, not the API's.** Supabase-provider projects never touch `POSTMARK_*` /
   `AUTH_EMAIL_*`; GoTrue sends its own via `GOTRUE_SMTP_*`. `GOTRUE_MAILER_AUTOCONFIRM=true` is the
   no-mail escape hatch for trials (no password-reset-by-email). Postmark works as plain SMTP —
   `smtp.postmarkapp.com:587`, server token as **both** user and password.
7. **Register the real callback with each provider** — `<GOTRUE_EXTERNAL_URL>/callback`. Apple
   additionally refuses `localhost` and any non-HTTPS origin, so Apple can only ever be verified on a
   real deployment; Google accepts `http://localhost/...` alongside the production URI on one client.
8. **Apple's secret expires.** `GOTRUE_EXTERNAL_APPLE_SECRET` is a signed JWT capped at 180 days —
   `gen-apple-client-secret.mjs` prints the expiry; rotate it before then or Apple sign-in fails silently.
9. **Existing projects stay native until migrated.** `DEFAULT_AUTH_PROVIDER` only stamps *new*
   projects; the running API reads `projects.auth_provider`. Deploy GoTrue, confirm it is healthy
   (`GET /auth/v1/health` through the front door), **then** run `migrate-native-to-gotrue.mjs` — it calls
   GoTrue's admin API, so GoTrue must be up first. From a workstation, point `SUPABASE_URL` at the
   **public** origin for that run (your laptop can't resolve the internal proxy name).

**Troubleshooting.** Every entry below was hit for real while building this.

| Symptom | Cause | Fix |
|---|---|---|
| `gotrue` crash-loops: `password authentication failed for user "supabase_auth_admin"` … `User … has no password assigned` | `supabase/postgres` volume initialized before the init script existed | the one-time `ALTER ROLE … PASSWORD` as `supabase_admin` (setup step 4), then `restart gotrue` |
| same message on your **own** Postgres | the role does not exist / lacks grants | `bootstrap-gotrue-role.sql` (§3) |
| `permission denied for schema public` / `must be owner of function uid` | plain Postgres, naive grants | `bootstrap-gotrue-role.sql` — it pins `search_path` and moves ownership |
| `POST /oauth/authorize` returns an `authorizationUrl` on `http://proxy:9998/…` | `SUPABASE_PUBLIC_AUTH_URL` unset | set it to the public origin |
| `400 oauth/redirect-not-allowed` | the front end's origin is not in `OAUTH_REDIRECT_ALLOWED_ORIGINS` | add it (or `PUBLIC_BASE_URL` for a single-origin deploy) |
| `503 oauth/redirect-not-configured` | neither `OAUTH_REDIRECT_ALLOWED_ORIGINS` nor `PUBLIC_BASE_URL` set | set one — the guard fails closed by design |
| GoTrue: `Unsupported provider: provider is not enabled` | the button is on (`AGORA_ADMIN_OAUTH_PROVIDERS`) but `GOTRUE_EXTERNAL_<P>_ENABLED` is not | enable + configure the provider on `gotrue` |
| Google: `redirect_uri_mismatch` | the console lacks `<GOTRUE_EXTERNAL_URL>/callback` | add it to the OAuth client (propagation can take minutes) |
| a var change "doesn't take" after `docker compose restart` | `restart` never re-reads `.env`; and a direnv-exported shell var **overrides** `.env` during interpolation | `up -d --force-recreate <svc>`; run compose with `env -u VAR …` or a clean env |
| `pnpm genesis` / seed scripts: `getaddrinfo ENOTFOUND db` | `.env` holds container hostnames, the script runs on the host | prefix the run with `DATABASE_URL=…@localhost:5432/… SUPABASE_URL=http://localhost` |

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

That's the whole surface for the **API** — no `auth.users` table or FK is required
(`profiles.auth_user_id` is a plain uuid the app links). The copy-paste version of this bootstrap (plus
the extension schema layout the migrations expect) is
[`apps/api/scripts/bootstrap-supabase-compat.sql`](../apps/api/scripts/bootstrap-supabase-compat.sql).
With native auth that is everything; with GoTrue there is one more step.

### 3. GoTrue on your own Postgres (SSO without the `supabase/postgres` image)

The bundled GoTrue connects as **`supabase_auth_admin`** and self-migrates its tables into the `auth`
schema at boot. The `supabase/postgres` image ships that role ready-made, so the `selfhost` profile only
has to give it a password ([`deploy/db/init-auth-role.sql`](../deploy/db/init-auth-role.sql), a
first-boot init script). **A plain Postgres has no such role**, and — verified against `postgres:17`
seeded exactly like the bootstrap above — the obvious `CREATE ROLE` + `GRANT ON SCHEMA auth` is *not*
enough. GoTrue dies twice on the way:

| GoTrue log line | Cause | Fix |
|---|---|---|
| `permission denied for schema public` | GoTrue creates its `schema_migrations` bookkeeping table wherever `search_path` points — `public` by default | `ALTER ROLE supabase_auth_admin SET search_path TO auth` |
| `must be owner of function uid` | GoTrue's `00_init_auth_schema` ships its **own** `auth.uid()`; `CREATE OR REPLACE` needs ownership of the stub you created in §2 | make the role own the `auth` schema **and** every function already in it |

Run the packaged script **once, as a superuser, after §2 and before the first `gotrue` start** — it
does all of the above idempotently and takes the password as a psql variable (never on the command
line):

```bash
psql "postgres://<superuser>@<host>/<agora-db>" -v ON_ERROR_STOP=1 \
  -v gotrue_password='<strong password>' -f apps/api/scripts/bootstrap-gotrue-role.sql
```

then point the service at it:

```bash
GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:<that password>@<host>:5432/<agora-db>
```

(that is what the compose files derive from `POSTGRES_PASSWORD` — on your own Postgres you set it
directly, and mirror whatever `sslmode` your `DATABASE_URL` carries). Verified outcome: GoTrue creates
its 16 tables in `auth`, **nothing** lands in `public`, and the app role can still execute `auth.uid()`
— the RLS policies from migration `0017` keep working. Reusing the app's own DB role for GoTrue instead
also boots, but then GoTrue holds full read/write on every application table; the dedicated role is
the least-privilege default.

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

**OAuth (social login) is brokered by Supabase Auth** — either the cloud service or the bundled
[GoTrue](#sso--social-login-bundled-gotrue) — so it is available to any project whose `auth_provider`
is `supabase`. `/oauth/authorize` returns `oauth/not-configured` only when no `SUPABASE_URL` /
`SUPABASE_ANON_KEY` is set at all; a *native*-provider project has no social login by design (native
is the email/password-only backend).

**Operator (god-view) is an env allowlist, not a DB role.** `OPERATOR_EMAILS` / `OPERATOR_USER_IDS`
(`lib/operators.ts`) are matched at token-mint time and stamped as `isOperator` in the access JWT — a
project-wide admin with no DB grant. So "the admin" is simply a user whose email is in `OPERATOR_EMAILS`;
that's why bootstrapping is *create a native user* (step 4) *+ add its email to the allowlist*, not a
migration. (Within-project owner/admin/steward grants are separate DB roles in `project_roles` — see
`CLAUDE.md`.) **Native-auth email transport:** confirmation / password-reset / resend mail is sent via
**Postmark** when `POSTMARK_SERVER_TOKEN` is set (`AUTH_EMAIL_FROM` must be a Postmark-verified sender;
`AUTH_EMAIL_LINK_BASE` is the front-end origin the emailed links point at). Without a token the default
`ConsoleEmailSender` only *logs* confirm/reset links at `debug` — so for the first admin either run
`helpers/seed-native-auth-admin.mjs` (pre-confirmed, no email round-trip) or read the link out of the
server log. **Multiple front-ends** (e.g. `agora-oss.org` + `demo.agora-oss.org` on one API): set
`AUTH_EMAIL_LINK_ALLOWED_ORIGINS` to the comma-separated list of allowed origins; each client sends its
own origin as `emailRedirectTo` on sign-up/reset/resend, the server validates it against that allowlist
(a non-allowlisted value is rejected `400 auth/email-redirect-not-allowed` — the open-redirect guard) and
builds the link on it. Unset → links always use `AUTH_EMAIL_LINK_BASE`.

### Database (`DATABASE_URL`)

Just a connection string. Self-host points it at the `db` container
(`postgres://postgres:<pw>@db:5432/postgres`, a direct `:5432` connection — `prepare:false` stays
valid). No schema or migration changes; the same `scripts/migrate.mjs` runs against either backend.

### Boot hook (`AGORA_BOOT_MODULE`)

`AGORA_BOOT_MODULE` is an optional module specifier the `agora` and `secure-chat` processes
**side-effect-import once at startup, before serving** — the supported way for a prebuilt image to run
deployment init (e.g. registering a per-project DB resolver) without editing the bundled entrypoint.
Unset → no-op. If set and the module fails to load, the process **fails closed** (logs and exits) rather
than serve without it. It fires after env validation, the logger, and OpenTelemetry are ready.

This is the **sole supported** mechanism. Node's native `NODE_OPTIONS=--import` can technically preload a
module too, but it runs before env/logger/OTel exist and is **not** a contract Agora documents, relies on,
or tests — if you use it, you are on your own.

## Switching an existing deployment

The seams are designed for **fresh** self-hosted deploys. Moving a *live* Supabase deployment to
self-hosted means migrating the data, which is out of scope for the seam:

- **Files** already in Supabase Storage keep their old absolute URLs in `files.original_path`; new
  uploads go to MinIO. Copy the objects + rewrite the URLs if you need the old media on the new store.
- **Auth users** live in different stores per backend and flipping `projects.auth_provider` moves
  nothing by itself. **Native → GoTrue is scripted**:
  [`migrate-native-to-gotrue.mjs`](#sso--social-login-bundled-gotrue) imports every `auth_credentials`
  row into `auth.users` **preserving the argon2id password hash** (users keep their passwords), remaps
  `profiles.auth_user_id`, then flips the column; rollback is flipping it back (native rows are never
  deleted). **GoTrue/Supabase → native** has no script: `auth.users` password hashes are not exported
  to `auth_credentials` — plan a re-registration or a password-reset campaign.

## Security posture

The S3 public bucket carries the **same posture as the Supabase public bucket** documented in
`SECURITY.md`: media is public-read by design, protected by unguessable UUID keys, never by ACLs.
Don't put private data behind it. MinIO root credentials and `POSTGRES_PASSWORD` are real secrets —
set strong values and keep `.env` out of version control. In production the Caddy front door (which
rides the data-plane profiles — it comes up with the API; auto-HTTPS + HSTS + body cap) is the public
entrypoint — firewall the now-internal `:4000`/`:4001`/
`:9000` host ports.
