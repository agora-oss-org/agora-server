# Auth Wall — Private by Default — Design

> **Status:** approved in design review (2026-07-17). Scope: `apps/api` + `packages/core` + docs.
> **Supersedes:** Change 1 of `2026-07-16-search-auth-and-abuse-defaults-design.md` (search auth).
> That spec's rate-limit material moves to a sibling **abuse-deterrence** spec (see "Follow-up specs").

## Problem

Agora inherited Replyke's public-read posture: **reads are anonymous, writes are authed** — ~45
anonymous endpoints across entities, comments, users, spaces, events, search, and misc, plus RLS
migration `0008`'s anon-read policies. That posture serves Replyke's product (embeddable widgets on
public webpages, where a logged-out visitor reading is the primary use case) and was adopted
deliberately at project creation, when the goal was 1:1 API mimicry.

Agora's mission is the opposite: **private, secured community infrastructure**. Public-read-by-default
is an architecture-level inversion of that mission, not a bug in any one route.

## Decision

**Every request requires an authenticated account**, except the small pre-sign-in surface needed to
obtain one. No public mode. No per-project or per-space public option. No config switch.

**Privacy model: accountability, not gatekeeping.** Sign-ups stay open self-service. The wall's value
is that every reader is an *identified, suspendable, per-user-rate-limitable account* — not that
accounts are hard to get. Mass extraction by a registered account is deterred by per-user rate
budgets and a tarpit (the sibling abuse-deterrence spec), not by closing registration. Invite-only /
approval-required registration modes are a possible future spec.

## Design

### The wall

One new middleware, **`authWall`**, in `packages/core/src/middleware/auth.ts` beside
`optionalAuth`/`requireAuth`. It replaces `optionalAuth` in the project-group mount —
`apps/api/src/routes/index.ts:36` becomes:

```ts
project.use("*", resolveProject, authWall);
```

Semantics, in order:

1. Verify the Bearer token exactly as today (invalid/absent → `auth = null`).
2. Derive the project-relative path: segment 3 onward of `c.req.path`
   (`/v7/<pid>/auth/sign-in` → `/auth/sign-in`).
3. If it matches `AUTH_WALL_ALLOWLIST` → proceed with auth optional (today's `optionalAuth`
   behavior, including no suspension check — matching today's anonymous-flow semantics).
4. Otherwise → exactly `requireAuth` semantics: `401` for anonymous; `403 auth/suspended` for a
   suspended account (operator/project-owner bypass, mirroring `requireAuth`).

`AUTH_WALL_ALLOWLIST` is an **exported constant** (exact paths + one `/auth/` prefix), so the entire
anonymous surface of the API is one greppable, unit-tested artifact. Every future route is authed by
default — **fail closed**. Existing per-route `requireAuth` calls stay untouched (harmless
double-verification; they keep protecting anything mounted outside the wall).

### The allowlist (final; every member verified)

| Entry | Why it must stay anonymous |
|---|---|
| `/auth/*` (prefix) | The door itself — sign-up/sign-in/refresh/reset/verify. Its authed members (`change-password`, account deletion) keep their inner `requireAuth`. |
| `/oauth/authorize` | OAuth sign-in starts pre-session. |
| `/oauth/callback` | Browser redirect — physically cannot carry a Bearer header. |
| `/projects/lean` | SDK `ReplykeProvider` bootstrap: `useProjectData` uses the **plain** axios instance (never attaches a token) and fires on provider mount. Gating this breaks every client at startup, signed-in included. |
| `/push-notifications/vapid-public-key` | Documented pre-sign-in fetch; already rate-limited. |
| `/crypto/sign-testing-jwt/v2` | Dev-only external-auth testing stub; signs with a client-supplied key, touches no server secret. |

### Coverage of the other mounts (verified 2026-07-17, no changes needed)

- **Connections** (root-mounted at `/v7`, outside the project group): 12/12 routes `requireAuth`.
- **Secure-chat** (`@agora/secure-chat`, own process): 21/21 routes `requireAuth`.
- **Socket.io** (both processes): handshake rejects unauthenticated connections and enforces
  suspensions (`realtime/socket.ts:126-146`).
- **`/internal/*`** (cron, moderation write-back): outside `/v7/:projectId`, secret-gated, unchanged.

The wall closes the only open flank — REST reads under the project group.

### Free win: config stops leaking to strangers

Anonymous callers currently reach handler-level config errors (e.g. `400 search/embeddings-disabled`
reveals whether `VOYAGE_API_KEY` is configured). Behind the wall the `401` fires first.

### RLS alignment (defense-in-depth)

The `0008` anon-read policies exist to let clients read public content directly with the anon key — a
path with no remaining legitimate caller. A new hand-written, idempotent migration (next journal
slot; mind the journal-timestamp watermark — new `when` must exceed the journal max):

- `DROP POLICY IF EXISTS` every `*_public_read` policy from `0008`.
- `REVOKE SELECT` on those tables from `anon`.
- **Keep** the `authenticated` self-access policies — consistent with the new posture.

The `0017` deny-all backstop then covers everything else. The DB layer finally states the same policy
as the API layer.

### Contract & docs

- **MANIFEST §1** gains a global posture statement — *every endpoint requires `Authorization:
  Bearer <accessToken>` except the allowlist table* (reproduced there) — superseding scattered
  per-route auth markers rather than editing ~45 rows.
- **Spaces docs** (MANIFEST §spaces / MODELS Space): one line — `readingPermission: "anyone"` now
  means *any authenticated user*, not anyone on the internet.
- **MODELS.md**: no shape changes (auth changes no response body).
- **SECURITY.md**: add the wall to the posture section (strict improvement, no regressions).
- **CHANGELOG**: `### Changed`, explicitly **breaking**; ships as a **major version**. Any
  deployment with anonymous integrations (public widget embeds) breaks by design.
- No new env vars → no template/compose propagation. Run `pnpm check:propagation --diff <ref>`
  before finishing the branch to confirm doc obligations.

### SDK & demo blast radius

- **Signed-in users: zero impact.** Every SDK hook already sends the token (`useAxiosPrivate`
  attaches it unconditionally; `useAskContent` conditionally).
- **Signed-out users:** the axios hooks send the literal `Bearer undefined` → server 401s → the
  SDK's refresh interceptor fires once and **early-returns without a network call** (no refresh
  token — `authThunks.ts:410`) → hook surfaces an error state. No retry storm (verified).
- Host apps are expected to gate UI behind sign-in — which is what private infrastructure means.
- **Demo harness:** pre-sign-in tab states show errors until sign-in; main flows authenticate with
  the seeded user and are unaffected. **Admin app:** operator-gated, signs in, unaffected.

## Testing

Per CLAUDE.md → "Test what deserves testing"; security-relevant ⇒ negative cases are the priority.

**Unit** (`src/**/*.test.ts` / core, no DB):
- Pin `AUTH_WALL_ALLOWLIST`'s **exact contents** (a membership change must fail a test).
- Wall behavior matrix: allowlisted+anonymous passes with `auth = null`; non-allowlisted+anonymous
  → 401; valid token → `auth` set; suspended token → 403 on non-allowlisted, passes allowlisted;
  path-derivation edge cases (nested paths, trailing content, non-allowlisted `/authx` not matching
  the `/auth/` prefix).

**Integration** (`test/integration/**`, real Postgres):
- Walk **one representative read per router**: `401` anonymous, `200` authed. Assert per-route.
- Allowlist routes reachable anonymously (sign-in flow works end-to-end with no token).
- A suspended user's token → `403 auth/suspended` on a read.

**The honest cost — existing-suite churn.** Every integration test that exercises a read
anonymously starts getting 401s and needs a minted token (helpers exist). This inventory-and-sweep
is likely the bulk of implementation labor and is a **first-class task in the plan**, not cleanup.
Also inventory: `scripts/chat-e2e.mjs`, seed scripts (already sign in), and the perf harness
(`apps/api/perf/`) for anonymous reads.

## Sequencing & in-flight work

- **This spec supersedes Change 1** of the 2026-07-16 search spec. Its remainder (per-user budgets
  on `/search/content` + `/ask`, fail-closed limiter defaults, plus two review findings: the
  integration-suite rate-limit blowup and the `clientIp` "unknown"-bucket footgun) moves to the
  sibling abuse-deterrence spec.
- **Space-visibility plan** (committed, unimplemented): unaffected semantically — its filters govern
  *member-vs-member* discoverability, still needed behind the wall. Lands on top.
- Merge order: **wall first**, then abuse deterrence (the tarpit keys on the identity the wall
  guarantees).

## Follow-up specs (queued, not here)

1. **Per-user abuse deterrence** — Redis token-bucket **tarpit** for cheap reads (delay, not 429:
   per-user bucket sized for ~5 min of generous use; when empty, requests wait for tokens; **parking
   caps** — ≤2 delayed requests per user, global ceiling degrading to instant 429 — so the tarpit
   can't become a held-connection DoS amplifier; delay *before* any DB work), **hard refusal** caps
   on `/search/content` + `/search/ask` (a delayed LLM call still bills), fail-closed edge-limit
   defaults with the integration-env pins and XFF startup warning.
2. **Registration modes** — open | invite-only | approval-required, per project.
3. **Signed media URLs** — after this change, uploaded media (public bucket, unguessable UUIDs —
   accepted per SECURITY.md) is the *only* anonymous-readable artifact class left.

## Out of scope

- Per-space anonymous "public windows" — dead by decision; there is no public mode.
- The tarpit and all rate budgets (follow-up spec 1).
- Storage media URL signing (follow-up spec 3).
- Replyke public-widget compatibility — knowingly broken; Agora is not that product.
