# Pluggable storage + self-contained deploy — design spec

**Date:** 2026-06-18
**Status:** Approved (design); pending implementation plan
**Scope owner:** Jenova

## Context

Agora's API currently depends on Supabase for three things: **Postgres** (`DATABASE_URL`),
**Storage** (file/image uploads → a public `agora` bucket, via `lib/storage.ts` + the Supabase JS
client), and **Auth** (one of two providers — `projects.authProvider` already selects `native` vs
`supabase`). OAuth is additionally Supabase-brokered (`lib/oauth.ts`, PKCE through GoTrue).

We want the **same** server to run **either** fully self-contained (local Postgres + MinIO, native
auth) **or** backed by Supabase — selectable by configuration. This is **not** a replacement of
Supabase; Supabase remains a first-class, default backend. We extend the provider-seam pattern the
auth layer already uses to the one surface that is still hard-wired to the Supabase SDK: **Storage**.

The audit that motivated this:
- **Storage** is the only remaining Supabase-SDK-specific *code* (`lib/storage.ts`, plus the Supabase
  client in `lib/oauth.ts` / `routes/misc.ts`).
- **DB self-hosting is config-only**: the schema needs `pgvector` + `PostGIS` + `pgmq`, and the RLS
  migrations reference Supabase roles (`authenticated`/`anon`, `auth.uid()`). The `supabase/postgres`
  image bundles all of these, so migrations apply unchanged — no code change, just a compose service.
- **OAuth** is inherently Supabase-brokered; a self-contained deploy simply doesn't offer it (password
  auth only).

## Goals

1. A `StorageProvider` seam with two interchangeable implementations (Supabase, S3/MinIO), selected
   deployment-wide by one env var, **defaulting to `supabase`** so existing deployments are unchanged.
2. A `selfhost` docker-compose profile that brings up a local `db` (`supabase/postgres`) + `minio`,
   wired so `docker compose --profile selfhost up` + the existing migrator yields a working,
   Supabase-cloud-free stack.
3. Permanent, browser-reachable public URLs for self-hosted media, served through the edge we already
   control (no separate domain, no API bandwidth cost).
4. Clean degradation: in a Supabase-less deploy, OAuth and the Supabase auth provider are disabled
   without runtime errors; new projects default to native auth.

## Non-goals

- Replacing or removing Supabase (it stays the default).
- Per-project storage backends (deployment-wide only — storage is an infra concern; per-project adds
  per-backend URL bases + cross-backend migration with no real use case yet — YAGNI).
- Read-time URL recomputation / backend migration of existing files. `files.url` keeps persisting the
  resolved URL; switching backends affects only *new* uploads (one backend per deployment, documented).
- A MinIO `mc` bootstrap sidecar (the provider creates the bucket + policy lazily in-code).
- Object storage for `@agora/secure-chat` (it stores only `bytea` in Postgres; no storage dependency).

## Design

### 1. The storage seam (`apps/api/src/lib/storage/`)

```ts
export interface StorageProvider {
  /** Store bytes at `key`; return the persisted public URL. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  /** The public URL for an already-stored key (no I/O). */
  publicUrl(key: string): string;
  /** Lazy one-time setup (ensure bucket exists + is publicly readable). Optional. */
  init?(): Promise<void>;
}
```

Module layout:
- `lib/storage/index.ts` — `getStorage(): StorageProvider`, a memoized singleton selected by
  `env.STORAGE_PROVIDER` (`"supabase"` default | `"s3"`). Re-exports the backend-agnostic utils.
- `lib/storage/supabase.ts` — `SupabaseStorageProvider`: today's logic verbatim (bucket `agora`,
  lazy `ensureBucket` with `public:true`, `getPublicUrl`).
- `lib/storage/s3.ts` — `S3StorageProvider`: `@aws-sdk/client-s3` with `forcePathStyle: true` (MinIO).
  `put` = `PutObjectCommand`; `publicUrl(key)` = `` `${S3_PUBLIC_URL}/${key}` ``; `init` lazily
  `CreateBucket` (ignore "already owned") + `PutBucketPolicy` with an anonymous `s3:GetObject`
  read policy — mirroring the Supabase provider's lazy public-bucket creation, so no sidecar.
- `lib/storage/util.ts` — `assertUploadSize` + `inferFileType` (backend-agnostic; moved out of the
  current `lib/storage.ts`).

`lib/storage.ts` becomes a thin re-export shim (`export * from "./storage/index.js"`) so the existing
import sites (`routes/storage.ts`) are unchanged except swapping `uploadBytes(path, …)` →
`getStorage().put(key, …)`. **The `files` table, the `files` row shape, and all API response shapes
are untouched.**

**Security posture (unchanged):** the bucket is world-readable; keys are unguessable UUIDs (the
already-accepted, already-documented posture for the Supabase public bucket — see SECURITY.md). The
S3 provider applies the same posture via the bucket policy. No new leak surface.

### 2. Environment

All optional; `STORAGE_PROVIDER=s3` makes the `S3_*` group required (validated in `env.ts`, empty =
unset per the existing convention):

| Var | Default | Notes |
|-----|---------|-------|
| `STORAGE_PROVIDER` | `supabase` | `supabase` \| `s3`. Default keeps existing deploys unchanged. |
| `S3_ENDPOINT` | — | e.g. `http://minio:9000`. |
| `S3_REGION` | `us-east-1` | MinIO ignores it; the SDK requires one. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | MinIO root creds (or scoped). |
| `S3_BUCKET` | `agora` | |
| `S3_PUBLIC_URL` | `${PUBLIC_BASE_URL}/media` | Browser-facing base; `<key>` appended. |
| `S3_FORCE_PATH_STYLE` | `true` | Required for MinIO. |

### 3. Compose (`selfhost` profile) + edge

- **`db`** — `supabase/postgres` (bundles pgvector + PostGIS + pgmq + `authenticated`/`anon`/
  `service_role` roles + `auth` schema/`auth.uid()`), named volume, `pg_isready` healthcheck,
  `POSTGRES_PASSWORD` from env. Self-host deploys set
  `DATABASE_URL=postgres://postgres:<pw>@db:5432/postgres` (direct `:5432`; `prepare:false` stays
  valid). Migrations apply via the existing one-off: `docker compose run --rm agora node
  scripts/migrate.mjs`. Profile: `selfhost`.
- **`minio`** — `minio/minio`, named volume, API `:9000` + console `:9001`,
  `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` from env, `curl -f /minio/health/ready` healthcheck.
  Profile: `selfhost`. The provider's `init` creates the bucket + public-read policy on first upload.
- **admin nginx** (`apps/admin/nginx.conf.template`) gains one lazy-resolved location (mirrors the
  secure-chat ones):
  ```nginx
  # /media/<key>  ->  minio:9000/<bucket>/<key>   (strips /media/, prepends the bucket)
  location /media/ {
      set $minio_upstream "${MINIO_UPSTREAM}";   # e.g. http://minio:9000
      rewrite ^/media/(.*)$ /${S3_BUCKET}/$1 break;
      proxy_pass $minio_upstream;
      proxy_set_header Host $host;
  }
  ```
  yielding permanent public URLs `${PUBLIC_BASE_URL}/media/<uuid-key>`, cached at the edge, with zero
  bandwidth through the Node API. The admin service env gains `MINIO_UPSTREAM` (`http://minio:9000`) +
  `S3_BUCKET` (same bucket name the app uses; both consumed by nginx envsubst). Lazy-resolved → absent
  MinIO 502s `/media/` rather than crashing nginx, matching the secure-chat pattern. The Caddy `edge`
  profile needs no change (it forwards to admin nginx).

All `selfhost` services compose with the existing `secure` / `scale` / `edge` profiles.

### 4. Data flow

**Upload** (`POST /storage`, `POST /storage/images`): unchanged validation (`assertUploadSize`) →
sharp variants (images) → `getStorage().put(key, bytes, contentType)` → persist `files` row with the
returned URL → respond. The only swapped line is the storage call.

**Serve:** the client fetches `files.url` directly. Supabase → Supabase public URL; S3 →
`${PUBLIC_BASE_URL}/media/<key>` → edge → MinIO public-read object. No API involvement either way.

### 5. Graceful degradation (Supabase-less deploy)

- **OAuth:** `oauthConfigured()` is already false without `SUPABASE_URL`/`SUPABASE_ANON_KEY`. Verify
  every `/oauth/*` endpoint (in `routes/misc.ts`) checks it and returns a clean "not configured"
  (e.g. 503 `oauth/disabled`) instead of throwing on a lazy `pkceClient()`.
- **Auth provider default:** today `projects.authProvider` selects the provider; a self-contained
  deploy must use `native`. Add `DEFAULT_AUTH_PROVIDER` (env, default `supabase` for back-compat) read
  where a new project's `authProvider` is set, so a Supabase-less deploy defaults new projects to
  `native` rather than minting `supabase` and failing on first sign-up. (If new-project creation
  doesn't currently set `authProvider` from config, document the operator step + the column default.)
- **Supabase Storage provider** is simply not selected when `STORAGE_PROVIDER=s3`; the Supabase client
  is never constructed (it's lazy), so missing `SUPABASE_*` is fine.

### 6. Testing

- **Unit:** provider *selection* (`getStorage()` returns the right impl per `STORAGE_PROVIDER`, throws
  a clear error on `s3` with missing `S3_*`), and `S3StorageProvider` key→`publicUrl` construction +
  `put` command shape (mock the S3 client — no network). Mirrors the hermetic style of the existing
  suites.
- **Opt-in/manual:** live `put` + edge-serve against a real MinIO (a compose smoke), kept out of the
  hermetic suite exactly like the existing opt-in Supabase storage tests.
- Gates: `pnpm -r typecheck` + `pnpm test` green; a manual `docker compose --profile selfhost up` +
  upload + fetch round-trip documented in the verification section.

## Phasing

1. **Storage seam** — `lib/storage/` (interface + Supabase impl wrapping current + S3 impl + selection
   + util split), `env.ts` `S3_*` vars, `routes/storage.ts` call-site swap, `lib/storage.ts` shim,
   `@aws-sdk/client-s3` dep, unit tests.
2. **MinIO + edge** — `minio` compose service (`selfhost`), nginx `/media/` location + admin env, the
   provider `init` bucket/policy.
3. **Self-hosted DB** — `db` compose service (`supabase/postgres`, `selfhost`), migrate wiring, the
   `.env.example` / docs for `DATABASE_URL` local.
4. **Degradation + docs** — OAuth gating verification, `DEFAULT_AUTH_PROVIDER`, a new
   `docs/SELF-HOSTING.md` (run-the-stack-with-no-Supabase guide), SECURITY.md note (S3 public bucket =
   same posture), CHANGELOG, CLAUDE.md.

## Key decisions (made, backward-compatible by default)

- **Default `STORAGE_PROVIDER=supabase`** — existing deployments behave identically; self-host is opt-in.
- **`files.url` persists the resolved URL** (no read-time recomputation) — simpler; acceptable because
  it's one backend per deployment. Switching backends serves old files from their original URL.
- **`@aws-sdk/client-s3`** (the S3 standard; works against MinIO via endpoint + `forcePathStyle`).
- **Public bucket via the edge** (not API-proxied streaming) — permanent cacheable URLs, no API
  bandwidth; the cost (a world-readable bucket) is the posture already accepted for Supabase.
- **In-code lazy bucket `init`** (no `mc` sidecar) — mirrors the Supabase provider; fewer moving parts.

## Risks / open items

- **`DEFAULT_AUTH_PROVIDER` wiring** depends on where/whether new-project creation sets `authProvider`;
  Phase 4 must confirm the exact insertion point (or fall back to documenting the column default + an
  operator step).
- **`supabase/postgres` image** pin + first-boot time (it runs Supabase's init); the migrator must wait
  for the `pg_isready` healthcheck. Validate a real `--profile selfhost` boot.
- **`S3_PUBLIC_URL` correctness** behind the edge: the nginx `/media/` rewrite must match the
  `publicUrl` the provider returns; covered by the manual round-trip in verification.
- Container builds / compose were not run in the dev environment for the secure-chat work either;
  validate `docker compose --profile selfhost up` for real before declaring done.

## Verification

1. `STORAGE_PROVIDER` unset / `supabase` → behavior identical to today (regression: existing storage
   integration path unchanged).
2. `docker compose --profile selfhost up` (+ `secure`/`edge` as desired); run the migrator against the
   local `db`; confirm `pg_isready` gate + migrations apply on `supabase/postgres`.
3. `STORAGE_PROVIDER=s3`: `POST /storage/images` → 201; the returned `files.url` is
   `${PUBLIC_BASE_URL}/media/<key>`; `GET` that URL through the edge returns the object from MinIO
   (bucket auto-created + public-read on first upload).
4. Supabase-less: `/oauth/*` returns a clean "not configured"; a new project + native sign-up works.
5. `pnpm -r typecheck` + `pnpm test` green (provider selection + S3 URL/command unit tests).
