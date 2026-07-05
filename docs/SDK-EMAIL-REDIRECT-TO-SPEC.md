# Spec: `emailRedirectTo` — per-front-end native-auth email links

**Owner:** agora-server (contract) → **Implementer:** agora-sdk team
**Status:** server side shipped; SDK side TODO
**Repos:** server `../agora-server` · SDK `../agora-sdk` (`@agora-sdk/*`, the forked Replyke SDK)
**Date:** 2026-07-03

---

## 1. Why

Agora projects on **native auth** (`DEFAULT_AUTH_PROVIDER=native`) send their own transactional email —
confirmation, password-reset, resend — via the server's Postmark transport. The emailed link points at a
**front-end** origin (e.g. `https://agora-oss.org/auth/verify-email?...`). That origin is currently a
single server-wide default (`AUTH_EMAIL_LINK_BASE`).

A deployment can have **more than one front-end** hitting the same API — e.g.
`https://agora-oss.org` (homepage comments) **and** `https://demo.agora-oss.org` (the demo). With one
global base, a user who signs up on the demo gets a link to the homepage (or vice-versa). We want each
user to return to **the site they signed up on**.

**Solution:** the client tells the API which origin its links should use, per request. The server
validates that value against an allowlist and builds the link on it. This is already live server-side;
the SDK now needs to **send the value**.

## 2. Server contract (already shipped — do not re-implement)

Three endpoints accept an **optional** `emailRedirectTo` field in the JSON body:

| Endpoint | Purpose |
|---|---|
| `POST /v7/:projectId/auth/sign-up` | confirmation link |
| `POST /v7/:projectId/auth/request-password-reset` | reset link |
| `POST /v7/:projectId/auth/send-verification-email` | resend confirmation link |

**Field**

- **`emailRedirectTo`** — `string`, optional. The client app's **origin / base URL**
  (e.g. `"https://demo.agora-oss.org"`). The server takes its **origin** (scheme + host + port),
  lowercases it, and builds `"{origin}/auth/verify-email?..."` / `"{origin}/auth/reset-password?..."`.
  Any path/query the client includes is ignored — send the bare origin.

**Server behavior**

1. **Native auth requires the allowlist.** If `AUTH_EMAIL_LINK_ALLOWED_ORIGINS` is **unset**, native-auth
   confirm/reset/resend now **fail closed** — the server returns **`503 auth/email-not-configured`** (there
   is no trusted way to validate a client-supplied origin, so it won't build a link on an unvalidated value
   or a possibly-wrong default). Set the allowlist to enable these flows. (Supabase-backed projects are
   unaffected — they broker their own emails and never hit this gate.)
2. If the allowlist **is set**:
   - `emailRedirectTo` **omitted** → server uses `AUTH_EMAIL_LINK_BASE` (canonical default).
   - `emailRedirectTo` **origin ∈ allowlist** → server uses that origin. ✅
   - `emailRedirectTo` **origin ∉ allowlist** → **`400`** with body
     `{ "error": "...", "code": "auth/email-redirect-not-allowed", "field": "emailRedirectTo" }`.

   The allowlist is the security control: a client-supplied link base is **never** trusted unvalidated
   (an un-gated value is an open-redirect / phishing vector on the reset flow). The look-alike
   `https://demo.agora-oss.org.evil.com` is **not** a match — comparison is exact-origin.

Reference: `docs/MANIFEST.md` (auth section), `packages/contract/src/schemas.ts`
(`signUpSchema`, `emailSchema`).

## 3. What the SDK must do

Send `emailRedirectTo` on the three requests, defaulting to the current web origin, with an override for
platforms that have no `window` (React Native / Expo).

### 3.1 Value resolution (recommended)

Resolve in this order and **omit the field entirely** if none is available (so the server falls back to
its default rather than 400-ing on an empty/garbage value):

1. An explicit **`emailRedirectTo` prop** on `<ReplykeProvider>` (new — see 3.3), if set.
2. `window.location.origin` — when `window` exists (web / react-js).
3. Otherwise **omit** (react-native / expo with no prop configured).

> Send the **origin only** (`window.location.origin` already is exactly that — no path, no trailing
> slash). Do not send `window.location.href`.

### 3.2 Call sites to change (`@agora-sdk/core`)

| File | Request | Change |
|---|---|---|
| `packages/core/src/store/slices/authThunks.ts` | `authApi.signUpWithEmailAndPassword` → `POST /auth/sign-up` | add `emailRedirectTo` to **both** the JSON body (~L92–100) **and** the `FormData` branch (~L58, `formData.append("emailRedirectTo", …)`) when it has an avatar |
| `packages/core/src/hooks/auth/useRequestPasswordReset.ts` | `POST /auth/request-password-reset` | add `emailRedirectTo` to the `{ email }` body |
| `packages/core/src/hooks/auth/useSendVerificationEmail.ts` | `POST /auth/send-verification-email` | add `emailRedirectTo` to the body |

Only append the field when a value resolves (see 3.1) — never send `emailRedirectTo: undefined`/`""`.

### 3.3 Config surface (recommended)

Add an optional prop so RN/Expo apps (and anyone wanting to override the detected origin) can set it:

- `packages/react-js/src/index.tsx` — `ReplykeProvider` props: add `emailRedirectTo?: string`, pass to
  `CoreReplykeProvider`.
- `@agora-sdk/core` `ReplykeProvider` — accept `emailRedirectTo?`, store in the existing runtime config
  (alongside `baseUrl` / `getApiBaseUrl` in `packages/core/src/config/runtime`) so the three call sites
  can read it via a small `getEmailRedirectTo()` helper (mirroring `getApiBaseUrl()`).

Usage after the change:

```tsx
// web — origin auto-detected, nothing to configure:
<ReplykeProvider projectId={PID} baseUrl={API}>…</ReplykeProvider>

// react-native / expo — no window, so set it explicitly:
<ReplykeProvider projectId={PID} baseUrl={API} emailRedirectTo="https://app.agora-oss.org">…</ReplykeProvider>
```

## 4. Backward / forward compatibility

- **Non-breaking.** The field is optional on the server. An **old SDK** that never sends it → server
  uses `AUTH_EMAIL_LINK_BASE` (today's behavior). A **new SDK** talking to an **old server** → the field
  is ignored by validation. No coordinated deploy required.
- The one new failure mode is **`400 auth/email-redirect-not-allowed`**, which only happens when the
  server has an allowlist configured **and** the SDK sends an origin that isn't on it. Surface it as a
  clear, non-retryable error in the auth hooks (don't swallow it as a generic network error) so the
  operator sees "add this origin to `AUTH_EMAIL_LINK_ALLOWED_ORIGINS`."

## 5. Testing

- Extend `packages/core/src/store/slices/authThunks.test.ts`: assert the sign-up POST body includes
  `emailRedirectTo` equal to the resolved origin, and that it is **absent** when no origin resolves.
- Add equivalents for `useRequestPasswordReset.test.ts` and `useSendVerificationEmail.test.ts`.
- A test where `window.location.origin` is stubbed vs. undefined (RN path) → field present vs. omitted.

## 6. Rollout

1. Land the SDK change; bump + republish `@agora-sdk/core` (and `react-js` if the prop is added there).
2. Each front-end upgrades the SDK (web needs no code change — origin is auto-detected; RN/Expo sets the
   prop).
3. **Operator step (server, per deployment):** set
   `AUTH_EMAIL_LINK_ALLOWED_ORIGINS=https://agora-oss.org,https://demo.agora-oss.org` (each front-end's
   exact origin) and keep `AUTH_EMAIL_LINK_BASE` as the canonical fallback. This is already configured on
   the reference deployment.

## 7. Out of scope

- Server-side work — done (contract, validation, allowlist, Postmark transport).
- Supabase-backed projects — `emailRedirectTo` is ignored there; Supabase Auth sends its own emails with
  its own dashboard-configured redirect allowlist. No SDK branching needed; sending the field is harmless.
- The post-verification redirect *within* the front-end (where the verify page sends the user next) is a
  front-end concern, not part of this contract.
