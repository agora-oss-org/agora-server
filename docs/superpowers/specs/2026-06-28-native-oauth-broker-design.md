# Native OAuth broker — design

**Status:** approved design, pre-implementation
**Date:** 2026-06-28
**Scope:** Add OAuth (social/SSO sign-in) to the **native** auth provider, so a self-hosted
deployment running `DEFAULT_AUTH_PROVIDER=native` (no Supabase) can offer "Sign in with
Google / GitHub / …". Also: introduce a shared at-rest secret-encryption facility and apply it to
both the new OAuth client secrets and the existing `moderator_config.llmApiKey`.

---

## 1. Problem & motivation

OAuth today is **Supabase-brokered**. `apps/api/src/routes/misc.ts` (`/oauth/authorize`,
`/oauth/link`, `/oauth/callback`) drives the provider handshake through `supabase-js`
(`lib/oauth.ts`: `pkceClient()`, `signInWithOAuth()`, `exchangeCodeForSession()`), gated on
`oauthConfigured()` (= `SUPABASE_URL` + `SUPABASE_ANON_KEY` present). The **native** auth provider
(`lib/auth/native-provider.ts`) is email/password + confirmation/reset **only** — it has no OAuth.

Therefore a purely self-hosted deployment (the `--profile selfhost` data plane, `auth_provider =
native`, no Supabase) **cannot offer OAuth at all**. This closes that gap by brokering OAuth
ourselves, with no Supabase dependency.

**Non-goals:** changing the SDK contract; changing the Supabase-brokered behavior for
`auth_provider = supabase` projects; implementing OAuth token *refresh*/provider-API access (we only
use OAuth to establish identity, then mint our own Agora session).

---

## 2. Key facts the design leans on (already in the codebase)

- The OAuth **primitives are provider-agnostic**: `oauth_identities` is keyed by `(project_id,
  provider, provider_uid)`; `oauth_states` carries `provider`, `flow`, `redirect_after_auth`, and a
  broker-opaque `pkce` jsonb. The callback's post-exchange logic (`ensureOAuthProfile`,
  `recordIdentity`, `mintSession`, fragment redirect) does **not** depend on Supabase.
- The **only** Supabase coupling is the broker mechanics in `lib/oauth.ts` + the
  `signInWithOAuth`/`exchangeCodeForSession` calls inside `startOAuth`/callback.
- `getAuthProvider(projectId)` (`lib/auth/index.ts`) is the exact selection pattern to mirror:
  30 s cache, project-scoped, **fail-safe default to supabase**.
- `project_integrations` (`name` text, `data` jsonb) exists and is the home for per-project config.
  It has **no** unique constraint today.
- SSRF helpers exist (`lib/ssrf.ts`: `assertPublicUrl`, `resolveAndAssertPublic`, `safeFetchText`).
  These MUST guard every outbound OAuth call — native OAuth means *we* make the network calls.
- `moderator_config.llmApiKey` is **already write-only at the API** (GET exposes only
  `hasLlmApiKey`, `packages/contract/src/schemas.ts:361`) but stored **plaintext in jsonb**, and is
  **read directly from the DB by the Python scorer** (`services/scorer/scorer/db.py:294`,
  overlaid in `config.py`). Encrypting it therefore requires **cross-language** decrypt.

---

## 3. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Provider model | **Generic OIDC engine + presets.** `google`/`gitlab` (OIDC via issuer discovery), `github` (non-OIDC adapter), `custom` (admin supplies `issuer`). |
| 2 | Architecture | **`OAuthBroker` seam** parallel to `getAuthProvider()`; `SupabaseOAuthBroker` (wraps today) vs `NativeOAuthBroker`. Selected by `projects.auth_provider`. |
| 3 | Config location | **Per-project `project_integrations` row** (`name='oauth'`, `data` jsonb). |
| 4 | Account linking | **Auto-link if email verified.** Identity match → return; `email_verified && email` matches existing profile → link; else new profile. Unverified-matching-email never auto-links. |
| 5 | Secret at rest | **Encrypted at rest, write-only API.** Shared `lib/secrets.ts` (TS) + `scorer/secrets.py` (Py), AES-256-GCM, key from env `SECRET_ENC_KEY`. Applied to **both** OAuth `client_secret` and `moderator_config.llmApiKey`. |
| 6 | `llmApiKey` retrofit | **Dual-read, no SQL data migration** (SQL can't run AES with the app key). Reads tolerate legacy plaintext; writes always encrypt; optional backfill script. |
| 7 | Redirect hardening | **Add a per-project redirect allowlist** and validate `redirectAfterAuth` against it (fail closed). Behavior change to the existing flow — see §8. |

---

## 4. Architecture — the broker seam

New module group:

```
apps/api/src/lib/oauth/
  broker.ts            # interface OAuthBroker + getOAuthBroker(projectId) (mirrors getAuthProvider)
  supabase-broker.ts   # wraps today's lib/oauth.ts — ZERO behavior change
  native-broker.ts     # generic OIDC / OAuth2 code+PKCE client
  oidc.ts              # .well-known discovery (cached), JWKS id_token verification, token exchange
  presets.ts           # google/gitlab (oidc) + github (oauth2 adapter) + custom
  config.ts            # resolve + decrypt the project_integrations 'oauth' row (30s cache)
```

```ts
interface NormalizedIdentity {
  providerUid: string;          // stable per-provider subject id
  email?: string;
  emailVerified: boolean;
  name?: string;
  avatar?: string;
}

interface OAuthStateSeed {       // persisted into oauth_states.pkce (broker-opaque jsonb)
  codeVerifier?: string;         // OIDC PKCE
  nonce?: string;                // OIDC nonce
}

interface OAuthBroker {
  authorize(projectId: string, provider: string, callbackUrl: string):
    Promise<{ url: string; state: OAuthStateSeed }>;
  callback(projectId: string, provider: string, code: string, state: OAuthStateSeed):
    Promise<NormalizedIdentity>;
}
```

**Selection** (`getOAuthBroker`): `projects.auth_provider === 'native'` → `NativeOAuthBroker`,
else `SupabaseOAuthBroker`. Same 30 s cache + fail-safe-to-supabase default as `getAuthProvider`.

The route handlers (`/oauth/authorize`, `/oauth/link`, `/oauth/callback`) shrink to broker calls.
Everything after `NormalizedIdentity` is the existing, provider-agnostic path. `oauth_states`,
`oauth_identities`, and the **SDK contract are untouched**.

---

## 5. Config & data model

`project_integrations` row, `name = 'oauth'`, `data`:

```jsonc
{
  "redirectAllowlist": ["https://app.example.com", "myapp://auth"],  // see §8
  "providers": {
    "google": { "enabled": true, "clientId": "…", "secretEnc": "v1:…",
                "scopes": ["openid","email","profile"] },
    "github": { "enabled": true, "clientId": "…", "secretEnc": "v1:…" },
    "acme":   { "enabled": true, "kind": "oidc", "issuer": "https://idp.acme.com",
                "clientId": "…", "secretEnc": "v1:…", "label": "Acme SSO" }
  }
}
```

- **`presets.ts`** holds static per-provider facts: `google`/`gitlab` → `{kind:'oidc', issuer}`;
  `github` → `{kind:'oauth2', authorizeUrl, tokenUrl, userUrl, emailsUrl}`; `custom` → generic OIDC,
  requires admin-supplied `issuer`.
- **`config.ts`** → `getOAuthConfig(projectId)`, 30 s cache (mirrors `getSocialConfig`). Secrets are
  decrypted **lazily, only inside the flow** — never in the admin/list view.
- **Schema change:** add `unique(project_id, name)` to `project_integrations` (Drizzle-expressible)
  so `'oauth'` is a per-project singleton and writes are a clean upsert.

---

## 6. Flows

### `/oauth/authorize` (and `/oauth/link`) → `broker.authorize()`
- **OIDC (google/gitlab/custom):** fetch `<issuer>/.well-known/openid-configuration` (cached,
  **SSRF-guarded**); build the authorize URL with `client_id`, `redirect_uri` = our callback,
  `scope`, `state` = `oauth_states.id`, **PKCE S256** `code_challenge`, and a **`nonce`**.
- **GitHub adapter:** fixed authorize URL, `scope = read:user user:email`, `state`.
- Persist `OAuthStateSeed` (`{ codeVerifier, nonce }`) into the existing `oauth_states.pkce` jsonb
  (broker-opaque; Supabase dumps its own blob there today).
- `redirectAfterAuth` is validated against the allowlist **before** the row is written (§8).

### `/oauth/callback` → `broker.callback()`
- Exchange `code` at the token endpoint (**SSRF-guarded fetch**; decrypt `client_secret` here).
- **OIDC:** validate the `id_token` — **JWKS signature** (jose), `iss`/`aud`/`exp`/`nbf`,
  **`nonce`** match — then read `sub`/`email`/`email_verified`/`name`/`picture`.
- **GitHub:** exchange → access token → `GET /user` + `GET /user/emails`; pick the **primary
  verified** email; `providerUid` = GitHub user id; `emailVerified` from GitHub's `verified` flag.
- Returns `NormalizedIdentity`. The **unchanged** route logic then runs: link-vs-signin → profile
  resolution (§7) → `recordIdentity` → `mintSession` → fragment redirect.

---

## 7. Account resolution (native broker)

New helper `resolveProfileForIdentity(projectId, identity, flow, linkProfileId)`:

1. **`flow === 'link'`** (authed user linking a provider) → use `linkProfileId`'s profile; attach
   identity. (Matches today's link path.)
2. **Identity exists** (`oauth_identities` by `provider`+`providerUid`) → return its profile
   (returning user).
3. **`identity.emailVerified && identity.email` matches an existing profile (by lowercased email)**
   → **link**: attach the identity + add provider to `authMethods`.
4. **Otherwise** → create a fresh profile, `authMethods = [provider]`. (An *unverified* matching
   email lands here — a separate account, never an auto-link.)

Notes:
- Native OAuth-only users have `auth_user_id = null` (identity lives in `oauth_identities`).
  Linking onto a native password user leaves their `auth_user_id` (= `auth_credentials.id`) intact
  and just adds the OAuth identity.
- The **Supabase broker keeps its current `auth_user_id`-keyed behavior** — unchanged. The
  email-based auto-link is a **native-broker** behavior (the chosen "auto-link if verified").

---

## 8. Security gates (security-first checklist)

- **PKCE S256** (OIDC) + **`state`** CSRF binding + **`nonce`** in id_token + one-shot `state` delete
  (already present in the callback).
- **Full `id_token` validation** — reject on bad signature / `iss` / `aud` / `exp`/`nbf` / `nonce`.
- **`email_verified` gate** on auto-linking — `false`/absent never links (account-takeover defense).
- **SSRF on every outbound call** — discovery, JWKS, token, userinfo all go through
  `resolveAndAssertPublic` / `safeFetch*`. **Essential**: `issuer` is admin-supplied for `custom`.
- **Secrets at rest** — AES-256-GCM, key from `SECRET_ENC_KEY`; never logged or echoed; GET returns
  `secretSet` / `hasLlmApiKey` booleans only. Per **Log with intent**, the raw secret/exception goes
  only on `debug`.
- **Redirect hardening (behavior change):** today `redirectAfterAuth` is trusted verbatim from the
  client body (a latent open redirect, pre-existing in the Supabase flow). We add a per-project
  `redirectAllowlist` (on the oauth row) and validate `redirectAfterAuth` against it, **failing
  closed** on mismatch. Applies to **both** brokers (closes the existing hole too). An empty/unset
  allowlist → reject all (must be configured to use OAuth) — or, to preserve current behavior for
  existing Supabase projects, treat unset as "allow" with a startup warn. **Open question O-1.**
- **Authorization** — config writes are `requireProjectAdmin`; the public enabled-list (`§9`) is
  unauth but exposes names/labels only; a provider must be `enabled` or the broker refuses.

---

## 9. Admin surface & API

- **Config REST** (project-admin-gated; mirrors `/webhooks/config`, `/feed/config`):
  - `GET /oauth/providers` → redacted view `{ enabled, clientId, secretSet, issuer?, scopes, label }`
    per provider, plus `redirectAllowlist`.
  - `PUT /oauth/providers` → write (secrets write-only; a `null`/omitted secret keeps the stored one,
    an empty string clears it — mirror `moderatorConfigSchema`'s `llmApiKey` semantics).
  - `DELETE /oauth/providers/:provider`.
  - Schemas in `packages/contract` (`oauthProvidersConfigSchema`, view type).
- **Public enabled-list:** `GET /oauth/providers/enabled` → `[{ provider, label }]` (no secrets,
  unauth) so the host-app login screen knows which buttons to render.
- **Admin app** (`apps/admin`): Settings → **Auth → OAuth providers** tab — toggle per provider,
  enter client id/secret, custom `issuer`, edit `redirectAllowlist`, and **display the exact redirect
  URI** (`<PUBLIC_BASE_URL>/v7/<projectId>/oauth/callback`) to paste into the IdP console.

---

## 10. Shared secret-encryption facility

- **`apps/api/src/lib/secrets.ts` (TS)** + **`services/scorer/scorer/secrets.py` (Py)** — identical
  format: versioned blob `v1:<base64(iv ‖ tag ‖ ciphertext)>`, AES-256-GCM, key derived from
  `SECRET_ENC_KEY` (require ≥32 bytes; both services load it, like the already-shared
  `ACCESS_TOKEN_SECRET`).
  - `encryptSecret(plaintext) → "v1:…"`, `decryptSecret(blob) → plaintext`.
  - **Dual-read:** `decryptSecret` detects an **un-prefixed** (legacy plaintext) value and returns
    it unchanged — zero-downtime retrofit, no SQL data migration. Every **write** re-encrypts.
  - `SECRET_ENC_KEY` is **optional at boot** but **required when any secret needs encrypting** (an
    OAuth provider with a secret, or a write to `llmApiKey`); fail closed with a clear error if a
    secret is being written and the key is unset.
- **Applied to:** OAuth `client_secret` (new) and `moderator_config.llmApiKey` (retrofit — TS write
  path encrypts; the Python scorer read path decrypts via `scorer/secrets.py`, dual-reading legacy
  plaintext).
- **Optional backfill:** `apps/api/scripts/encrypt-existing-secrets.mjs` to proactively convert
  existing plaintext `llmApiKey` rows (idempotent — skips already-`v1:` values).
- **Env:** add `SECRET_ENC_KEY` to the core env schema (`packages/core`), validated `≥32 bytes` when
  present; document in `.env.example` + the per-app subsets.

---

## 11. Testing

**Unit (vitest, no DB):**
- `secrets`: round-trip; GCM-tamper fails; legacy-plaintext passthrough; wrong-key fails.
- `oidc`: `id_token` validation negative cases (bad sig / iss / aud / nonce / exp) with synthetic
  JWKS; positive case.
- `presets` / GitHub adapter: primary-verified email selection; normalized-identity mapping.
- `resolveProfileForIdentity`: the full decision matrix (link flow / identity-exists /
  verified-match → link / unverified-match → new / no-email → new).
- config view redaction: no secret ever appears in the GET view.
- `redirectAfterAuth` allowlist matcher (allow / reject / unset behavior per O-1).

**Integration (real Postgres, by `project_id`):**
- config write → read: ciphertext in the DB row, never echoed by GET.
- broker selection by `auth_provider`.
- full native callback against a **mocked OIDC server** (or injected broker): creates a profile,
  links a verified-email match, mints a session; one-shot `state`.
- negatives: disabled provider; unknown/expired `state`; SSRF-blocked `issuer`; redirect not in
  allowlist.

**Cross-language vector:** a Python test decrypts a TS-`encryptSecret` fixture (guards the format
contract); and a TS test decrypts a Py-encrypted fixture.

---

## 12. Files touched (estimate)

- **New:** `apps/api/src/lib/oauth/{broker,supabase-broker,native-broker,oidc,presets,config}.ts`;
  `apps/api/src/lib/secrets.ts`; `services/scorer/scorer/secrets.py`;
  `apps/api/scripts/encrypt-existing-secrets.mjs`; admin OAuth-providers tab; contract schemas;
  tests for each pure module + integration.
- **Changed:** `apps/api/src/routes/misc.ts` (OAuth handlers → broker calls; new config endpoints;
  `llmApiKey` write encrypts); `packages/core` env schema (+`SECRET_ENC_KEY`); `project_integrations`
  schema (+unique constraint) + migration; `services/scorer` `db.py`/`config.py` (decrypt
  `llmApiKey`); `lib/oauth.ts` folded behind `supabase-broker.ts`; `.env.example` (+ docs);
  `CHANGELOG.md`.
- **Docs:** update `SECURITY.md` (secret-at-rest posture, redirect allowlist), `docs/SELF-HOSTING.md`
  (native OAuth setup), and the auth section of `docs/MANIFEST.md` if the config endpoints are added
  to the contract surface.

---

## 13. Open questions

- **O-1 — redirect allowlist default.** When `redirectAllowlist` is unset: reject all (secure,
  forces config) vs. allow with a startup warn (preserves current Supabase-project behavior)?
  Leaning **allow-with-warn for existing supabase projects, required for native** to avoid breaking
  live deployments, but confirm.
- **O-2 — `custom` provider count.** v1 allows a single `custom` OIDC provider keyed `custom`, or
  arbitrarily many keyed by admin-chosen slug? Design supports many (keyed by the `providers` map
  key); confirm the admin UI should expose "add custom provider".
- **O-3 — Supabase parity.** Should the email-based auto-link (§7.3) eventually be applied to the
  Supabase broker too (today it's `auth_user_id`-keyed only)? Out of scope here; note for later.
