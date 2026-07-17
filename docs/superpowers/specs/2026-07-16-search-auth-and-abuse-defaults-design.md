# Search Auth + Fail-Closed Abuse Defaults — Design

> **Status:** design, pending approval. Scope: `apps/api` + `packages/core`.
> **Origin:** surfaced while reviewing the admin's client-side `VITE_SETTINGS_READ_ONLY` guard. That
> work (a server-side read-only tier) is a **separate, deferred sub-project** — see "Out of scope".

## Problem

Three independent abuse gates on the API are **fail-open**, and the most expensive endpoints in the
product sit behind all three of them unauthenticated.

1. **`/search/*` requires no auth.** `apps/api/src/routes/search.ts` registers four POST routes with
   no `requireAuth`. They inherit `optionalAuth` from the group mount (`routes/index.ts:36`), so a
   token is read when present but never required. The four are **reads** — POST only because the SDK
   sends a JSON body (and `/ask` streams SSE back) — so the HTTP verb never flagged them for review.

2. **`POST /search/ask` is a stranger-operable LLM.** It embeds the query (Voyage), retrieves, builds
   a prompt, and streams a Claude answer over SSE. Every call bills the deployment operator. Today
   any anonymous caller can drive it in a loop.

3. **Every limiter defaults to off.**
   - `packages/core/src/lib/env.ts:53` — `RATE_LIMIT_MAX: z.coerce.number().int().positive().optional()`.
     No default. `middleware/rate-limit.ts` then does `if (!max) return next()`.
   - `lib/embed-throttle.ts` — `resolveStreamConfig` returns `null` when `spikeRate` is unset, and
     `allow()` returns `true` for a null config. Unset `EMBED_THROTTLE_SEARCH_SPIKE_RATE` = no breaker.

   Both fail **open**, which contradicts the "fail closed" rule in `CLAUDE.md` → Engineering
   principles → Security first.

### Why a general rate-limit default is not sufficient

The naive fix — give `RATE_LIMIT_MAX` a default — does not bound the actual loss. A general per-IP
cap sized for normal API browsing (~hundreds of req/min) still permits hundreds of Anthropic calls
per minute. `/search/ask` is **cost-asymmetric**: one request costs ~1000× a feed read. A cost-blind
limit cannot price it. The expensive class needs its own, much tighter budget.

### Why per-IP keying is not sufficient

`rateLimit` is mounted on `/v7/*` at `app.ts:49`. `optionalAuth` runs later, at `routes/index.ts:36`.
The edge limiter therefore **structurally cannot read `c.var.auth`** and can only key on IP. IPs are
shared (carrier NAT, offices, VPNs) and cheap to rotate. Once search requires auth, the caller has a
verified `userId` — a far better budget key, and one an attacker cannot rotate without creating
accounts (which is itself rate-limited by the stricter `/auth/*` class).

## Design

Four changes. Each is independently shippable; the order below is the safe merge order.

### Change 1 — `requireAuth` on the search router

`apps/api/src/routes/search.ts`:

```ts
export const searchRoutes = new Hono<{ Variables: Variables }>()
  .use("*", requireAuth)                    // NEW — must precede spaceRepGate
  .use("*", spaceRepGate("context"))
```

- **Contract impact: none.** The SDK already sends `Authorization: Bearer` on all four search calls
  (confirmed by the repo owner). Signed-in users are unaffected.
- **Behavior change:** anonymous search now returns `401`. This is the intent.
- `c.var.auth` becomes non-null inside every search handler. `isProjectAdmin(c.var.auth)` (already
  imported at `search.ts:17`) no longer needs a null guard.
- Suspended accounts are now blocked from search for free — the suspension check lives inside
  `requireAuth` (`packages/core/src/middleware/auth.ts:55-57`).

### Change 2 — a per-user search limiter

A new limiter mounted **inside** the search router, after `requireAuth`, keyed on
`c.var.auth.userId`. It reuses the existing pluggable store from `lib/rate-limit.ts` (in-process by
default, Redis when `REDIS_URL` is set), so it inherits cross-replica correctness for free.

Two budgets, because the two cost tiers differ by orders of magnitude:

| Class | Routes | Env | Default |
|---|---|---|---|
| `search` | `/search/content`, `/search/spaces`, `/search/users` | `RATE_LIMIT_SEARCH_MAX` | `60` / min |
| `ask` | `/search/ask` | `RATE_LIMIT_ASK_MAX` | `10` / min |

- Key: `search:<projectId>:<userId>` / `ask:<projectId>:<userId>`. Project-scoped so a multi-project
  deployment can't have one project's users exhaust another's budget.
- Exceeding → `429 { error, code: "common/rate-limited" }` + `Retry-After`, matching the existing
  edge limiter's envelope exactly (`middleware/rate-limit.ts`).
- Window reuses `RATE_LIMIT_WINDOW_SECONDS` (default 60).
- **Project-admins are NOT exempt.** An exemption would be a privilege-escalation path to the LLM
  bill, and the read-only demo account (deferred sub-project) is expected to hold admin-ish rights.

### Change 3 — fail-closed defaults

| Env | Today | Proposed default | Rationale |
|---|---|---|---|
| `RATE_LIMIT_MAX` | unset → unlimited | `300` / min per IP | Generous for a browsing SPA; bounds a scripted flood. |
| `RATE_LIMIT_AUTH_MAX` | unset → falls back to `RATE_LIMIT_MAX` | `20` / min per IP | Brute-force target. Already a distinct class. |
| `RATE_LIMIT_SEARCH_MAX` | n/a | `60` / min per user | New (Change 2). |
| `RATE_LIMIT_ASK_MAX` | n/a | `10` / min per user | New (Change 2). Bills Anthropic per call. |
| `EMBED_THROTTLE_SEARCH_SPIKE_RATE` | unset → breaker disabled | `5` req/sec per project | Backstop for distributed abuse that slips both per-IP and per-user budgets. |
| `EMBED_THROTTLE_WRITE_SPIKE_RATE` | unset → breaker disabled | `10` req/sec per project | Same, for the entity-write embed path. |

**Explicit values always win.** "Default" means *unset* now resolves to a number instead of to
`undefined`. An operator who has deliberately set a value keeps it.

**Escape hatch:** `RATE_LIMIT_MAX=0` (and each sibling) explicitly means *unlimited*. Today `0` is
rejected by `.positive()`; the schema changes to `.nonnegative()` with `0` documented as off. Without
this there is no way to opt out of a limit once it has a default, which would strand deployments that
front the API with their own limiter. No middleware change is needed to honor it — `rate-limit.ts`
already reads `if (!max) return next()`, and `0` is falsy.

**Subtlety — `RATE_LIMIT_AUTH_MAX` stops inheriting.** The middleware reads
`env.RATE_LIMIT_AUTH_MAX ?? env.RATE_LIMIT_MAX`. Once `AUTH_MAX` has a default, that `??` fallback
**never fires**. A deployment that today sets only `RATE_LIMIT_MAX=1000` currently gets 1000 on
`/auth/*`; afterwards it gets 20. The direction is safer (auth is the brute-force target and 1000/min
was never a sensible auth budget), but it is a silent change for anyone who set the general cap
expecting auth to track it. Call it out explicitly in the CHANGELOG rather than letting it be
discovered via `429`s on a login page.

> ⚠️ **This is a breaking change.** Any deployment relying on unset-means-unlimited begins receiving
> `429`s at the defaults above. It must land under `### Changed` in `CHANGELOG.md` with the `0`
> escape hatch called out, and it should not ship in a patch release.

### Change 4 — the retained per-project breaker

`embed-throttle` stays as-is structurally; only its default changes (Change 3). Its known tradeoff is
documented rather than fixed: it is keyed **per project**, so on a single-project deployment one
abuser tripping the breaker denies embeds to every user of that project. That is a deliberate
bill-over-availability choice and it is the *third* layer — Changes 1–2 should stop an abuser long
before the breaker trips. Re-keying it per-user is out of scope.

## Layering

Each layer catches a shape the others miss. Defense in depth, not redundancy:

```
anonymous flood        → Change 1 (requireAuth)            → 401
one user, many calls   → Change 2 (per-user budget)        → 429
one IP, many accounts  → Change 3 (per-IP edge default)    → 429
many IPs, many accounts→ Change 4 (per-project breaker)    → 429, bill capped
```

## Testing

Per `CLAUDE.md` → "Test what deserves testing". Security-relevant logic ⇒ negative cases are the
priority.

**Unit** (`src/**/*.test.ts`, no DB):
- `lib/rate-limit.test.ts` (extend) — the new `search`/`ask` classes: budget exhaustion, window
  rollover, `0` = unlimited, per-user and per-project key isolation.
- `lib/env.test.ts` (extend, or add) — defaults resolve when unset; explicit values win; `0` parses
  and means unlimited; a negative value is rejected.
- `lib/embed-throttle.test.ts` (extend) — default config resolves when `SPIKE_RATE` is unset.

**Integration** (`test/integration/**`, real Postgres):
- `search-auth.integration.test.ts` — **the negative case is the point**: all four search routes
  return `401` with no token, and `200` with a valid one. Assert per-route, not once.
- A suspended user's token gets `403 auth/suspended` on search (free via `requireAuth`).
- Per-user budget: N+1 calls from one token → `429`; a second token is unaffected (proves the key is
  the user, not the IP — both tokens share an IP in-test).

The integration env forces `VOYAGE_API_KEY`/`ANTHROPIC_API_KEY` empty, so `/content` and `/ask`
return `400 search/embeddings-disabled` before doing outbound I/O. Assert auth **precedes** that
check — a `400` where a `401` belongs is an information leak about configuration to an anonymous
caller. Order: `requireAuth` (router mount) → `embeddingsEnabled()` (handler body). This is already
correct once Change 1 lands, because the router-level `.use()` runs before any handler.

## Doc changes required

To land **with** the implementation, not before it (see "Sequencing").

**`docs/MANIFEST.md` §search** — replace the section preamble:

```diff
-All search endpoints are **POST** with a JSON body `{ query, limit?, ... }` and return a **bare
-array** of `{ similarity, record }` results (NOT a `{ data, pagination }` envelope) — confirmed
-against the SDK's `useSearchContent`/`useAskContent`/`useSearchSpaces`/`useSearchUsers`.
+All search endpoints **require an authenticated JWT** (`requireAuth`) — the SDK already sends
+`Authorization: Bearer` on all four. An anonymous caller gets `401`; a suspended one `403
+auth/suspended`. They are **POST** with a JSON body `{ query, limit?, ... }` and return a **bare
+array** of `{ similarity, record }` results (NOT a `{ data, pagination }` envelope) — confirmed
+against the SDK's `useSearchContent`/`useAskContent`/`useSearchSpaces`/`useSearchUsers`.
+Per-user rate budgets apply on top of the per-IP edge limit: `RATE_LIMIT_SEARCH_MAX` (default 60/min)
+for `/content`, `/spaces`, `/users`; `RATE_LIMIT_ASK_MAX` (default 10/min) for `/ask`, which bills an
+LLM per call. Exceeding either → `429 common/rate-limited` + `Retry-After`.
```

Each of the four rows gains an `(auth; …)` marker, matching the convention already used by
`/oauth/link`, `/match/users`, and `/push-notifications/devices`.

**`docs/MANIFEST.md` §1 (Global contract)** — no change. The `429` status is already listed.

**`docs/MODELS.md`** — **no change required.** Auth does not alter any response shape, and MODELS.md
documents no search result models. (`ContentSearchResult`/`SpaceSearchResult`/`UserSearchResult` are
referenced by MANIFEST §search but defined nowhere in MODELS.md — a pre-existing gap, logged below.)

**`CHANGELOG.md`** — `### Changed`: search now requires auth (breaking for anonymous callers);
rate limiting and the embed breaker now default to on (breaking for deployments relying on
unset-means-unlimited); `0` documented as the explicit opt-out. `### Added`: `RATE_LIMIT_SEARCH_MAX`,
`RATE_LIMIT_ASK_MAX`.

**Propagation.** New env vars ⇒ per `docs/PROPAGATION.yaml`, the three `.env.*.example` templates and
three compose files mirror them. Run `pnpm check:propagation --diff root` (or `/propagate`) before
finishing the branch; do not hand-maintain the mirror list.

## Sequencing

Changes 1–3 are one branch. Merge order within it: Change 1 (auth) → Change 2 (limiter) → Change 3
(defaults + env + docs + CHANGELOG). Change 3 last so the breaking-change entry lands with the
values it describes.

**Docs ship with code, not ahead of it.** `516dcca "plans & specs"` updated MANIFEST §spaces to claim
`GET /spaces` / `POST /search/spaces` / `GET /spaces/:id/children` "now enforce `visibility`" while
`lib/space-visibility.ts` does not exist and `POST /search/spaces` filters only on
`projectId + deletedAt + ILIKE`. That drift is the reason this spec defers its own MANIFEST edit into
the implementation branch.

## Collision: the in-flight space-visibility plan

`docs/superpowers/plans/2026-07-09-space-visibility.md` (committed, **not implemented**) also modifies
`POST /search/spaces` — it adds `discoverableSpacesSql` to that handler's WHERE. Both projects touch
the same handler. They do not conflict semantically (auth gate vs. row filter) but **will** conflict
textually. Whichever lands second rebases. Recommend landing this spec first: it is smaller, and the
space-visibility plan's `discoverableSpacesSql` depends on `isProjectAdmin(c.var.auth)`, which is
cleaner once `requireAuth` guarantees `auth` is non-null on that route.

## Out of scope

- **Server-side read-only / demo tier.** The originating question. `VITE_SETTINGS_READ_ONLY`
  (`apps/admin/src/config.ts:30`) is a build-time UI constant covering only the Settings page; the
  server enforces nothing. Its own spec.
- **Read-side exposure on a published-creds deployment.** A demo operator token can `GET` the reports
  queue (carrying complainant identity), user PII, and `/admin/config`. Freezing writes does not
  address this. Its own spec.
- **Re-keying `embed-throttle` per user.** See Change 4.
- **Pre-existing doc drift**, logged, not fixed here:
  - MANIFEST §spaces claims visibility enforcement that does not exist (`516dcca`).
  - MODELS.md:80-84 claims the chat mute-suppression helper is unreachable; `5b8e257` wired it.
  - MODELS.md documents no search result models.
