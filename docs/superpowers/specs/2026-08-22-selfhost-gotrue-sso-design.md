# Self-hosted SSO via bundled Supabase Auth (GoTrue) — Design

**Date:** 2026-08-22
**Status:** Approved (brainstorm 2026-08-22)
**Scope:** deployment/compose + docs + scripts; near-zero API code change

## Problem

A fully self-hosted Agora (`--profile selfhost`: local `supabase/postgres` + MinIO,
`auth_provider=native`) has **no SSO / social login path**. OAuth today is Supabase-brokered
(`lib/oauth.ts`, PKCE via supabase-js) and returns `oauth/not-configured` without cloud Supabase.
We want Google / GitHub / Apple sign-in on self-hosted deployments with no cloud dependency.

## Decision

**Self-host Supabase Auth (GoTrue) inside the compose stack** instead of building a native OAuth
client layer. Every Supabase-auth call in the API already goes through supabase-js `auth.*`, which
is plain HTTP to `${SUPABASE_URL}/auth/v1/*` — GoTrue's API. Running GoTrue locally makes the
existing `SupabaseAuthProvider` **and** the existing PKCE OAuth brokering work unchanged.

Decisions ratified in brainstorming:

1. **Bare GoTrue behind the existing Caddy front door** — no Kong, no full Supabase self-host
   bundle. Storage stays MinIO via the existing `lib/storage/` seam.
2. **GoTrue becomes the documented default for selfhost/prod** (`DEFAULT_AUTH_PROVIDER=supabase`
   in `.env.selfhost.example` / `.env.prod.example`). **Native auth is retained as the zero-infra
   dev path** (`.env.dev.example` unchanged). Nothing is removed.
3. **Env/compose configuration only** — no admin-app UI in v1.
4. **Google + GitHub + Apple** documented and validated end-to-end.

## Architecture

```
browser ──/auth/v1/*──▶ Caddy (proxy) ──strip /auth/v1──▶ gotrue:9999 ──▶ db (auth schema)
   │                        │
   │  /v7/*                 ▼
   └──────────────────▶ agora (api) ── supabase-js auth.* ──▶ ${SUPABASE_URL}/auth/v1/* (same route)
OAuth provider (Google/GitHub/Apple) ──redirect──▶ https://<domain>/auth/v1/callback (GoTrue)
```

### New compose service: `gotrue`

- Image: `supabase/auth` (pinned tag), profiles `["selfhost"]` in `docker-compose.yml` and the
  prod compose mirror. Depends on `db` (healthy).
- DB: `GOTRUE_DB_DATABASE_URL` at the local `db` service. The `supabase/postgres` image already
  ships the `auth` schema + `supabase_auth_admin` role; GoTrue applies its own migrations to the
  `auth` schema at boot. **No Drizzle/API migrations** — `auth.users` stays unmodeled (existing
  rule: Drizzle never owns the `auth` schema).
- `API_EXTERNAL_URL` = `https://<public-domain>/auth/v1` (what providers redirect back to and what
  email links point at).
- Site URL / redirect allowlist: `GOTRUE_SITE_URL` + `GOTRUE_URI_ALLOW_LIST` from env (the
  Supabase-provider analog of `AUTH_EMAIL_LINK_ALLOWED_ORIGINS`; that native-auth var is unused in
  this mode).

### Caddy route

One new mutually-exclusive handle in `deploy/proxy/agora-routes.caddy` (and the dev variant),
ordered with the other API handles:

```caddy
handle_path /auth/v1/* {
    reverse_proxy {$GOTRUE_UPSTREAM:http://gotrue:9999}
}
```

GoTrue serves at its root; cloud Supabase fronts it with Kong stripping `/auth/v1` — `handle_path`
reproduces that. Lazy upstream resolution means the route 502s (not config-fails) when the profile
isn't up, matching the other optional services.

This single route serves all three consumers:

1. **The API's supabase-js clients** (`lib/supabase.ts`, `lib/oauth.ts`): `SUPABASE_URL` is set to
   the public origin (e.g. `https://agora.example.org`). Server-side calls hairpin through the
   front door — acceptable for v1; an internal plain-HTTP Caddy listener is a documented option if
   a deployment's network can't hairpin.
2. **OAuth provider callbacks** → `/auth/v1/callback`.
3. **GoTrue email links** → `/auth/v1/verify`.

### Keys

New script `apps/api/scripts/gen-gotrue-keys.mjs`:

- Generates `GOTRUE_JWT_SECRET` (random 256-bit) and signs two long-lived HS256 JWTs with it:
  `anon` (`role: "anon"`) and `service_role` (`role: "service_role"`) — the self-host equivalents
  of `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`.
- Prints the three values as env lines. Templates ship placeholders + a "run this script" comment.
- `GOTRUE_JWT_SECRET` is **independent of** `ACCESS_TOKEN_SECRET` — Agora still mints its own
  session tokens (`lib/tokens.ts`); GoTrue identity is exchanged for an Agora session exactly as
  the supabase provider does today.

### Email

- Real deployments: `GOTRUE_SMTP_*` block (host/port/user/pass/sender) in the env templates.
- No-SMTP path: `GOTRUE_MAILER_AUTOCONFIRM=true` as a commented switch (sign-ups confirm
  immediately; password reset by email is unavailable — documented).

### Social providers

Per-provider env blocks on the `gotrue` service, passed through from the root `.env`:

- `GOTRUE_EXTERNAL_GOOGLE_ENABLED/CLIENT_ID/SECRET/REDIRECT_URI`
- `GOTRUE_EXTERNAL_GITHUB_ENABLED/CLIENT_ID/SECRET/REDIRECT_URI`
- `GOTRUE_EXTERNAL_APPLE_ENABLED/CLIENT_ID/SECRET/REDIRECT_URI` — Apple's "secret" is itself a
  signed ES256 JWT built from an Apple Developer key; ship a helper
  (`apps/api/scripts/gen-apple-client-secret.mjs`) plus a docs subsection (secret expires ≤6
  months — regeneration is an operational task, called out in docs).

`REDIRECT_URI` is always `https://<domain>/auth/v1/callback`.

## API / server changes

Expected **zero changes** to `apps/api/src`. Items to *verify, not rewrite*:

- The PKCE authorize/callback pair in `routes/misc.ts` + `lib/oauth.ts` against bare GoTrue
  (Kong-less). `exchangeCodeForSession`, `oauth_states` persistence, and identity linking
  (`oauth_identities`) should behave identically.
- `00-seed-auth-admin.mjs`'s supabase helper (admin `createUser` with `email_confirm`) against
  local GoTrue.
- `SupabaseAuthProvider.deleteUser` modes (hard/soft/ban) against local GoTrue.

If verification finds a genuine behavioral difference, that becomes a scoped fix with its own test
— not silently absorbed.

## Migration for existing native deploys (opt-in)

Native auth keeps working, so upgrading is **opt-in**. New script
`apps/api/scripts/migrate-native-to-gotrue.mjs`:

1. Reads `auth_credentials` (native identities) for the project.
2. Inserts matching `auth.users` rows via GoTrue admin API — or direct SQL if the admin API can't
   accept a pre-hashed password. Both stores use bcrypt; users keep their passwords. If a hash
   can't carry over, the account is created unconfirmed-password (user does a reset) — the script
   reports which path each account took.
3. Flips `projects.auth_provider` to `supabase` (and notes `invalidateAuthProvider` TTL / restart).
4. Idempotent + dry-run mode (`--dry-run`); never deletes native rows (rollback = flip the column
   back).

The hash-handling/branching logic is factored pure and unit-tested.

## Security posture

- **Public GoTrue = cloud-Supabase posture.** `/auth/v1/admin/*` is gated by the `service_role`
  JWT (server-only secret; documented as a root credential). GoTrue's own OTP/verify rate limits
  stay on; Caddy body cap + headers apply to the route.
- **Fail-closed unchanged:** missing `SUPABASE_URL`/keys throw the existing clear errors;
  `oauthConfigured()` gates as today. No new anonymous API surface — `AUTH_WALL_ALLOWLIST` is
  untouched (GoTrue is reached via the proxy route, not the Hono app).
- **No secrets in logs** (existing logging policy applies to any new script output — keys print to
  stdout only, by explicit user action).

## Validation

- **Unit:** migration script's pure logic (vitest, no DB). Existing suites untouched.
- **Manual E2E** against `--profile selfhost` + demo app:
  - email/password: signup → confirm (SMTP or autoconfirm) → signin → password reset
  - OAuth: Google, GitHub, Apple end-to-end (needs provider app registrations; Apple needs a paid
    Apple Developer account — operator-provided)
  - migration rehearsal: seed native project → run script → sign in with pre-migration password
- **Docs/propagation:** `docs/SELF-HOSTING.md` SSO section (per-provider walkthroughs incl.
  Apple's signed secret), `PROPAGATION.yaml` entries (new env vars, compose service, Caddy route),
  `CHANGELOG.md` under `[Unreleased]`, README env-file notes.

## Out of scope (v1)

- Admin-app UI for auth/provider configuration.
- Removing native auth (retained for dev; revisit later).
- SAML / generic-OIDC enterprise IdPs (GoTrue's OIDC support may cover some via the same env
  pattern, but it is not documented or validated in v1).
- Supabase Storage / Kong / Studio — storage remains MinIO via the existing seam.
