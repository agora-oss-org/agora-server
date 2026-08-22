# Self-hosted SSO via bundled GoTrue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google/GitHub/Apple SSO on fully self-hosted Agora by bundling Supabase Auth (GoTrue) in the `selfhost` compose profile behind the existing Caddy front door.

**Architecture:** A new `gotrue` compose service (image `supabase/auth`) runs against the existing `supabase/postgres` `db` service (which already ships the `auth` schema + `supabase_auth_admin` role; GoTrue self-migrates at boot). Caddy gains a public `/auth/v1/*` route (provider callbacks + email links) and an internal-only `:9998` listener (hairpin-free base URL for the API's server-side supabase-js calls). The existing `SupabaseAuthProvider` + PKCE OAuth brokering work unchanged; new work is compose/Caddy/env, three helper scripts, and docs.

**Tech Stack:** Docker Compose, Caddy, GoTrue (`supabase/auth`), jose (HS256/ES256 JWTs), postgres.js, vitest.

**Spec:** `docs/superpowers/specs/2026-08-22-selfhost-gotrue-sso-design.md`

## Global Constraints

- **Commits require Jenova's explicit authorization** (standing rule). Before Task 1, ask whether per-task commits are authorized for this run; if not, stop at each commit step and ask. Every commit: DCO-signed (`git commit -s`) + the Co-Authored-By/Claude-Session trailer.
- **`pnpm -r typecheck` and `pnpm test` must pass** before any task is called done (repo rule). Script-only tasks still run both (the unit suite includes `apps/api/scripts/**/*.test.mjs`).
- **No secrets in logs/output beyond explicit user action**: key material prints to stdout only when the user runs a generator script; scripts never log secrets incidentally. `console.*` is fine in `scripts/**` (existing convention); the `logger` rule applies to `src/**` only, which this plan does not touch.
- **Zero changes to `apps/api/src`, `packages/contract`, `docs/MANIFEST.md`, `docs/MODELS.md`** — the API contract and server code are untouched. If verification (Task 6) finds a real behavioral difference vs cloud Supabase, STOP and raise it; do not patch silently.
- **`.env.dev.example` stays native-auth** — dev remains zero-infra.
- **CHANGELOG.md** entry under `## [Unreleased]` lands in Task 7.
- Deviation from spec, ratified here: the internal Caddy `:9998` listener is REQUIRED, not optional — with `SERVER_NAME=localhost`, an api-container-side `SUPABASE_URL=http://localhost` can never resolve to the proxy (localhost inside the container is the container), so hairpin-by-default is broken on exactly the default config. The internal listener is deterministic on every topology.

---

### Task 1: GoTrue key generator (`gen-gotrue-keys.mjs`)

**Files:**
- Create: `apps/api/scripts/lib/gotrue-keys.mjs`
- Create: `apps/api/scripts/lib/gotrue-keys.test.mjs`
- Create: `apps/api/scripts/gen-gotrue-keys.mjs`

**Interfaces:**
- Consumes: nothing (leaf task).
- Produces: `buildGotrueKeys({ secret: string, now: number }): Promise<{ anonKey: string, serviceKey: string }>` — HS256 JWTs signed with `secret`, `role` claims `"anon"` / `"service_role"`, `iss: "supabase"`, 10-year expiry. CLI prints `GOTRUE_JWT_SECRET=` / `SUPABASE_ANON_KEY=` / `SUPABASE_SERVICE_ROLE_KEY=` env lines (Tasks 3–4 reference these var names).

- [ ] **Step 1: Write the failing test**

`apps/api/scripts/lib/gotrue-keys.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { jwtVerify } from "jose";
import { buildGotrueKeys } from "./gotrue-keys.mjs";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW = 1_750_000_000; // fixed epoch seconds — keys must be deterministic given (secret, now)

describe("buildGotrueKeys", () => {
  it("signs anon and service_role JWTs verifiable with the same secret", async () => {
    const { anonKey, serviceKey } = await buildGotrueKeys({ secret: SECRET, now: NOW });
    const key = new TextEncoder().encode(SECRET);
    const anon = await jwtVerify(anonKey, key);
    const service = await jwtVerify(serviceKey, key);
    expect(anon.payload.role).toBe("anon");
    expect(service.payload.role).toBe("service_role");
    expect(anon.protectedHeader.alg).toBe("HS256");
  });

  it("stamps iss=supabase and a 10-year lifetime", async () => {
    const { anonKey } = await buildGotrueKeys({ secret: SECRET, now: NOW });
    const { payload } = await jwtVerify(anonKey, new TextEncoder().encode(SECRET));
    expect(payload.iss).toBe("supabase");
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + 10 * 365 * 24 * 3600);
  });

  it("rejects a secret shorter than 32 chars", async () => {
    await expect(buildGotrueKeys({ secret: "short", now: NOW })).rejects.toThrow(/32/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run scripts/lib/gotrue-keys.test.mjs`
Expected: FAIL — `Cannot find module './gotrue-keys.mjs'` (or equivalent).

- [ ] **Step 3: Write the implementation**

`apps/api/scripts/lib/gotrue-keys.mjs`:

```js
// Self-host GoTrue key material. GoTrue authenticates callers by verifying an HS256 JWT against
// GOTRUE_JWT_SECRET and reading its `role` claim — the "anon key" / "service_role key" of a cloud
// Supabase project are exactly these two long-lived JWTs. Deterministic given (secret, now) so it
// is unit-testable; the CLI supplies real randomness + wall clock.
import { SignJWT } from "jose";

const TEN_YEARS_S = 10 * 365 * 24 * 3600;

export async function buildGotrueKeys({ secret, now }) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("GOTRUE_JWT_SECRET must be at least 32 characters");
  }
  const key = new TextEncoder().encode(secret);
  const sign = (role) =>
    new SignJWT({ role, iss: "supabase" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now)
      .setExpirationTime(now + TEN_YEARS_S)
      .sign(key);
  return { anonKey: await sign("anon"), serviceKey: await sign("service_role") };
}
```

`apps/api/scripts/gen-gotrue-keys.mjs`:

```js
#!/usr/bin/env node
// Generate the self-host GoTrue env trio: a JWT secret + the anon/service_role keys signed with it.
// Prints ready-to-paste env lines (by explicit user action — this is the ONE place keys go to stdout).
//   node scripts/gen-gotrue-keys.mjs                # fresh random secret
//   node scripts/gen-gotrue-keys.mjs --secret <s>   # re-derive keys from an existing secret
import { randomBytes } from "node:crypto";
import { buildGotrueKeys } from "./lib/gotrue-keys.mjs";

const i = process.argv.indexOf("--secret");
const secret = i > -1 ? process.argv[i + 1] : randomBytes(32).toString("hex");
const { anonKey, serviceKey } = await buildGotrueKeys({ secret, now: Math.floor(Date.now() / 1000) });

console.log(`GOTRUE_JWT_SECRET=${secret}`);
console.log(`SUPABASE_ANON_KEY=${anonKey}`);
console.log(`SUPABASE_SERVICE_ROLE_KEY=${serviceKey}`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agora/api exec vitest run scripts/lib/gotrue-keys.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Smoke the CLI**

Run: `cd apps/api && node scripts/gen-gotrue-keys.mjs | head -1`
Expected: one `GOTRUE_JWT_SECRET=<64 hex chars>` line. Then `node scripts/gen-gotrue-keys.mjs --secret 0123456789abcdef0123456789abcdef` twice — the two runs' key lines differ only in `iat`-dependent segments (same secret accepted).

- [ ] **Step 6: Gates + commit (ask first per Global Constraints)**

Run: `pnpm -r typecheck && pnpm --filter @agora/api test`
Expected: both pass.

```bash
git add apps/api/scripts/lib/gotrue-keys.mjs apps/api/scripts/lib/gotrue-keys.test.mjs apps/api/scripts/gen-gotrue-keys.mjs
git commit -s -m "feat(scripts): gen-gotrue-keys.mjs — self-host GoTrue JWT secret + anon/service_role keys"
```

---

### Task 2: Apple client-secret generator (`gen-apple-client-secret.mjs`)

**Files:**
- Create: `apps/api/scripts/lib/apple-secret.mjs`
- Create: `apps/api/scripts/lib/apple-secret.test.mjs`
- Create: `apps/api/scripts/gen-apple-client-secret.mjs`

**Interfaces:**
- Consumes: nothing (leaf task).
- Produces: `buildAppleClaims({ teamId, clientId, keyId, now, days? }): { header, payload }` — the ES256 JWT pieces for Apple's client secret. CLI prints a `GOTRUE_EXTERNAL_APPLE_SECRET=` line (Task 4 references the var name).

- [ ] **Step 1: Write the failing test**

`apps/api/scripts/lib/apple-secret.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { buildAppleClaims } from "./apple-secret.mjs";

const ARGS = { teamId: "TEAM123456", clientId: "org.example.agora.web", keyId: "KEY1234567", now: 1_750_000_000 };

describe("buildAppleClaims", () => {
  it("builds the ES256 header and Apple-audience payload", () => {
    const { header, payload } = buildAppleClaims(ARGS);
    expect(header).toEqual({ alg: "ES256", kid: "KEY1234567", typ: "JWT" });
    expect(payload).toEqual({
      iss: "TEAM123456",
      sub: "org.example.agora.web",
      aud: "https://appleid.apple.com",
      iat: 1_750_000_000,
      exp: 1_750_000_000 + 180 * 86400,
    });
  });

  it("honors a shorter custom lifetime", () => {
    const { payload } = buildAppleClaims({ ...ARGS, days: 30 });
    expect(payload.exp - payload.iat).toBe(30 * 86400);
  });

  it("rejects a lifetime over Apple's 180-day cap", () => {
    expect(() => buildAppleClaims({ ...ARGS, days: 181 })).toThrow(/180/);
  });

  it("rejects missing required fields", () => {
    expect(() => buildAppleClaims({ ...ARGS, teamId: "" })).toThrow(/teamId/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run scripts/lib/apple-secret.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`apps/api/scripts/lib/apple-secret.mjs`:

```js
// Sign in with Apple: the "client secret" is itself a short-lived ES256 JWT signed with the
// developer's .p8 key. Apple caps its lifetime at 6 months (180 days) — regeneration is a
// recurring operational task (documented in docs/SELF-HOSTING.md). Pure claim-building here;
// the CLI does the key handling + signing.
export function buildAppleClaims({ teamId, clientId, keyId, now, days = 180 }) {
  for (const [name, v] of [["teamId", teamId], ["clientId", clientId], ["keyId", keyId]]) {
    if (typeof v !== "string" || v.length === 0) throw new Error(`${name} is required`);
  }
  if (!Number.isInteger(days) || days < 1 || days > 180) {
    throw new Error("days must be 1-180 (Apple caps client-secret lifetime at 180 days)");
  }
  return {
    header: { alg: "ES256", kid: keyId, typ: "JWT" },
    payload: { iss: teamId, sub: clientId, aud: "https://appleid.apple.com", iat: now, exp: now + days * 86400 },
  };
}
```

`apps/api/scripts/gen-apple-client-secret.mjs`:

```js
#!/usr/bin/env node
// Generate the Sign in with Apple client secret (an ES256 JWT) for GOTRUE_EXTERNAL_APPLE_SECRET.
//   node scripts/gen-apple-client-secret.mjs --key ./AuthKey_KEY1234567.p8 \
//     --team-id TEAM123456 --client-id org.example.agora.web --key-id KEY1234567 [--days 180]
// The secret EXPIRES (≤180 days) — rerun before expiry and update the env (see docs/SELF-HOSTING.md).
import { readFileSync } from "node:fs";
import { SignJWT, importPKCS8 } from "jose";
import { buildAppleClaims } from "./lib/apple-secret.mjs";

function arg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (required) { console.error(`Missing --${name}`); process.exit(1); }
    return undefined;
  }
  return process.argv[i + 1];
}

const keyPath = arg("key");
const days = arg("days", false);
const { header, payload } = buildAppleClaims({
  teamId: arg("team-id"),
  clientId: arg("client-id"),
  keyId: arg("key-id"),
  now: Math.floor(Date.now() / 1000),
  ...(days ? { days: Number(days) } : {}),
});

const pk = await importPKCS8(readFileSync(keyPath, "utf8"), "ES256");
const jwt = await new SignJWT(payload).setProtectedHeader(header).sign(pk);
console.log(`GOTRUE_EXTERNAL_APPLE_SECRET=${jwt}`);
console.error(`(expires ${new Date(payload.exp * 1000).toISOString()} — rerun before then)`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agora/api exec vitest run scripts/lib/apple-secret.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Smoke the CLI with a throwaway P-256 key**

```bash
cd apps/api
openssl ecparam -genkey -name prime256v1 -noout | openssl pkcs8 -topk8 -nocrypt -out /tmp/apple-test.p8
node scripts/gen-apple-client-secret.mjs --key /tmp/apple-test.p8 --team-id TEAM123456 \
  --client-id org.example.agora.web --key-id KEY1234567 | grep -c '^GOTRUE_EXTERNAL_APPLE_SECRET=eyJ'
rm /tmp/apple-test.p8
```

Expected: `1`.

- [ ] **Step 6: Gates + commit (ask first per Global Constraints)**

Run: `pnpm -r typecheck && pnpm --filter @agora/api test`
Expected: both pass.

```bash
git add apps/api/scripts/lib/apple-secret.mjs apps/api/scripts/lib/apple-secret.test.mjs apps/api/scripts/gen-apple-client-secret.mjs
git commit -s -m "feat(scripts): gen-apple-client-secret.mjs — Sign in with Apple ES256 client secret"
```

---

### Task 3: `gotrue` compose service + Caddy routes

**Files:**
- Modify: `docker-compose.yml` (new `gotrue` service after `minio` ~line 136; `GOTRUE_UPSTREAM` in the `proxy` environment block ~line 350)
- Modify: `docker-compose.prod.yml` (same two changes, prod mirror)
- Modify: `deploy/proxy/agora-routes.caddy` (public `/auth/v1/*` handle)
- Modify: `deploy/proxy/Caddyfile` and `deploy/proxy/Caddyfile.onion` (internal `:9998` listener)

**Interfaces:**
- Consumes: `GOTRUE_JWT_SECRET` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` env names (Task 1).
- Produces: root-env var names `GOTRUE_EXTERNAL_URL`, `GOTRUE_SITE_URL`, `GOTRUE_URI_ALLOW_LIST`, `GOTRUE_MAILER_AUTOCONFIRM`, `GOTRUE_SMTP_{HOST,PORT,USER,PASS,ADMIN_EMAIL,SENDER_NAME}`, `GOTRUE_EXTERNAL_{GOOGLE,GITHUB,APPLE}_{ENABLED,CLIENT_ID,SECRET}` (Task 4 templates them); internal base URL `http://proxy:9998` (Task 4 sets `SUPABASE_URL` to it).

- [ ] **Step 1: Add the `gotrue` service to `docker-compose.yml`**

Insert after the `minio` service (before the `secure-chat` comment block):

```yaml
  # GoTrue — Supabase Auth, self-hosted (SSO for the selfhost profile). Runs against the local
  # supabase/postgres `db` (which ships the `auth` schema + supabase_auth_admin role; GoTrue applies
  # its own migrations there at boot — Drizzle never touches the auth schema). Reached ONLY through
  # the Caddy front door: publicly at /auth/v1/* (OAuth provider callbacks + email links), and
  # internally on proxy:9998 (the api's server-side supabase-js base URL — no hairpin needed).
  # Keys: run `node apps/api/scripts/gen-gotrue-keys.mjs` and paste the trio into .env.
  # Social login: set the GOTRUE_EXTERNAL_<PROVIDER>_* vars (Apple's SECRET comes from
  # apps/api/scripts/gen-apple-client-secret.mjs and expires ≤180 days).
  gotrue:
    image: supabase/auth:v2.170.0
    profiles: ["selfhost"]
    depends_on:
      db:
        condition: service_healthy
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: "9999"
      GOTRUE_DB_DRIVER: postgres
      # The supabase/postgres image provisions supabase_auth_admin with POSTGRES_PASSWORD.
      GOTRUE_DB_DATABASE_URL: postgres://supabase_auth_admin:${POSTGRES_PASSWORD:-please_change_me}@db:5432/postgres
      # Public base of THIS GoTrue as browsers/providers see it — your origin + /auth/v1.
      API_EXTERNAL_URL: ${GOTRUE_EXTERNAL_URL:-http://localhost/auth/v1}
      # Where email links / OAuth flows land by default: your front-end origin.
      GOTRUE_SITE_URL: ${GOTRUE_SITE_URL:-http://localhost}
      # Comma-separated extra redirect origins/globs the OAuth + email flows may target.
      GOTRUE_URI_ALLOW_LIST: ${GOTRUE_URI_ALLOW_LIST:-}
      GOTRUE_JWT_SECRET: ${GOTRUE_JWT_SECRET:?generate with apps/api/scripts/gen-gotrue-keys.mjs}
      GOTRUE_JWT_EXP: "3600"
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_JWT_ADMIN_ROLES: service_role
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
      GOTRUE_DISABLE_SIGNUP: "false"
      # Email: real deployments set the SMTP block; AUTOCONFIRM=true is the no-SMTP dev switch
      # (sign-ups confirm instantly; password-reset-by-email is unavailable).
      GOTRUE_MAILER_AUTOCONFIRM: ${GOTRUE_MAILER_AUTOCONFIRM:-false}
      GOTRUE_SMTP_HOST: ${GOTRUE_SMTP_HOST:-}
      GOTRUE_SMTP_PORT: ${GOTRUE_SMTP_PORT:-587}
      GOTRUE_SMTP_USER: ${GOTRUE_SMTP_USER:-}
      GOTRUE_SMTP_PASS: ${GOTRUE_SMTP_PASS:-}
      GOTRUE_SMTP_ADMIN_EMAIL: ${GOTRUE_SMTP_ADMIN_EMAIL:-}
      GOTRUE_SMTP_SENDER_NAME: ${GOTRUE_SMTP_SENDER_NAME:-Agora}
      GOTRUE_MAILER_URLPATHS_CONFIRMATION: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_RECOVERY: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_INVITE: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: /auth/v1/verify
      # Social providers — all off until configured. REDIRECT_URI is always <origin>/auth/v1/callback.
      GOTRUE_EXTERNAL_GOOGLE_ENABLED: ${GOTRUE_EXTERNAL_GOOGLE_ENABLED:-false}
      GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: ${GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID:-}
      GOTRUE_EXTERNAL_GOOGLE_SECRET: ${GOTRUE_EXTERNAL_GOOGLE_SECRET:-}
      GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI: ${GOTRUE_EXTERNAL_URL:-http://localhost/auth/v1}/callback
      GOTRUE_EXTERNAL_GITHUB_ENABLED: ${GOTRUE_EXTERNAL_GITHUB_ENABLED:-false}
      GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: ${GOTRUE_EXTERNAL_GITHUB_CLIENT_ID:-}
      GOTRUE_EXTERNAL_GITHUB_SECRET: ${GOTRUE_EXTERNAL_GITHUB_SECRET:-}
      GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI: ${GOTRUE_EXTERNAL_URL:-http://localhost/auth/v1}/callback
      GOTRUE_EXTERNAL_APPLE_ENABLED: ${GOTRUE_EXTERNAL_APPLE_ENABLED:-false}
      GOTRUE_EXTERNAL_APPLE_CLIENT_ID: ${GOTRUE_EXTERNAL_APPLE_CLIENT_ID:-}
      GOTRUE_EXTERNAL_APPLE_SECRET: ${GOTRUE_EXTERNAL_APPLE_SECRET:-}
      GOTRUE_EXTERNAL_APPLE_REDIRECT_URI: ${GOTRUE_EXTERNAL_URL:-http://localhost/auth/v1}/callback
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:9999/health"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s
    init: true
    restart: unless-stopped
```

Note: if `docker pull supabase/auth:v2.170.0` (Step 5) says the tag doesn't exist, pin the newest `v2.x` tag from `https://hub.docker.com/r/supabase/auth/tags` instead — record the chosen tag in both compose files.

- [ ] **Step 2: Add `GOTRUE_UPSTREAM` to the proxy and mirror everything into prod compose**

In `docker-compose.yml` `proxy.environment`, after `GRAFANA_UPSTREAM`:

```yaml
      # GoTrue upstream (selfhost SSO). Lazily resolved — /auth/v1/* 502s until the profile is up.
      GOTRUE_UPSTREAM: http://gotrue:9999
```

In `docker-compose.prod.yml`: add the same `gotrue` service block (after `minio`, identical env) and the proxy line as `GOTRUE_UPSTREAM: ${GOTRUE_UPSTREAM:-http://gotrue:9999}` (matching prod's overridable-upstream style, cf. its `MINIO_UPSTREAM`).

- [ ] **Step 3: Add the public Caddy route**

In `deploy/proxy/agora-routes.caddy`, insert between handle #5 (`/media/*`) and handle #6 (`/v7/*`):

```caddy
	# 5b. GoTrue (selfhost SSO) — Supabase Auth behind the front door. supabase-js and cloud Supabase
	#     address GoTrue at <origin>/auth/v1/*; GoTrue itself serves at its root (cloud fronts it with
	#     Kong stripping the prefix — handle_path reproduces that). Serves OAuth provider callbacks
	#     (/auth/v1/callback) and email links (/auth/v1/verify). Lazily resolved → 502s until
	#     `--profile selfhost` brings gotrue up. Admin endpoints under /auth/v1/admin/* are gated by
	#     GoTrue itself (service_role JWT) — same public posture as cloud Supabase.
	handle_path /auth/v1/* {
		reverse_proxy {$GOTRUE_UPSTREAM:http://gotrue:9999}
	}
```

- [ ] **Step 4: Add the internal `:9998` listener to both Caddyfile variants**

In `deploy/proxy/Caddyfile` AND `deploy/proxy/Caddyfile.onion`, append as a separate site block after the main site:

```caddy
# Internal GoTrue shim (selfhost SSO): supabase-js always calls ${SUPABASE_URL}/auth/v1/*, and the
# api container can't hairpin to the public origin when SERVER_NAME is a hostname it can't resolve
# (localhost!). This port-only site matches any Host, so the api sets SUPABASE_URL=http://proxy:9998.
# NOT published in compose — reachable only on the internal network.
http://:9998 {
	handle_path /auth/v1/* {
		reverse_proxy {$GOTRUE_UPSTREAM:http://gotrue:9999}
	}
}
```

- [ ] **Step 5: Validate compose + Caddy syntax and the image tag**

```bash
docker pull supabase/auth:v2.170.0
docker compose --profile selfhost config > /dev/null && echo compose-ok
docker compose -f docker-compose.prod.yml --profile selfhost config > /dev/null && echo prod-ok
docker run --rm -v "$PWD/deploy/proxy:/cfg:ro" caddy:2 caddy validate --config /cfg/Caddyfile --adapter caddyfile
```

Expected: pull succeeds (else re-pin per Step 1 note), `compose-ok`, `prod-ok`, Caddy `Valid configuration`. (Compose `config` will demand `GOTRUE_JWT_SECRET` because of `:?` — prefix the two compose commands with `GOTRUE_JWT_SECRET=$(openssl rand -hex 32)` for validation only.)

- [ ] **Step 6: Commit (ask first per Global Constraints)**

```bash
git add docker-compose.yml docker-compose.prod.yml deploy/proxy/agora-routes.caddy deploy/proxy/Caddyfile deploy/proxy/Caddyfile.onion
git commit -s -m "feat(selfhost): bundle GoTrue (supabase/auth) behind the Caddy front door"
```

---

### Task 4: Env templates — GoTrue block, `DEFAULT_AUTH_PROVIDER=supabase` for selfhost/prod

**Files:**
- Modify: `.env.selfhost.example` (auth section, ~lines 60–89)
- Modify: `.env.prod.example` (same restructure — locate its auth section by grepping `DEFAULT_AUTH_PROVIDER`)

**Interfaces:**
- Consumes: every root-env var name from Task 3; the three key names from Task 1.
- Produces: the documented selfhost/prod default config Task 6 boots from. `.env.dev.example` is NOT touched.

- [ ] **Step 1: Restructure the auth section of `.env.selfhost.example`**

Replace the current native-default block (from `DEFAULT_AUTH_PROVIDER=native` through the `#DEFAULT_AUTH_PROVIDER=supabase` cloud-switch lines) with a GoTrue-default block. Keep the existing comment style (LOCAL default / commented alternates). The new content:

```bash
# ── Auth: bundled GoTrue (Supabase Auth, self-hosted) — THE selfhost default ──
# The selfhost profile bundles GoTrue behind the Caddy front door: email+password AND social login
# (Google/GitHub/Apple) with no cloud dependency. SUPABASE_URL points at the proxy's INTERNAL GoTrue
# shim (server-side calls only — never expose :9998). Generate the key trio:
#   node apps/api/scripts/gen-gotrue-keys.mjs
DEFAULT_AUTH_PROVIDER=supabase
SUPABASE_URL=http://proxy:9998
SUPABASE_ANON_KEY=<GENERATE: node apps/api/scripts/gen-gotrue-keys.mjs>
SUPABASE_SERVICE_ROLE_KEY=<GENERATE: node apps/api/scripts/gen-gotrue-keys.mjs>
GOTRUE_JWT_SECRET=<GENERATE: node apps/api/scripts/gen-gotrue-keys.mjs>
# Public base of GoTrue as browsers + OAuth providers see it: your origin + /auth/v1.
GOTRUE_EXTERNAL_URL=http://localhost/auth/v1
# Your front-end origin (where email links + OAuth flows land by default) + extra allowed redirect
# globs (comma-separated) — include every origin your apps redirect back to after sign-in.
GOTRUE_SITE_URL=http://localhost
GOTRUE_URI_ALLOW_LIST=http://localhost/*
# Email: EITHER real SMTP (below) OR autoconfirm (no emails; sign-ups confirm instantly and
# password-reset-by-email is unavailable — fine for trials, not for real communities).
GOTRUE_MAILER_AUTOCONFIRM=true
#GOTRUE_SMTP_HOST=smtp.example.org
#GOTRUE_SMTP_PORT=587
#GOTRUE_SMTP_USER=postmaster@example.org
#GOTRUE_SMTP_PASS=<smtp password>
#GOTRUE_SMTP_ADMIN_EMAIL=noreply@example.org
#GOTRUE_SMTP_SENDER_NAME=Agora
# ── Social login (all optional; docs/SELF-HOSTING.md has per-provider walkthroughs) ──
# Every provider's authorized redirect URI is: ${GOTRUE_EXTERNAL_URL}/callback
#GOTRUE_EXTERNAL_GOOGLE_ENABLED=true
#GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=<Google Cloud Console → OAuth client>
#GOTRUE_EXTERNAL_GOOGLE_SECRET=<Google OAuth client secret>
#GOTRUE_EXTERNAL_GITHUB_ENABLED=true
#GOTRUE_EXTERNAL_GITHUB_CLIENT_ID=<GitHub → Settings → Developer settings → OAuth Apps>
#GOTRUE_EXTERNAL_GITHUB_SECRET=<GitHub OAuth app secret>
#GOTRUE_EXTERNAL_APPLE_ENABLED=true
#GOTRUE_EXTERNAL_APPLE_CLIENT_ID=<Apple Services ID, e.g. org.example.agora.web>
# Apple's secret is a signed JWT that EXPIRES (≤180 days) — regenerate before expiry:
#   node apps/api/scripts/gen-apple-client-secret.mjs --key AuthKey_<KEYID>.p8 \
#     --team-id <TEAM> --client-id <SERVICES_ID> --key-id <KEYID>
#GOTRUE_EXTERNAL_APPLE_SECRET=<GENERATE: gen-apple-client-secret.mjs>

# ── Auth alternative: NATIVE (Agora's own credential store; no GoTrue container needed) ──
# Uncomment this block (and comment the GoTrue block above) to run without GoTrue — email+password
# only, no social login. Confirmation/reset mail goes out via Postmark.
#DEFAULT_AUTH_PROVIDER=native
#AUTH_EMAIL_FROM=noreply@agora-oss.org
#POSTMARK_SERVER_TOKEN=<Postmark → Server → API Tokens>
#AUTH_EMAIL_LINK_BASE=http://localhost:5173
#AUTH_EMAIL_LINK_ALLOWED_ORIGINS=http://localhost,http://localhost:5175

# ── Auth alternative: CLOUD Supabase (comment the GoTrue block; run --profile supabase instead) ──
#SUPABASE_URL=https://<PROJECT_REF>.supabase.co
#SUPABASE_ANON_KEY=<Supabase → Settings → API → anon / publishable>
#SUPABASE_SERVICE_ROLE_KEY=<Supabase → Settings → API → service_role (secret)>
```

⚠️ Preserve any surrounding vars the current block carries that are not auth-related (check the exact current file content before editing — the replacement must not drop unrelated lines). Also check whether the existing native block's exact var names differ (e.g. the Postmark token name) — copy the CURRENT names from the file, not from this plan, for the native alternative block.

- [ ] **Step 2: Mirror into `.env.prod.example`**

Same restructure, with prod-appropriate values: `GOTRUE_EXTERNAL_URL=https://<YOUR_DOMAIN>/auth/v1`, `GOTRUE_SITE_URL=https://<YOUR_DOMAIN>`, `GOTRUE_URI_ALLOW_LIST=https://<YOUR_DOMAIN>/*`, `GOTRUE_MAILER_AUTOCONFIRM=false` with the SMTP block UNcommented-but-placeholder (real deployments need real email). Keep that file's existing comment conventions.

- [ ] **Step 3: Verify template completeness against compose**

```bash
grep -o '\${GOTRUE[A-Z_]*' docker-compose.yml | sort -u | sed 's/\${//' | while read v; do
  grep -q "^#\?${v}=" .env.selfhost.example || echo "MISSING in selfhost template: $v"
done
```

Expected: no `MISSING` lines (every `GOTRUE_*` var compose reads appears in the template, active or commented). Repeat against `.env.prod.example`.

- [ ] **Step 4: Commit (ask first per Global Constraints)**

```bash
git add .env.selfhost.example .env.prod.example
git commit -s -m "feat(selfhost): GoTrue-default auth config in the selfhost/prod env templates"
```

---

### Task 5: Native→GoTrue migration script

**Files:**
- Create: `apps/api/scripts/lib/native-to-gotrue.mjs`
- Create: `apps/api/scripts/lib/native-to-gotrue.test.mjs`
- Create: `apps/api/scripts/migrate-native-to-gotrue.mjs`

**Interfaces:**
- Consumes: `auth_credentials` row shape (`id`, `email`, `password_hash`, `email_confirmed_at`, `disabled_at` — see `packages/core/src/db/schema/auth.ts:29`); GoTrue admin API via `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (Task 1 names).
- Produces: `planImport(row): { credentialId, email, action: "hash-import"|"reset-required", passwordHash?, emailConfirm: boolean, banned: boolean }` and `summarize(plans): { total, hashImport, resetRequired, banned }`. CLI `migrate-native-to-gotrue.mjs --project <uuid> [--dry-run]`.

**Key facts for the implementer:**
- Native hashes are **Argon2id PHC strings** (`@node-rs/argon2` — `apps/api/src/lib/auth/password.ts`). GoTrue's admin create-user accepts pre-hashed passwords via `password_hash` for bcrypt (`$2a$/$2b$/$2y$`) and argon2 (`$argon2i$/$argon2id$`) PHC strings — so users keep their passwords.
- Native `authUserId` == `auth_credentials.id`, and `profiles.auth_user_id` stores it. GoTrue assigns a NEW uuid at create — the script MUST remap `profiles.auth_user_id` from the credential id to the returned GoTrue user id, per row. Missing this orphans every migrated account.
- Never delete native rows (rollback = flip `projects.auth_provider` back to `native`).

- [ ] **Step 1: Write the failing tests for the pure planner**

`apps/api/scripts/lib/native-to-gotrue.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { planImport, summarize } from "./native-to-gotrue.mjs";

const base = {
  id: "11111111-2222-3333-4444-555555555555",
  email: "user@example.org",
  password_hash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA",
  email_confirmed_at: new Date("2026-01-01T00:00:00Z"),
  disabled_at: null,
};

describe("planImport", () => {
  it("imports an argon2id hash for a confirmed active credential", () => {
    expect(planImport(base)).toEqual({
      credentialId: base.id,
      email: "user@example.org",
      action: "hash-import",
      passwordHash: base.password_hash,
      emailConfirm: true,
      banned: false,
    });
  });

  it("also accepts bcrypt-format hashes", () => {
    const p = planImport({ ...base, password_hash: "$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345" });
    expect(p.action).toBe("hash-import");
  });

  it("falls back to reset-required on an unrecognized hash format", () => {
    const p = planImport({ ...base, password_hash: "plain-or-unknown" });
    expect(p.action).toBe("reset-required");
    expect(p.passwordHash).toBeUndefined();
  });

  it("carries unconfirmed and disabled states", () => {
    const p = planImport({ ...base, email_confirmed_at: null, disabled_at: new Date() });
    expect(p.emailConfirm).toBe(false);
    expect(p.banned).toBe(true);
  });
});

describe("summarize", () => {
  it("counts actions and bans", () => {
    const plans = [
      planImport(base),
      planImport({ ...base, password_hash: "nope" }),
      planImport({ ...base, disabled_at: new Date() }),
    ];
    expect(summarize(plans)).toEqual({ total: 3, hashImport: 2, resetRequired: 1, banned: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agora/api exec vitest run scripts/lib/native-to-gotrue.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the pure planner**

`apps/api/scripts/lib/native-to-gotrue.mjs`:

```js
// Pure planning half of the native→GoTrue auth migration (unit-tested; the CLI does the I/O).
// GoTrue's admin create-user imports pre-hashed passwords for bcrypt and argon2 PHC strings —
// native hashes are @node-rs/argon2 argon2id, so they carry over and users keep their passwords.
// Anything else (corrupt/legacy) degrades to reset-required: account created WITHOUT a password;
// the user signs in again via the password-reset flow.
const IMPORTABLE_HASH = /^\$(2[aby]|argon2id|argon2i)\$/;

export function planImport(row) {
  const importable = typeof row.password_hash === "string" && IMPORTABLE_HASH.test(row.password_hash);
  return {
    credentialId: row.id,
    email: row.email,
    action: importable ? "hash-import" : "reset-required",
    ...(importable ? { passwordHash: row.password_hash } : {}),
    emailConfirm: Boolean(row.email_confirmed_at),
    banned: Boolean(row.disabled_at),
  };
}

export function summarize(plans) {
  return {
    total: plans.length,
    hashImport: plans.filter((p) => p.action === "hash-import").length,
    resetRequired: plans.filter((p) => p.action === "reset-required").length,
    banned: plans.filter((p) => p.banned).length,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agora/api exec vitest run scripts/lib/native-to-gotrue.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the CLI**

`apps/api/scripts/migrate-native-to-gotrue.mjs` (follow the style of `scripts/new-project.mjs` — dotenv load, postgres.js, explicit exits):

```js
#!/usr/bin/env node
// Migrate a project's NATIVE auth identities into a (self-hosted or cloud) GoTrue, then flip the
// project to auth_provider=supabase. Idempotent by email (existing GoTrue users are skipped, but
// their profile remap still runs); native rows are NEVER deleted — rollback = flip the column back.
//
//   node scripts/migrate-native-to-gotrue.mjs --project <uuid> --dry-run   # report only
//   node scripts/migrate-native-to-gotrue.mjs --project <uuid>             # apply
//
// Env: DATABASE_URL + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (apps/api/.env is loaded).
import "dotenv/config";
import postgres from "postgres";
import { planImport, summarize } from "./lib/native-to-gotrue.mjs";

const projIdx = process.argv.indexOf("--project");
const projectId = projIdx > -1 ? process.argv[projIdx + 1] : null;
const dryRun = process.argv.includes("--dry-run");
if (!projectId || !/^[0-9a-f-]{36}$/i.test(projectId)) {
  console.error("Usage: migrate-native-to-gotrue.mjs --project <uuid> [--dry-run]");
  process.exit(64);
}
const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(64);
}

const sql = postgres(DATABASE_URL, { prepare: false });
const admin = async (path, init = {}) => {
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const rows = await sql`
  select id, email, password_hash, email_confirmed_at, disabled_at
  from auth_credentials where project_id = ${projectId} order by created_at`;
const plans = rows.map(planImport);
console.log(`Planned: ${JSON.stringify(summarize(plans))}`);
for (const p of plans) console.log(`  ${p.email}: ${p.action}${p.banned ? " (banned)" : ""}`);

if (dryRun) { console.log("Dry run — no changes made."); await sql.end(); process.exit(0); }

let failed = 0;
for (const p of plans) {
  // Idempotency: an existing GoTrue user with this email is reused, not recreated.
  const existing = await admin(`/admin/users?page=1&per_page=1&filter=${encodeURIComponent(p.email)}`);
  let userId = existing.body?.users?.find?.((u) => u.email === p.email)?.id;
  if (!userId) {
    const { status, body } = await admin("/admin/users", {
      method: "POST",
      body: JSON.stringify({
        email: p.email,
        ...(p.action === "hash-import" ? { password_hash: p.passwordHash } : {}),
        email_confirm: p.emailConfirm,
        ...(p.banned ? { ban_duration: "876600h" } : {}),
      }),
    });
    if (status >= 300 || !body.id) {
      console.error(`  FAILED ${p.email}: HTTP ${status} ${body.msg ?? body.message ?? ""}`);
      failed++;
      continue;
    }
    userId = body.id;
  }
  // Remap the profile link: native auth_user_id was the CREDENTIAL id; point it at the GoTrue user.
  const updated = await sql`
    update profiles set auth_user_id = ${userId}
    where project_id = ${projectId} and auth_user_id = ${p.credentialId}`;
  console.log(`  ${p.email}: ${p.action} → gotrue ${userId} (profiles remapped: ${updated.count})`);
}

if (failed > 0) {
  console.error(`${failed} account(s) failed — auth_provider NOT flipped. Fix and rerun (idempotent).`);
  await sql.end();
  process.exit(1);
}
await sql`update projects set auth_provider = 'supabase' where id = ${projectId}`;
console.log("auth_provider flipped to 'supabase'. The api caches the provider ~30s (lib/auth TTL);");
console.log("native rows retained — rollback = set auth_provider back to 'native'.");
await sql.end();
```

- [ ] **Step 6: Verify the CLI arg/env guards without a live stack**

```bash
cd apps/api
node scripts/migrate-native-to-gotrue.mjs; echo "exit=$?"
node scripts/migrate-native-to-gotrue.mjs --project not-a-uuid; echo "exit=$?"
```

Expected: usage message, `exit=64` both times (no DB touched). Full end-to-end rehearsal happens in Task 6.

- [ ] **Step 7: Gates + commit (ask first per Global Constraints)**

Run: `pnpm -r typecheck && pnpm --filter @agora/api test`
Expected: both pass.

```bash
git add apps/api/scripts/lib/native-to-gotrue.mjs apps/api/scripts/lib/native-to-gotrue.test.mjs apps/api/scripts/migrate-native-to-gotrue.mjs
git commit -s -m "feat(scripts): migrate-native-to-gotrue.mjs — opt-in native→GoTrue auth migration"
```

---

### Task 6: Stack verification (spec's "verify, don't rewrite" items)

**Files:** none created/modified — this task produces evidence. Any genuine behavioral difference vs cloud Supabase found here is a STOP-and-raise, not a silent patch (Global Constraints).

**Interfaces:**
- Consumes: everything from Tasks 1–5; a root `.env` assembled from `.env.selfhost.example`.

- [ ] **Step 1: Assemble a working selfhost `.env` and boot the stack**

```bash
cp .env.selfhost.example /tmp/agora-sso-env-backup 2>/dev/null; cp .env .env.pre-sso-backup 2>/dev/null
cp .env.selfhost.example .env
node apps/api/scripts/gen-gotrue-keys.mjs        # paste the trio into .env
# Also set in .env: POSTGRES_PASSWORD + MINIO_ROOT_PASSWORD (openssl rand -hex 16 each),
# ACCESS_TOKEN_SECRET, GOTRUE_MAILER_AUTOCONFIRM=true, and the other <GENERATE:> placeholders.
docker compose --profile selfhost up -d --build
docker compose --profile selfhost ps
```

Expected: `db`, `minio`, `gotrue`, `agora`, `proxy`, `cron` all up; `gotrue` reaches `healthy`. ⚠️ If the user's current `.env` exists, back it up FIRST (line 1) and restore it when the task ends.

If `gotrue` crash-loops on DB auth: the `supabase_auth_admin` role password should equal `POSTGRES_PASSWORD` (the supabase/postgres image provisions it) — verify with `docker compose exec db psql -U postgres -c "alter role supabase_auth_admin password '<POSTGRES_PASSWORD>'"` and restart `gotrue`. If this manual step proves NECESSARY, that's a finding: record it and add the fix to `docs/SELF-HOSTING.md` in Task 7.

- [ ] **Step 2: Migrate + seed the database**

```bash
cd apps/api
# .env here should point DATABASE_URL at localhost:5432 (host-side) per the template's dev notes.
pnpm db:migrate:run
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); psql "$url" -v ON_ERROR_STOP=1 -f scripts/seeds/seed.sql
```

Expected: migrations apply cleanly; seed.sql asserts pass.

- [ ] **Step 3: Verify GoTrue through both Caddy paths**

```bash
curl -s http://localhost/auth/v1/health
docker compose exec agora wget -qO- http://proxy:9998/auth/v1/health
```

Expected: both return GoTrue's health JSON (name/version) — public route and internal shim both live.

- [ ] **Step 4: Verify the seed admin helper against local GoTrue (spec verify-item 2)**

```bash
cd apps/api && node scripts/seeds/00-seed-auth-admin.mjs
```

Expected: the supabase backend helper (`seeds/helpers/seed-supabase-auth-admin.mjs`) creates the confirmed admin against LOCAL GoTrue with no code change (project `auth_provider` must be `supabase` — the template default seeds it so; verify with `psql "$url" -c "select auth_provider from projects"`).

- [ ] **Step 5: Verify the email+password round-trip through the API**

```bash
PID=11111111-1111-1111-1111-111111111111
curl -s -X POST http://localhost/v7/$PID/auth/sign-up \
  -H 'content-type: application/json' \
  -d '{"email":"sso-check@example.org","password":"Str0ngPass!x"}' | head -c 400; echo
curl -s -X POST http://localhost/v7/$PID/auth/sign-in-with-email-and-password \
  -H 'content-type: application/json' \
  -d '{"email":"sso-check@example.org","password":"Str0ngPass!x"}' | head -c 400; echo
```

(Exact auth paths: confirm against `docs/MANIFEST.md` §auth before running.) Expected: sign-up succeeds (autoconfirm ⇒ immediate session), sign-in returns the Agora token envelope. This proves `SupabaseAuthProvider` → internal shim → GoTrue end-to-end.

- [ ] **Step 6: Verify the PKCE authorize/callback pair against bare GoTrue (spec verify-item 1)**

With a real Google OAuth client configured in `.env` (`GOTRUE_EXTERNAL_GOOGLE_*`, redirect URI `http://localhost/auth/v1/callback` registered in Google Cloud Console — needs Jenova's credentials):

```bash
curl -s "http://localhost/v7/$PID/auth/oauth/authorize?provider=google" | head -c 500
```

(Exact authorize/callback paths + params: confirm against `routes/misc.ts` before running.) Expected: a Google `accounts.google.com` authorize URL is returned (not `oauth/not-configured`). Then complete the flow once in a browser: Google consent → GoTrue `/auth/v1/callback` → app redirect → Agora session minted; an `oauth_identities` row exists. Repeat for GitHub. Apple requires the paid developer account — run the same flow when Jenova provides the Services ID + key; until then record Apple as "configured-but-unvalidated" in the Task 7 docs.

- [ ] **Step 7: Verify delete modes against local GoTrue (spec verify-item 3)**

For the `sso-check@example.org` user: exercise `SupabaseAuthProvider.deleteUser` semantics directly against local GoTrue with the service key (hard delete):

```bash
SRK=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env | cut -d= -f2-)
UID=$(curl -s "http://localhost/auth/v1/admin/users?filter=sso-check@example.org" \
  -H "apikey: $SRK" -H "authorization: Bearer $SRK" | node -pe 'JSON.parse(require("fs").readFileSync(0)).users[0]?.id')
curl -s -X DELETE "http://localhost/auth/v1/admin/users/$UID" -H "apikey: $SRK" -H "authorization: Bearer $SRK" -o /dev/null -w '%{http_code}\n'
```

Expected: `200`. (Soft-delete and ban are the same admin API with different bodies — the provider code is identical against cloud and local; this confirms the admin surface answers.)

- [ ] **Step 8: Migration rehearsal (spec requirement)**

```bash
cd apps/api
# 1. Create a THROWAWAY native project + user in the local DB:
node scripts/new-project.mjs --help   # use its flags to create a project; then flip it native:
psql "$url" -c "update projects set auth_provider='native' where id='<NEW_PID>'"
# sign up a native user via the API (server: pnpm dev pointed at this DB, or the container):
curl -s -X POST http://localhost/v7/<NEW_PID>/auth/sign-up -H 'content-type: application/json' \
  -d '{"email":"native-mig@example.org","password":"MigratePass1!"}'
# 2. Rehearse:
node scripts/migrate-native-to-gotrue.mjs --project <NEW_PID> --dry-run
node scripts/migrate-native-to-gotrue.mjs --project <NEW_PID>
# 3. Prove the password survived the hash import:
curl -s -X POST http://localhost/v7/<NEW_PID>/auth/sign-in-with-email-and-password \
  -H 'content-type: application/json' -d '{"email":"native-mig@example.org","password":"MigratePass1!"}' | head -c 300
```

Expected: dry-run reports `hashImport: 1`; apply remaps the profile (`profiles remapped: 1`) and flips the provider; the final sign-in (wait ~30s for the provider TTL, or restart the api container) succeeds **with the pre-migration password** through GoTrue. If GoTrue rejects the argon2id `password_hash` (HTTP 4xx naming the hash): STOP — that invalidates the hash-import premise; raise it (fallback = reset-required for all, a spec-level decision).

- [ ] **Step 9: Record results + restore env**

Write findings (each verify-item: pass/fail + evidence snippet) into the task notes for Task 7's docs. Restore the user's original `.env` (`mv .env.pre-sso-backup .env`) and `docker compose --profile selfhost down` if the user doesn't want the stack left running. Nothing to commit.

---

### Task 7: Docs, propagation, changelog

**Files:**
- Modify: `docs/SELF-HOSTING.md` (new "SSO / social login (bundled GoTrue)" section)
- Modify: `README.md` (env-files / selfhost blurb: mention bundled SSO)
- Modify: `wiki/Deployment.md` (selfhost profile now includes `gotrue`)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)
- Possibly modify: `docs/PROPAGATION.yaml` (only if the checker or /propagate rulings demand an exception entry)

**Interfaces:**
- Consumes: Task 6 findings (incl. any `supabase_auth_admin` password fix, Apple validation status); all var names from Tasks 1–4.

- [ ] **Step 1: Write the SELF-HOSTING.md section**

Add a top-level section covering, in order: what you get (email+password + Google/GitHub/Apple, no cloud); architecture note (GoTrue behind Caddy at `/auth/v1/*`, internal `proxy:9998` shim, `auth` schema self-migrated); setup steps (gen-gotrue-keys → paste trio → set `GOTRUE_EXTERNAL_URL`/`GOTRUE_SITE_URL`/`GOTRUE_URI_ALLOW_LIST` → SMTP or autoconfirm → `--profile selfhost up`); per-provider walkthroughs — Google (Cloud Console OAuth client, redirect URI `<origin>/auth/v1/callback`), GitHub (Developer settings OAuth app, same redirect), Apple (Services ID + `.p8` key + `gen-apple-client-secret.mjs`, the ≤180-day expiry + regeneration duty, validation status from Task 6); security notes (`service_role` = root credential, server-only; `/auth/v1/admin/*` gated by GoTrue; `:9998` never published); migration subsection (when to use `migrate-native-to-gotrue.mjs`, dry-run first, rollback = flip the column, native rows retained); native-auth remains available (the commented template block). Fold in any Task 6 findings.

- [ ] **Step 2: README + wiki touch-ups**

README: in the selfhost/deployment overview, add one line that the selfhost profile bundles GoTrue for SSO (email+password and Google/GitHub/Apple) and link the SELF-HOSTING.md section. `wiki/Deployment.md`: add `gotrue` to the selfhost service list with the same one-liner.

- [ ] **Step 3: CHANGELOG entry**

Under `## [Unreleased]` → `### Added`:

```markdown
- Self-hosted SSO: the `selfhost` profile now bundles Supabase Auth (GoTrue) behind the Caddy
  front door (`/auth/v1/*` public + internal `proxy:9998` shim) — email+password and
  Google/GitHub/Apple social login with no cloud dependency. New scripts:
  `gen-gotrue-keys.mjs` (JWT secret + anon/service_role keys), `gen-apple-client-secret.mjs`
  (Apple's expiring ES256 client secret), and `migrate-native-to-gotrue.mjs` (opt-in native→GoTrue
  migration that preserves argon2id password hashes and remaps `profiles.auth_user_id`; native
  auth remains supported for zero-infra dev). Spec:
  `docs/superpowers/specs/2026-08-22-selfhost-gotrue-sso-design.md`.
```

- [ ] **Step 4: Run the propagation checker over the branch diff**

```bash
pnpm --filter @agora/api check:propagation --diff root
```

Expected: obligations for the compose/env changes all resolved by Tasks 4/7 edits (env templates ×2 intentionally — dev is exempt by design, record as an `exceptions:` entry in `docs/PROPAGATION.yaml` ONLY if the checker flags `.env.dev.example`: subject `GOTRUE_*`, target `.env.dev.example`, reason "dev stays native-auth by design — spec 2026-08-22"). Fix anything genuinely missed.

- [ ] **Step 5: Final gates + commit (ask first per Global Constraints)**

Run: `pnpm -r typecheck && pnpm test`
Expected: both pass.

```bash
git add docs/SELF-HOSTING.md README.md wiki/Deployment.md CHANGELOG.md docs/PROPAGATION.yaml
git commit -s -m "docs(selfhost): GoTrue SSO section, propagation + changelog"
```

---

## Self-Review Notes

- **Spec coverage:** compose/Caddy/keys (T1, T3), Apple helper (T2), env templates + provider blocks (T4), migration incl. profile remap (T5 — the remap is an addition the spec implied but did not spell out), all three verify-items + migration rehearsal + e2e (T6), docs/propagation/changelog + security posture prose (T7). `.env.dev.example` untouched everywhere. Out-of-scope items: no task touches them.
- **Known uncertainties, called out where they bite:** the `supabase/auth` image tag (T3 S5 has the re-pin fallback), `supabase_auth_admin` password provisioning (T6 S1 fallback), GoTrue's acceptance of argon2id `password_hash` (T6 S8 STOP condition), exact MANIFEST auth/oauth paths (T6 S5/S6 say confirm before running).
