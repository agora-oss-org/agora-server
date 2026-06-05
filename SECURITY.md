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
Put a reverse proxy (nginx, Caddy, Traefik) or a CDN (Cloudflare) in front and terminate HTTPS there.
Agora speaks HTTP behind it; the public hop must be HTTPS.

- Redirect `http → https`.
- Send **HSTS**: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
- The API does **not** set security headers itself — your proxy must add at minimum:
  `X-Content-Type-Options: nosniff`, a sensible `Content-Security-Policy`, and
  `Referrer-Policy: strict-origin-when-cross-origin`.
- socket.io (chat realtime) needs WebSocket upgrade proxied on the same origin.

### 2. Set the trusted-proxy / forwarded headers correctly
Rate limiting and request logging derive the client IP from **`X-Forwarded-For`** (first hop), falling
back to `X-Real-IP`. **A client can spoof these if your proxy passes them through unvalidated.** Your
proxy must *overwrite* (not append-trust) `X-Forwarded-For` with the real peer address. Only expose the
API through the proxy — never bind it to a public interface directly.

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
- **`CRON_SECRET`**, **`MODERATION_SERVICE_SECRET`**, **`MODERATION_WEBHOOK_SECRET`**, project
  **`webhook_secret`** — random, high-entropy, unique per deployment. These gate internal/cron routes and
  sign webhooks (all compared in constant time).
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
it is **in-memory per process** — see [known limitations](#-known-limitations--hardening-roadmap); pair it
with proxy/WAF/CDN rate limiting for real quota enforcement, especially across multiple replicas.

### 7. Cap request and upload sizes at the proxy
The app does not currently enforce a global body-size limit (see roadmap). Set a sane `client_max_body_size`
(nginx) / equivalent at the proxy to bound uploads and JSON bodies.

### 8. Operators, storage, and backups
- **`OPERATOR_USER_IDS` / `OPERATOR_EMAILS`** grant a project-wide god-view. Keep the allowlist minimal;
  prefer the **steward** role (least-privilege, DB-granted) for day-to-day moderation/conflict work.
- The Supabase Storage **`agora` bucket is public** (objects live under high-entropy
  `projectId/.../fileId` UUID paths). Treat anything uploaded as world-readable-if-the-URL-leaks; don't
  use it for private documents until signed-URL support lands (roadmap).
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
- **Row-Level Security is defense-in-depth.** Every table has RLS enabled with a **deny-all backstop**.
  Layered on top: **public-read** policies (only non-deleted/non-removed content in public spaces) and
  **authenticated self-access** reads (a signed-in user sees only their own private rows, via
  `SECURITY DEFINER` helpers in a non-exposed `private` schema). **There are no client write policies — all
  writes are server-only** — and `profiles` is intentionally not exposed (RLS can't mask the `email` /
  `secure_metadata` columns). So even if an anon/authed key ever reached the DB directly, the blast radius
  is bounded.
- **Multi-tenant isolation by `project_id`.** `:projectId` is validated (UUID + existence) in middleware
  and every query is scoped to it; tenants can't read across each other.
- **Authentication.** Identity is backed by **Supabase Auth** (passwords never touch Agora code — they go
  straight to Supabase; never logged or stored). Agora mints its own **HS256 access JWTs** (short-lived,
  ~30 min) plus **rotating refresh tokens** with **reuse-detection** (a replayed token revokes the whole
  family), a 30-second grace window for racing tabs, SHA-256-hashed storage, and a cron that purges
  expired tokens. External identity (`verify-external-user`) uses **RS256 with per-project public keys**
  and pinned audience + issuer.
- **Authorization tiers.** `operator` (env allowlist, project-wide) and `steward` (DB-granted, scoped to
  the conflict-resolution routes) are stamped into the JWT and read back per request — no extra DB hit.
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
| **User-suspension enforcement** | ✅ **Fixed.** `requireAuth` now rejects an actively-suspended user (`403 auth/suspended`) on every authed request, and suspending revokes the user's refresh families so the session can't be renewed. Operators bypass (they lift). Operator suspend/lift endpoints added (`/users/:id/suspend`). | **Follow-up:** an admin-app UI to view/manage suspensions. |
| **Rate-limit durability + IP spoofing** | ✅ **Fixed.** The client IP is now read `RATE_LIMIT_TRUSTED_HOPS` hops from the **right** of `X-Forwarded-For` (was the spoofable left-most), and an **optional Redis store** (`REDIS_URL`, least-privilege ACL) holds the cap across replicas — fail-open to in-memory. Still off unless `RATE_LIMIT_MAX` is set. | Pair with proxy/WAF limits at very high scale; `cf-connecting-ip` support if Cloudflare-fronted. |
| **Upload size / image bounds** | No explicit app-layer max upload size or image-dimension cap (risk: storage exhaustion, `sharp` OOM on pathological images). | Enforce a max byte size + max megapixels server-side; cap at the proxy in the meantime. |
| **Public storage bucket** | The `agora` bucket is public; objects are URL-guessable only via high-entropy UUID paths. No signed URLs / per-user download checks. | Add signed-URL support or an auth-checked download endpoint for private content. |
| **`ACCESS_TOKEN_SECRET` strength** | Validated as non-empty only (`min(1)`) — a weak secret would weaken every JWT. | Enforce `min(32)` in env validation; document `openssl rand` (done above). |
| **JWT verify algorithm pinning** | `jwtVerify` relies on jose's defaults rather than explicitly passing `algorithms: ["HS256"]`. | Pin the algorithm list on verify (API + socket.io) — cheap hardening. |
| **App-level security headers** | The API sets none (HSTS/CSP/nosniff) — relies on the proxy. | Documented as an operator responsibility above; could add a sane default header middleware. |
| **CORS default** | Defaults to `*` if unset. | Documented; consider failing/​warning loudly on a wildcard in production mode. |
| **RLS write policies** | None by design (writes are server-only). Safe today, but means RLS offers no second line for writes if the app boundary is bypassed. | Tracked as a deliberate trade-off; revisit if direct-DB access patterns are ever introduced. |

---

*Security is a practice, not a checkbox. If something here is wrong, unclear, or out of date, please tell
us — privately for anything exploitable.*
