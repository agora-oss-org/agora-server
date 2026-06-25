# @agora/secure-chat

The **blind MLS (E2E) Delivery Service** for Agora — an **independently-deployable** service split out
of `@agora/api` so secure chat can be load-balanced and (later) deployed on its own. It serves the
end-to-end-encrypted chat surface; the server stores and relays **opaque bytes only** and never sees
plaintext.

> **Why a separate app?** Secure chat has a fundamentally different trust and load profile from the
> rest of the API. Running it as its own process lets you scale it independently, give it its own
> deploy cadence, and (v2) stand it up fully alone — including dark-web / onion deployments. The split
> is deliberately seam-friendly: see **v2 deferrals** below.

## What it is (and isn't)

- **Is:** a [MLS / RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html) **Delivery Service** — it
  relays KeyPackages, Welcomes, Commits, application ciphertext, and passphrase-encrypted key backups
  as `bytea` blobs, enforcing membership / authorization / commit-ordering on those bytes. All crypto
  is **client-side** (`@agora-sdk/secure-chat-crypto`).
- **Isn't:** the Replyke-compatible plaintext chat (`@agora/api`'s `chat.ts`) — that's a separate
  surface with separate tables. Secure chat is **not** in the SDK's Replyke contract.

## Architecture (v1)

```
client + @agora-sdk/secure-chat-crypto
   │  HTTPS  /v7/:projectId/secure-chat/...        (REST)
   │  WSS    /secure  namespace on engine.io path  /secure-socket/   (realtime)
   ▼
@agora/secure-chat   (Hono + its OWN socket.io server)   ← THIS APP
   │
   ├── @agora/core   (shared kernel: db client + schema, env, logger, auth/project
   │                  middleware, http envelope, validation, suspensions, redis)
   │
   ├── Postgres   (SHARED with @agora/api in v1 — the secure_* tables + spaces + profiles)
   └── Redis      (SHARED — the fail-closed suspension index)
```

- **Shared kernel** `@agora/core`: secure-chat does not re-implement db/auth/logging — it consumes the
  same kernel `@agora/api` does, so the JWT verification, the schema, and the suspension semantics stay
  byte-identical across both services.
- **Shared Postgres (v1):** secure-chat points at the same `DATABASE_URL` as the api. The `secure_*`
  tables live in `@agora/core`'s Drizzle schema; migrations are owned by `@agora/api` (`apps/api/drizzle`,
  one migrator for the shared DB).
- **Own socket.io server:** because secure-chat is its own process, it owns its own socket.io server.
  socket.io namespaces multiplex over a single engine.io **path**, and the namespace is in the
  Socket.IO packet (not the URL) — so a path-routing reverse proxy can't split a shared `/socket.io/`
  across two backends. We therefore give the secure realtime a **distinct engine.io path,
  `/secure-socket/`**, which the edge CAN route here. The namespace stays `/secure` and every event
  name is byte-identical to the contract (`docs/MANIFEST.md` §4).

## Identity & authorization

- **Identity:** verifies the bearer JWT (HS256 over the shared `ACCESS_TOKEN_SECRET`) — the same token
  `@agora/api` mints. secure-chat has **no signup/login** of its own; the user authenticates against the
  api (the token issuer) and presents the token here.
- **Per-request gates:** `requireAuth` on every route, project resolution, conversation membership,
  admin-only member add/remove, device ownership, channel space-access, and ciphertext size caps.

## Suspension enforcement — the Redis index

Suspension is checked on **every** authed request (`requireAuth`) and socket handshake. To keep that
O(1), it goes through a **Redis SET** (`suspended:profiles`) instead of a per-request Postgres read:

- **`REDIS_URL`-gated.** Set → Redis fast path; unset → the authoritative DB read (so the suite and
  single-replica api stay hermetic). **secure-chat treats Redis as a hard dependency** (see below).
- **Fail-closed.** When the index is enabled and Redis is unreachable, the read **throws 503** — the
  request is denied, never silently allowed. There is deliberately **no DB fallback** for a
  configured-but-down Redis (that would be a fail-*open* risk).
- **Readiness gate.** On boot, secure-chat **hydrates the index before it listens** and `/health`
  returns `503` until it's ready — an un-hydrated (empty) set must never serve, or a suspended user
  could slip through.
- **Maintained by:** hydrate-on-boot (atomic rebuild) + write-through `SADD`/`SREM` on suspend/lift
  (in `@agora/api`, which owns the suspension write endpoints) + a reconcile cron
  (`POST /internal/cron/sync-suspensions`, also `apps/api/scripts/sync-suspensions.mjs`) that does one
  atomic rebuild catching new suspensions, lifts, AND `endDate` expiries. The index is **shared**, so
  the api's write-through + cron keep secure-chat's reads fresh.

## Run it

```bash
# From the repo root — build the workspace deps first (secure-chat consumes @agora/core's dist):
pnpm --filter @agora-server/contract build
pnpm --filter @agora/core build

# Dev (tsx watch). Needs the env below in apps/secure-chat/.env (this package's dir):
pnpm --filter @agora/secure-chat dev      # → http://localhost:4002/v7
#   tip: run `pnpm dev:core` (tsc -w) in another shell if you're editing the kernel.

pnpm --filter @agora/secure-chat typecheck
pnpm --filter @agora/secure-chat test                # unit (shapers) — no DB
pnpm --filter @agora/secure-chat test:integration    # real Postgres (TEST_DATABASE_URL)
pnpm --filter @agora/secure-chat db:clean:secure-chat # dry-run wipe of the 7 secure_* tables (--yes to execute)
```

### Environment

| Var | Required | Purpose |
|-----|----------|---------|
| `DATABASE_URL` | ✅ | Shared Postgres (Supabase transaction pooler `:6543`). |
| `ACCESS_TOKEN_SECRET` | ✅ | HS256 verify key — must match `@agora/api`. |
| `REDIS_URL` | ✅ (prod) | The suspension index. Unset → DB-read fallback (dev/test only). |
| `SECURE_CHAT_PORT` | — | Listen port (default `4002`). |
| `CORS_ORIGIN` | — | Allowed origin(s) for REST + socket. |
| `CRON_SECRET` | — | Gates `POST /internal/cron/sync-suspensions`. |
| `AGORA_SOURCE_URL` | — | AGPL §13 corresponding-source link. |

### Docker

```bash
# The `secure-chat` profile is the STANDALONE deploy — redis + secure-chat, no API stack. It does NOT bundle
# a DB: it persists the secure_* tables to whatever DATABASE_URL points at — point it at a REMOTE Postgres
# (v1 = the SHARED main Postgres or Supabase, already migrated). Set REDIS_URL=redis://redis:6379 in .env first.
docker compose --profile secure-chat up --build                  # DATABASE_URL -> remote shared/Supabase Postgres
# Everything self-contained (API + db + minio, with secure-chat riding `full`):
docker compose --profile full --profile selfhost up --build
# Alongside the API (so the Caddy front door routes /secure-chat/* + /secure-socket/ to it) — secure-chat
# rides `full`, so no separate flag is needed:
docker compose --profile full --profile supabase up --build
```

## Endpoints

REST under `/v7/:projectId/secure-chat/*` — devices, key-packages (publish / count / claim), handshakes
(Welcome/Commit/Proposal poll), key-backup, conversations, members, messages. Realtime on the `/secure`
namespace (engine.io path `/secure-socket/`): `secure:message`, `secure:handshake`, `secure:welcome`,
`secure:member:joined|left`, `secure:key-packages-low`, typing. See `docs/MANIFEST.md` + `docs/MODELS.md`
(response models live in `@agora-server/contract`).

## v2 deferrals (seams only)

The v1 split keeps these doors open without building them yet:

- **Onion / Tor + standalone DB:** relax the `secure_*` FKs to plain uuids (like `auth.users`), give
  secure-chat its own Postgres, and read suspension only via the shared Redis (or an API callback). The
  `SpaceAccessProvider` seam (`src/lib/space-access.ts`, v1 = direct SQL) is where a standalone node
  swaps in an API-callback provider or disables space-gated channels.
- **Asymmetric JWT (RS256/JWKS):** verify with a public key so no token-minting secret ever lives on a
  (seizable) onion node.

## Diagnostics

`docs/SECURE-CHAT-DIAG-HARNESS.md` + the log correlator
(`apps/api/scripts/diag/secure-chat-log-normalize.mjs`). Note the realtime path is now `/secure-socket/`.
