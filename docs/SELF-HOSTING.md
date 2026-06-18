# Self-hosting Agora without Supabase

Agora ships pointed at Supabase by default, but the same `@agora/api` image runs **fully
self-contained** — local Postgres + local object storage + in-API password auth — with no Supabase
account at all. Supabase is one of two interchangeable backends, not a hard dependency.

Three things are pluggable, each chosen by config (nothing is replaced — flip a switch):

| Concern  | Supabase (default)                  | Self-hosted                                  | Selected by            |
|----------|-------------------------------------|----------------------------------------------|------------------------|
| Database | Supabase Postgres (pooler `:6543`)  | `supabase/postgres` container (`db`)         | `DATABASE_URL`         |
| Storage  | Supabase Storage public bucket      | MinIO container (`minio`), S3 API            | `STORAGE_PROVIDER=s3`  |
| Auth     | Supabase Auth (passwords + OAuth)   | Native in-API passwords (`auth_provider`)    | `DEFAULT_AUTH_PROVIDER`|

The `selfhost` compose profile brings up the two local backends. They're opt-in: the default
`docker compose up` never starts them.

## Quick start (whole stack, no Supabase)

1. **Copy the env template** and set the self-hosted block (see `.env.example` → "Self-hosted"):

   ```bash
   # DB — local Postgres
   POSTGRES_PASSWORD=<strong-password>
   DATABASE_URL=postgres://postgres:<strong-password>@db:5432/postgres

   # Storage — local MinIO
   STORAGE_PROVIDER=s3
   S3_ENDPOINT=http://minio:9000
   S3_PUBLIC_URL=https://your-host/media     # the admin nginx /media mount (below)
   S3_ACCESS_KEY_ID=agora
   S3_SECRET_ACCESS_KEY=<strong-password>
   MINIO_ROOT_USER=agora
   MINIO_ROOT_PASSWORD=<strong-password>     # must equal S3_SECRET_ACCESS_KEY

   # Auth — native (no Supabase). Leave all SUPABASE_* unset.
   DEFAULT_AUTH_PROVIDER=native

   # Required regardless of backend
   ACCESS_TOKEN_SECRET=<openssl rand -base64 48>
   ```

2. **Bring the stack up** (add `secure`/`edge`/`scale` profiles as needed):

   ```bash
   docker compose --profile selfhost up --build
   ```

   This starts `db`, `minio`, `agora`, `admin` (+ `cron`). `agora` has `restart: unless-stopped`, so if
   it boots before `db` is ready it crash-loops briefly, then connects — no manual ordering needed.

3. **Apply migrations once** (the schema + RLS + triggers + RPC). The `supabase/postgres` image bundles
   everything the migrations assume — **pgvector**, **PostGIS**, **pgmq**, and the
   `authenticated`/`anon`/`service_role` roles + `auth.uid()` — so they apply unchanged:

   ```bash
   docker compose run --rm agora node scripts/migrate.mjs
   ```

   For a dev box you can instead `node scripts/genesis.mjs` (drop → rebuild → seed); it stamps the seed
   project's `auth_provider` from `DEFAULT_AUTH_PROVIDER`.

4. **Done.** The admin SPA is on `:8080` (or behind the `edge` Caddy proxy on `:443`). Uploads land in
   MinIO and are served back through `https://your-host/media/<key>`.

## How each seam works

### Storage (`STORAGE_PROVIDER`)

`lib/storage.ts` (`uploadBytes`/`publicUrl`) delegates to a `StorageProvider` chosen once at boot
(`lib/storage/`): `supabase` → Supabase Storage, `s3` → any S3-compatible store. The S3 provider
(`lib/storage/s3.ts`) lazily creates the bucket and applies an anonymous **public-read** policy on the
first upload — no `mc` bootstrap sidecar. Object keys are unguessable UUID paths
(`<projectId>/files/<uuid>.<ext>`).

**Public URLs never point at MinIO directly.** The stored URL is built from `S3_PUBLIC_URL`, and the
admin nginx serves a `/media/` route that rewrites `/media/<key>` → `/<bucket>/<key>` on the internal
`minio:9000` upstream. So set `S3_PUBLIC_URL=<your public origin>/media`. (Behind the `edge` Caddy
proxy, that's `https://<SERVER_NAME>/media`.)

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
set strong values and keep `.env` out of version control. Front the stack with the `edge` profile
(Caddy: auto-HTTPS + HSTS + body cap) in production and firewall the now-internal `:4000`/`:8080`/
`:9000` host ports.
