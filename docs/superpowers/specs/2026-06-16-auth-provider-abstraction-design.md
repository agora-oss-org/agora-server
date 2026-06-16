# Auth-Provider Abstraction + Native Auth — Design

> **Status:** approved design (brainstorm), 2026-06-16
> **Sub-project:** A (of the managed-hosting initiative — see `../../../../agora-hosting/docs/`)
> **Repo:** `agora-server` (AGPL — this is a trust-boundary change, stays in the open server)
> **Next:** implementation plan via writing-plans

## Context

We're turning Agora into managed hosting with two tiers (see `agora-hosting/docs/`):
a **shared** tier (many tenants on one Supabase instance) and a **dedicated** tier
(one Supabase per tenant). Supabase Auth's `auth.users.email` is unique *per Supabase
project*, so the shared tier cannot use Supabase Auth for true per-tenant identity —
the same email across two tenants would collide. The shared tier must own its own
credential store; the dedicated tier keeps Supabase Auth (and its integration/control).

This sub-project introduces a provider abstraction so one codebase serves both, then
builds the native (Agora-owned) provider for the shared tier.

### Current state (what exists today)

`apps/api/src/routes/auth.ts` calls Supabase Auth directly at these credential paths:

| Endpoint | Supabase call |
|---|---|
| `POST /sign-up` | `signUp` (returns session, or no-session ⇒ `confirmation_required`) |
| `POST /sign-in` | `signInWithPassword` |
| `POST /change-password` | `signInWithPassword` (verify current) + `admin.updateUserById` |
| `POST /request-password-reset` | `resetPasswordForEmail` (always 200, anti-enumeration) |
| `POST /verify-email` | `verifyOtp` ⇒ set `profiles.is_verified` |
| `POST /send-verification-email` | `resend({type:"signup"})` |

**Not credential paths — unchanged by this work:** `/sign-out` (token revoke),
`/request-new-access-token` (rotation), `/verify-external-user` (RS256 external JWT).

Key structural facts the design leans on:

- The **session/JWT layer is already Agora's own** (`lib/tokens.ts` — `mintSession`,
  `rotateRefreshToken`). Supabase only verifies credentials + sends emails.
- Every credential path funnels identity through **`profiles.auth_user_id`** (nullable
  uuid, app-enforced link). `ensureProfile` / `profileByAuthUser` / `sessionResponse`
  are written against that id, *not* against Supabase specifically.

## Goals

1. Extract an `AuthProvider` interface; make `routes/auth.ts` provider-agnostic.
2. `SupabaseAuthProvider` wraps today's behavior **with zero regression** (default for
   all existing projects, self-host, and the dedicated tier).
3. `NativeAuthProvider` owns an Agora credential store enabling true per-tenant identity
   (`unique (project_id, email)`) for the shared tier. Password + email confirm/reset,
   **no OAuth** in this MVP.
4. Abstract email sending behind `EmailSender`; ship a dev impl; defer the production
   transport choice to a config-only follow-up.
5. Per-project selection via `projects.auth_provider` (`supabase` default).

## Non-goals (explicitly out of scope for A)

- Native OAuth / social login (dedicated keeps Supabase OAuth; shared is password-only).
- The production email transport impl (Resend/SES/Postmark) — interface only here.
- Per-project role system (sub-project B), control plane, billing, domain routing.
- Migrating existing Supabase-auth users to native (not needed; providers coexist).

## The elegant pivot

The abstraction swaps **who verifies a credential**, not how profiles or sessions work.
A native credential row's own `id` *becomes* `profiles.auth_user_id`. So `ensureProfile`,
`profileByAuthUser`, `sessionResponse`, and all of `lib/tokens.ts` stay **unchanged** —
the diff is confined to the credential boundary.

## Design

### 1. `AuthProvider` interface (`lib/auth/provider.ts`)

```ts
export interface AuthProvider {
  signUp(projectId: string, email: string, password: string):
    Promise<{ status: "confirmed"; authUserId: string }
           | { status: "confirmation_required" }>;
  verifyCredentials(projectId: string, email: string, password: string):
    Promise<{ authUserId: string } | null>;
  changePassword(authUserId: string, current: string, next: string): Promise<void>; // throws on wrong current
  startPasswordReset(projectId: string, email: string): Promise<void>;  // best-effort; never throws/enumerates
  confirmEmail(projectId: string, token: string): Promise<{ authUserId: string }>;   // route then sets is_verified
  resendConfirmation(projectId: string, email: string): Promise<void>;
}
```

`routes/auth.ts` resolves the provider per project, calls the method, then runs the
**existing** profile/session code. Error envelopes stay identical (`auth/invalid-credentials`,
`auth/sign-up-failed`, `auth/wrong-password`, `auth/verify-failed`, …) so the SDK
contract is unchanged.

### 2. `SupabaseAuthProvider` (`lib/auth/supabase-provider.ts`)

Moves the existing `getSupabase*` calls behind the interface verbatim. `signUp` maps
GoTrue's no-session response to `confirmation_required`; `confirmEmail` wraps `verifyOtp`
(token = Supabase `token_hash`); `changePassword` keeps verify-then-`admin.updateUserById`.
**Behavior-preserving** — characterized by the existing auth tests + an integration smoke.

### 3. `NativeAuthProvider` (`lib/auth/native-provider.ts`) — the new, security-sensitive code

New tables (in `schema/auth.ts`; new custom migration for `citext` + partial indexes):

```
auth_credentials
  id                 uuid pk        ← becomes profiles.auth_user_id
  project_id         uuid not null
  email              citext not null
  password_hash      text not null          -- argon2id, vetted lib
  email_confirmed_at timestamptz
  created_at         timestamptz not null default now()
  unique (project_id, email)               -- true per-tenant identity

auth_email_tokens
  id            uuid pk
  credential_id uuid not null → auth_credentials(id) on delete cascade
  kind          enum('confirm','reset') not null
  token_hash    text not null              -- sha256 of a high-entropy random token; raw token only in the email
  expires_at    timestamptz not null
  consumed_at   timestamptz
  created_at    timestamptz not null default now()
  index (token_hash)
```

Behavior:

- **signUp:** insert credential (argon2id hash; `email_confirmed_at` null) → mint a
  random confirm token, store its hash, email the link via `EmailSender` → return
  `confirmation_required`. If the email already exists, **return the same shape without
  inserting** (anti-enumeration). (If a project later runs in auto-confirm mode we may
  return `confirmed` — default is confirm-required to mirror today.)
- **verifyCredentials:** look up by `(project_id, email)`; argon2id verify
  (constant-time, lib-provided). Return `null` on no-match **or unconfirmed** email.
- **changePassword:** argon2id-verify `current` against the stored hash; on success
  re-hash `next`. (`authUserId` = credential id.)
- **startPasswordReset:** always 200; if the credential exists, mint a `reset` token,
  store its hash, email the link. No-op silently otherwise. Rate-limited.
- **confirmEmail:** hash the presented token, find an unconsumed unexpired matching
  `confirm` row, set `email_confirmed_at` + mark consumed, return the credential id.
- **resendConfirmation:** best-effort re-mint + re-send for an unconfirmed credential.

### 4. `EmailSender` (`lib/auth/email/sender.ts`)

```ts
export interface EmailSender {
  sendConfirmation(to: string, link: string): Promise<void>;
  sendPasswordReset(to: string, link: string): Promise<void>;
}
```

Ships **`ConsoleEmailSender`** (logs the link at `debug`, never the token at `info`) so
native auth is end-to-end testable immediately. Production transport (Resend/SES/Postmark)
is a later impl behind this interface — selected by env, no interface or caller change.
Confirmation/reset link base URLs come from project/deployment config.

### 5. Provider selection — `projects.auth_provider`

New enum column `auth_provider` (`supabase` | `native`), **default `supabase`**:
existing projects, self-host, and dedicated tenants are unaffected. The shared-tier
provisioning path (sub-project C) stamps `native`. Resolved once per request via the
cached project config; a tiny factory maps the value → provider singleton (providers are
stateless aside from the shared `db` + `EmailSender`).

## Security considerations (highest priority — assert negatives in tests)

- **No hand-rolled crypto.** argon2id via a vetted library; sha256 token hashing via
  `node:crypto`. Tokens are high-entropy random, stored **hashed**, single-use, expiring.
- **Anti-enumeration preserved** on sign-up and password-reset (identical responses
  regardless of account existence) — matches today's behavior; tested explicitly.
- **Unconfirmed accounts cannot sign in** (`verifyCredentials` returns null until
  `email_confirmed_at` set).
- **Tenant isolation:** every native lookup is scoped by `project_id`; the
  `unique (project_id, email)` constraint is the identity boundary. Cross-tenant lookup
  is impossible by construction — covered by an integration test.
- **Logging policy (CLAUDE.md):** raw tokens/links/`err` only at `debug`; `info`/`error`
  are message-only. Never log a password, hash, or token.
- **Rate limiting:** native sign-in / reset / resend ride the existing `/auth/*` stricter
  rate-limit cap (`middleware/rate-limit.ts`) — confirm they're under it.
- **Timing:** rely on argon2id's constant-time verify; avoid early-return oracles that
  distinguish "no such email" from "wrong password" beyond the existing generic 401.

## Testing plan

- **Unit (`src/**/*.test.ts`, no DB):** the provider factory (value → provider);
  anti-enumeration response shaping; token hash/verify helpers; `EmailSender` console
  impl redaction.
- **Integration (`test/integration/**`, real PG, by `project_id`):** native sign-up →
  confirm → sign-in → change-password → reset happy path; **negatives** — unconfirmed
  can't sign in, wrong password rejected, expired/consumed/foreign-project token
  rejected, cross-tenant email isolation (same email, two projects, two identities),
  enumeration parity. Supabase provider behavior characterized by the existing suite +
  a wrapper smoke (Supabase calls stubbed in the hermetic env).
- **No regression:** existing auth integration tests pass unchanged with the default
  `supabase` provider.
- **Gate:** `pnpm -r typecheck` + `pnpm test` (+ `pnpm test:integration`) green.

## Migrations

1. Drizzle schema edit (`schema/auth.ts`: `auth_credentials`, `auth_email_tokens`;
   `schema/projects.ts`: `auth_provider` enum column) → `db:generate`.
2. Hand-written custom migration (idempotent) for `citext`/enum creation + the
   `token_hash` index + partial-unique niceties Drizzle can't express, applied via
   `db:migrate:run`.

## Rollout / compatibility

- Default `supabase` ⇒ **no behavior change** for any current deployment on day one.
- Native is exercised first by a test project, then by shared-tier provisioning (C).
- SDK/API contract (paths, envelopes, response shapes) is **unchanged** — only the
  server-internal credential mechanism is swapped.

## Open questions (resolve in plan or follow-ups)

- Confirm-required vs auto-confirm as a per-project native option (default: required).
- Reset/confirm **link base URL** source (project config vs deployment env) — needed
  before a real `EmailSender` ships, not for the interface.
- Whether `profiles.auth_methods` should distinguish `"password"` (native) from Supabase
  password (likely keep `"password"` for both; revisit if the admin UI needs to tell them apart).
```
