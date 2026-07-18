# 🔐 Security

This document covers three things:

1. **[Reporting a vulnerability](#-reporting-a-vulnerability)** — how to disclose a hole responsibly.
2. **[Deploying Agora securely](#-deploying-agora-securely)** — the operator hardening checklist (TLS,
   database encryption, secrets, network posture).
3. **[Security model](#-security-model)** and **[known limitations](#-known-limitations--hardening-roadmap)** —
   what the server enforces by design, and the honest list of what to harden next.

> Agora is **pre-1.0** software. The model below is sound, but the surface is still evolving — read the
> known-limitations section before running it on untrusted, high-stakes traffic.

---

## 📨 Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

- **Preferred:** GitHub **Private Vulnerability Reporting** — the *Security → Report a vulnerability*
  button on this repository (creates a private advisory only maintainers can see).
- **Email fallback:** **security@recoverysky.org** (or `jenova@recoverysky.org`). PGP available on request.

Please include: affected version/commit, a description, reproduction steps or a PoC, and impact. If you
can, suggest a fix.

**What to expect:** acknowledgement within **3 business days**, an initial assessment within **7 days**,
and coordinated disclosure once a fix ships. We'll credit you in the release notes unless you'd rather
stay anonymous. We don't run a paid bounty (yet), but we're deeply grateful — this is a community
project and you're helping keep real people safe. 💜

### Supported versions
Being pre-1.0, only the **latest minor** receives security fixes. Run the most recent tagged release.

| Version | Supported |
|---|---|
| latest `0.x` minor | ✅ |
| older | ❌ — upgrade |

---

## 🛡️ Deploying Agora securely

Agora is **self-hosted**, so a meaningful share of its security is *your deployment*. The application is
written to be the trust boundary (see [Security model](#-security-model)), but it **deliberately delegates
transport security, TLS, and network isolation to your infrastructure**. This checklist is the contract.

### 1. Terminate TLS — never serve the API over plain HTTP
> **Bundled shortcut:** `docker compose --profile supabase up` (or `--profile selfhost`) brings up the API with a **Caddy** front door that does all of
> this automatically — **auto-HTTPS** (Let's Encrypt, auto-renewed), `http → https` redirect, HSTS +
> security headers, WebSocket upgrade, body-size cap, and an authoritative `X-Forwarded-For` — and it also
> serves the admin SPA + routes every service (one hop). Set `SERVER_NAME` + `RATE_LIMIT_TRUSTED_HOPS=1`.
> See `deploy/proxy/README.md`. The rest of this checklist is for bringing your own proxy/CDN instead.

Put a reverse proxy (Caddy, nginx, Traefik) or a CDN (Cloudflare) in front and terminate HTTPS there.
Agora speaks HTTP behind it; the public hop must be HTTPS.

- Redirect `http → https`.
- Send **HSTS**: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
- The API does **not** set security headers itself — your proxy must add at minimum:
  `X-Content-Type-Options: nosniff`, a sensible `Content-Security-Policy`, and
  `Referrer-Policy: strict-origin-when-cross-origin`.
- socket.io (chat realtime) needs WebSocket upgrade proxied on the same origin.

### 2. Set the trusted-proxy / forwarded headers correctly
Rate limiting derives the client IP from **`X-Forwarded-For`**, read `RATE_LIMIT_TRUSTED_HOPS` hops from
the **right** (the entries trusted proxies appended), so a client-supplied left-most value can't poison
it. Your edge must set `X-Forwarded-For` to the real peer and **not trust an inbound one** — the bundled
Caddy front door does this by default (set `RATE_LIMIT_TRUSTED_HOPS=1` — Caddy is the only proxy; use `2`
if you chain a CDN/LB in front of it). Only expose the API through the proxy — never bind it to a public
interface directly.

### 3. Encrypt the database — at rest and in transit
- **Managed Supabase Postgres** (the default target) is **encrypted at rest** (AES-256) by the platform,
  with automated backups. Nothing to do beyond keeping your project access controls tight.
- **In transit:** ensure `DATABASE_URL` enforces TLS — append **`?sslmode=require`** (or stricter,
  `verify-full`, with the CA) so the app↔Postgres hop is encrypted. Verify this is present; the app does
  not force it for you.
- **Self-hosted Postgres:** enable `ssl = on` with a real certificate, turn on transparent
  data-encryption / encrypted volumes (LUKS/EBS-encryption), and restrict `pg_hba.conf` to the app's
  network. Use the **transaction pooler** connection (port 6543, `prepare:false`) the app expects.

### 4. Generate strong secrets — and keep them out of the image
- **`ACCESS_TOKEN_SECRET`** signs every access JWT (HS256). Use **≥ 32 bytes** of randomness:
  `openssl rand -base64 48`. Rotating it invalidates all live access tokens (refresh still works) — a
  useful emergency lever.
- **`CRON_SECRET`**, **`MODERATION_SERVICE_SECRET`**, project **`webhook_secret`** — random,
  high-entropy, unique per deployment. These gate internal/cron routes and sign webhooks (all compared
  in constant time).
- **`SUPABASE_SERVICE_ROLE_KEY`** is god-mode over your Supabase project. Agora confines it to Auth +
  Storage only (lazy client) — keep it **server-side only**, never in any client bundle or the admin app.
  The admin/SDK use the **anon/publishable** key.
- Inject secrets via your platform's secret store or env — **never commit `.env`**, never bake secrets
  into the Docker image. The root `.env` is git-ignored; keep it that way.

### 5. Lock down CORS
`CORS_ORIGIN` **defaults to `*`**. For production set it to your exact app origin(s)
(`https://app.example.com`) — both the REST API and socket.io read it. A wildcard with credentialed
requests is a cross-origin risk.

### 6. Turn on rate limiting
Edge rate limiting is **off unless configured**. Set **`RATE_LIMIT_MAX`** (per-IP per window) and the
stricter **`RATE_LIMIT_AUTH_MAX`** for `/auth/*`, with **`RATE_LIMIT_WINDOW_SECONDS`** (default 60). Note
it is **in-memory per process** by default — see [known limitations](#-known-limitations--hardening-roadmap).
Set **`REDIS_URL`** to hold the cap in a shared **Redis** store across replicas (fail-open to in-memory if
Redis is down); either way, pair it with proxy/WAF/CDN rate limiting for real quota enforcement.

### 7. Cap request and upload sizes at the proxy
The app does not currently enforce a global body-size limit (see roadmap). The bundled Caddy edge caps it
(`MAX_BODY_SIZE`, default `25MB`); with your own proxy set `client_max_body_size` (nginx) / equivalent to
bound uploads and JSON bodies.

### 8. Operators, storage, and backups
- **`OPERATOR_USER_IDS` / `OPERATOR_EMAILS`** grant a project-wide god-view. Keep the allowlist minimal;
  prefer the **steward** role (least-privilege, DB-granted) for day-to-day moderation/conflict work.
- The Supabase Storage **`agora` bucket is public** — an **accepted design choice** (most media is
  public by nature: post images, avatars, public-space content). Paths are random
  `projectId/.../fileId` v4 UUIDs (~122 bits each), so objects **can't be enumerated/guessed** — the only
  exposure is a **leaked URL** (a forwarded link, a referrer header, a log). So: **don't upload secrets**,
  and be aware that a leaked URL to a **private** attachment (DM / private-space) is world-readable. If
  that matters for your deployment, put private uploads behind your own signed-URL/download gate.
- The **self-hosted storage backend** (`STORAGE_PROVIDER=s3` → MinIO/S3, `docs/SELF-HOSTING.md`) carries
  the **identical posture**: the api creates the bucket with an anonymous **public-read** policy and the
  same unguessable-UUID keys — same accepted trade-off, same "don't upload secrets" caveat. Serve it
  through the Caddy front door `/media` mount (never expose MinIO `:9000` publicly), and treat the MinIO root
  credentials + `POSTGRES_PASSWORD` as real secrets (strong values, `.env` out of VCS).
- Verify Supabase **automated backups** (or your own `pg_dump` schedule) and test a restore.

### 9. Keep the stack patched
Track releases (security fixes land in the latest minor), and keep Supabase, the proxy, and the base
image current.

---

## 🧭 Security model

How Agora is *designed* to be secure — useful context for both operators and reviewers.

- **The server is the trust boundary.** The app connects to Postgres with a role that **bypasses RLS**;
  all authorization (ownership, space roles, operator/steward checks, moderation visibility) is enforced
  **in the request handlers**, not in the database. Treat the API as the only thing standing between a
  client and the data.
- **Private by default (auth wall).** Every `/v7/:projectId/*` request requires an authenticated
  account. The gate is `authWall` (`packages/core/src/middleware/auth.ts`), mounted group-wide; its
  `AUTH_WALL_ALLOWLIST` constant is the API's entire anonymous surface (the pre-sign-in flows:
  `/auth/*`, OAuth authorize/callback, `/projects/lean`, the VAPID public key, and the dev
  JWT-signing stub). New routes are authed by default — fail closed. Adding an allowlist entry is a
  security decision requiring spec rationale; a unit test pins the list's exact contents. The RLS
  `0008` anon public-read policies were revoked (`0064`) so the DB layer states the same posture.
  Uploaded media remains fetchable by unguessable URL (see the storage section) — the one
  anonymous-readable artifact class, queued for a signed-URL follow-up.
- **Row-Level Security is defense-in-depth.** Every table has RLS enabled with a **deny-all backstop**.
  The `0008` anon public-read policies were revoked (migration `0064`, alongside the auth wall) and
  `anon`'s `SELECT` grants pulled with them — `anon` now has no read access at all. The only remaining
  read policies are **authenticated self-access** reads (a signed-in user sees only their own private
  rows, via `SECURITY DEFINER` helpers in a non-exposed `private` schema). **There are no client write
  policies — all writes are server-only** — and `profiles` is intentionally not exposed (RLS can't mask
  the `email` / `secure_metadata` columns). So even if an anon/authed key ever reached the DB directly,
  the blast radius is bounded (anon gets nothing; an authed key gets only its own rows).
- **Multi-tenant isolation by `project_id`.** `:projectId` is validated (UUID + existence) in middleware
  and every query is scoped to it; tenants can't read across each other.
- **DB resolution fails closed.** The per-project DB resolver seam (`@agora/core/db`) propagates resolver
  errors — there is no "resolver failed → shared database" fallback, so a misconfigured multi-DB
  deployment can never silently serve one project's request from another's database. Single-`DATABASE_URL`
  deployments are unaffected (no resolver is ever registered; every request uses the one shared handle).
- **Authentication.** Identity is backed by **Supabase Auth** (passwords never touch Agora code — they go
  straight to Supabase; never logged or stored). Agora mints its own **HS256 access JWTs** (short-lived,
  ~30 min) plus **rotating refresh tokens** with **reuse-detection** (a replayed token revokes the whole
  family), a 30-second grace window for racing tabs, SHA-256-hashed storage, and a cron that purges
  expired tokens. External identity (`verify-external-user`) uses **RS256 with per-project public keys**
  and pinned audience + issuer. **Native-auth email links fail closed:** the confirm/reset/resend paths
  require **`AUTH_EMAIL_LINK_ALLOWED_ORIGINS`** (there's no way to validate a client-supplied
  `emailRedirectTo` without it) — unset, they return **`503 auth/email-not-configured`** rather than email
  a link built from an unvalidated origin; a supplied `emailRedirectTo` is checked against that allowlist
  (**open-redirect guard**, else **`400 auth/email-redirect-not-allowed`**). Supabase-backed auth brokers
  its own emails and is unaffected.
- **Authorization tiers.** A hierarchy `operator ⊇ owner ⊇ admin ⊇ steward ⊇ member`. The deployment
  **platform-operator** (env allowlist, cross-tenant) plus DB-granted **per-project** `owner`/`admin`/`steward`
  (`project_roles`) are stamped into the JWT (`operator`/`powner`/`padmin`/`steward` claims) and read back
  per request — no extra DB hit. Within-project powers (moderation, reports, suspensions, project config,
  private-space access) accept owner/admin; **deployment** powers (running config, DB size, server
  resources) stay operator-only. Role grants take effect on the user's next token
  refresh (see the revocation-latency limitation below).
- **Settings-read-only principals** (`OPERATOR_RO_EMAILS`): a shared demo/operator login can hold
  the full operator view yet is server-blocked (`assertSettingsWritable`, after the project-admin gate)
  from persisting any of the five settings-save endpoints. Per-identity and server-enforced —
  independent of, and stricter than, the client-side `VITE_SETTINGS_READ_ONLY` display flag. Additive;
  no existing gate is relaxed.
- **Internal endpoints & webhooks** (cron, moderation apply, webhook signatures) are gated by secrets
  compared in **constant time** (`crypto.timingSafeEqual`); webhooks are **HMAC-SHA256 signed** with a
  timestamp, in both directions.
- **Injection-resistant data access.** All SQL goes through Drizzle's parameterized `sql` template —
  including the raw RPC/search/rollup queries; no user input is concatenated into SQL. Email-enumeration is
  avoided on auth flows (uniform 200s), and the link-preview fetch is **SSRF-guarded** (scheme allowlist,
  private-IP/loopback/metadata blocking, timeout, response-size cap).
- **Secrets don't leak.** The operator config endpoint reports secrets as booleans and strips credentials
  from `DATABASE_URL`; request logging records method/path/status/duration only — no bodies, tokens, or
  headers.

---

## 🚧 Known limitations & hardening roadmap

Honest disclosure of where the implementation is thinner than the model, roughly by priority. These are
the areas we're actively looking into; contributions welcome.

| Area | Status / risk | Direction |
|---|---|---|
| **Link-preview SSRF (redirects + encodings)** | ✅ **Fixed.** `/utils/get-metadata` now validates the host on the initial URL **and every redirect hop** (manual redirect following via `lib/ssrf.ts`), resolves the host and rejects any private resolved IP, and covers IPv6 (incl. IPv4-mapped) + numeric-IP encodings (decimal/octal/hex). | **Residual:** a narrow DNS-rebinding TOCTOU between our resolve and `fetch`'s own resolution. Close it later by pinning the connection to the validated IP (a custom dispatcher/`lookup`). |
| **User-suspension enforcement** | ✅ **Fixed.** `requireAuth` now rejects an actively-suspended user (`403 auth/suspended`) on every authed request (and every secure-chat socket handshake), and suspending revokes the user's refresh families so the session can't be renewed. Operators bypass (they lift). Operator suspend/lift endpoints added (`/users/:id/suspend`). **Now backed by a fail-closed Redis index** — see the row below. | **Follow-up:** an admin-app UI to view/manage suspensions. |
| **Suspension index — fail-closed** | ✅ **Hardened.** When `REDIS_URL` is set, the per-request/per-handshake suspension check (`hasActiveSuspension`) reads a Redis SET `suspended:profiles` (O(1), no DB hit), kept correct by **hydrate-on-boot** (atomic rebuild) + **write-through** `SADD`/`SREM` on suspend/lift + a **reconcile cron** (`POST /internal/cron/sync-suspensions`, every 5 min). It **fails closed**: a *configured-but-unreachable* Redis returns **`403`/`503`** (the request is denied — there is **no DB fallback** for a down-but-configured Redis, which would fail open). The DB-read path is used **only when Redis is not configured** (single-replica API + the hermetic test suite). The standalone **`@agora/secure-chat`** service treats Redis as a hard dependency and gates readiness on a **`/health`** check that returns `503` until the index hydrates — so an *empty* set can't fail open before boot. | — |
| **Rate-limit durability + IP spoofing** | ✅ **Fixed.** The client IP is now read `RATE_LIMIT_TRUSTED_HOPS` hops from the **right** of `X-Forwarded-For` (was the spoofable left-most), and an **optional Redis store** (`REDIS_URL`, least-privilege ACL) holds the cap across replicas — fail-open to in-memory. Still off unless `RATE_LIMIT_MAX` is set. | Pair with proxy/WAF limits at very high scale; `cf-connecting-ip` support if Cloudflare-fronted. |
| **Upload size / image bounds** | ✅ **Fixed.** App-layer cap `MAX_UPLOAD_BYTES` (default 25 MiB, `413`) on every upload path + a 50 MP image limit (`sharp limitInputPixels` + a metadata pre-check), in addition to the proxy's body cap. | — |
| **Public storage bucket** | ✅ **Accepted (documented).** The `agora` bucket is public by design (most media is public); paths are unguessable v4-UUIDs so there's no enumeration — only leaked-URL exposure. Signing every URL would tax all media reads + break caching to protect mostly-public content (poor trade). | Residual: a leaked URL to a private attachment is world-readable — don't upload secrets; gate private uploads yourself if needed (see deploy checklist §8). |
| **`ACCESS_TOKEN_SECRET` strength** | ✅ **Fixed.** Env validation now requires `min(32)` (was `min(1)`); `openssl rand -base64 48` documented above. | — |
| **JWT verify algorithm pinning** | ✅ **Fixed.** `algorithms: ["HS256"]` pinned on the access-token + socket.io verifies (and the `services/scorer` write-back); the external-auth verify pins `["RS256"]`. | — |
| **Security headers** | ✅ **Addressed at the edge.** The bundled Caddy proxy sends HSTS + `X-Content-Type-Options` + `Referrer-Policy` + `X-Frame-Options` (and strips `Server`). The API itself still sets none. | Bring-your-own proxy must add them; a strict app-specific CSP is the remaining tuning (commented starting point in the Caddyfile). |
| **Role/privilege revocation latency** | ⚠️ **Known gap.** Authorization tiers (operator/owner/admin/steward) are stamped into the short-lived access JWT and read per request with **no DB hit** (by design — fast, stateless). Revoking a role deletes the grant and drops it on the user's next token **refresh**, but an **already-minted access token keeps its elevated claims until it expires — up to ~30 min** (`ACCESS_TOKEN` TTL). So a **revoked admin/owner retains access for that window**; for `owner` it also includes suspension-immunity. The cross-replica role cache adds ≤30s on top (it's in-process, not the shared Redis — which today serves only rate limiting). This is the same tradeoff already accepted for the `operator`/`steward` flags, but more consequential for admin/owner. **No store is consulted on the request hot path**, so neither the cache nor Redis is the dominant factor — the live JWT is. | Make revoke bite immediately: **(a)** `revokeAllForProfile()` on owner/admin revoke (kills refresh-extension; cheap, no infra, ~90% of the value), and/or **(b)** a per-request token-version / `roles_epoch` check (true immediate revocation — the one place a shared fast store like Redis would earn its keep on the auth path). Interim mitigation: shorten `ACCESS_TOKEN` TTL. Tracked for the managed-hosting **isolation-hardening** pass (sub-project G). |
| **CORS default** | Defaults to `*` if unset. | Documented; consider failing/​warning loudly on a wildcard in production mode. |
| **RLS write policies** | None by design (writes are server-only). Safe today, but means RLS offers no second line for writes if the app boundary is bypassed. | Tracked as a deliberate trade-off; revisit if direct-DB access patterns are ever introduced. |

---

*Security is a practice, not a checkbox. If something here is wrong, unclear, or out of date, please tell
us — privately for anything exploitable.*
