# DB Seam Completion — Design Spec (hosting enablement, single-tenant repo)

> **Status:** Drafted 2026-07-06, replacing the Phase 1/2 sections of the original
> per-tenant-db design (which moved to
> `../agora-hosting/docs/superpowers/specs/2026-07-06-per-tenant-db-runtime-routing-design.md`).
> **Scope rule (governing, Jenova 2026-07-06):** agora-server is **single-tenant, always**.
> Nothing multi-tenant/hosting-specific is built here — no tenant directory, no directory
> mode, no `forEachTenant`, no tenant CLI. This spec covers only the **generic, invisible**
> remainder: completing the connection seam so an external deployment can inject a
> per-project handle, and hardening what Phase 0 merged. A self-hoster sees zero new
> config and zero behavior change.

## 1. What Phase 0 already shipped (merged to `root` 2026-07-06)

- `@agora/core/db` surface: `getDb()` (AsyncLocalStorage, falls back to the shared
  `DATABASE_URL` singleton), `runWithDb()`, `type Db`, `getDbForDsn()` + `endAllPools()`
  (DSN-keyed pool registry — dormant), `schema`. Legacy `db` export removed (typecheck is
  the ban).
- `resolveProject` wraps every `/v7/:projectId/*` request in `runWithDb(getDb(), next)`.

Because `getDb()` reads the innermost ALS scope, an **outer** scope established before
`resolveProject` already flows through it — the seam composes. What's missing is a supported
way for a deployment to establish that outer scope everywhere a projectId is known, not just
on path-addressed requests.

## 2. The one new primitive: a pluggable per-project resolver

`packages/core/src/db/resolver.ts`:

```ts
export type DbResolver = (projectId: string) => Promise<Db>;
let resolver: DbResolver | null = null;

/** Register once at boot, before serving. Second call throws (no hot-swap). */
export function setDbResolver(fn: DbResolver): void;

/** The seam's single question: "which DB serves this project?"
 *  Default (no resolver registered): the shared DATABASE_URL handle — today's behavior. */
export function resolveDbFor(projectId: string): Promise<Db>;
```

- **Generic dependency injection, not a feature.** No env var, no Redis, no config surface.
  Unregistered (every self-host, every test, every current deployment) it returns the shared
  handle — byte-for-byte today's behavior.
- **Fail closed by propagation:** whatever the registered resolver throws (404/503 `ApiError`s
  included) propagates to the caller unchanged. `resolveDbFor` itself never catches, never
  falls back. There is no "resolver failed → use shared" branch — that would be the silent
  cross-tenant fallback the whole design exists to prevent.
- Exported from `@agora/core/db` alongside the Phase 0 surface.

## 3. Wiring at the projectId-known chokepoints

Each site changes from "assume shared" to "ask the resolver" — mechanically identical when no
resolver is registered:

| Site | Today | Change |
|---|---|---|
| `middleware/project.ts` `resolveProject` | `runWithDb(getDb(), next)` | Resolve **before** the existence check: `const db = await resolveDbFor(projectId)`, run the `projects`-row check against it, then `runWithDb(db, next)`. (With a resolver, the row check correctly reads the resolved DB — each dedicated DB carries its own `projects` row.) The boolean existence cache stays keyed by projectId. |
| `realtime/socket.ts` connection auth | `getDb()` (shared) | Wrap the handshake's DB touches and the per-connection handler scope in `runWithDb(await resolveDbFor(projectId), …)` — projectId is already resolved from the handshake. |
| `routes/connections.ts` (root-mounted, no `:projectId`) | `getDb()` (shared) | **Token-first rule:** take projectId from the verified JWT (tokens are minted per-project), wrap each handler body in `runWithDb(await resolveDbFor(projectId), …)` (~6 handlers). |
| `/internal/moderation/apply` | `getDb()` (shared) | Explicit `resolveDbFor(body.projectId)` after secret verification + zod parse. |
| `lib/metrics.ts` `flushMetrics` | one shared write | Buckets are keyed `projectId\|month`: group by `await resolveDbFor(projectId)` handle identity and flush each group to its handle. Single-tenant: one group, identical write. |
| `lib/embeddings.ts` drain | shared queue read | The periodic drain wraps per-project batches in `runWithDb(await resolveDbFor(projectId), …)` where projectId is on the pending row. Single-tenant: identity. |
| Crons / scripts / boot singletons | `getDb()` (shared) | **Unchanged.** They are DB-scoped by `DATABASE_URL`, which is exactly the single-tenant contract; the hosting repo drives them per-tenant by invoking the standalone scripts with a tenant DSN. No `forEachTenant` here — ever. |

## 4. Registry hardening (deferred checklist from the Phase 0 final review)

- `MAX_POOLS` moves into the validated env schema (`lib/env.ts` optional-int pattern) instead
  of the lazy `process.env` read; document it as generic pool tuning (default 50).
- Document + unit-test `evictLru` semantics: single eviction per call; the map may grow past
  the cap when all entries are recently used (deliberate — never evict live pools).
- Unit-test the `client.end()` rejection path (eviction survives a failed drain, logs on
  `debug`).
- Export the resolved cap (or a `getRegistryStats()`) so the NaN-fallback case becomes
  directly assertable.

## 5. Contract stability for the external consumer

The seam surface — `getDb`, `runWithDb`, `Db`, `getDbForDsn`, `endAllPools`, `setDbResolver`,
`resolveDbFor` — is what `../agora-hosting` builds against. Enforcement here is lightweight
and non-commercial:

- JSDoc on each export stating the semantics above (especially: resolver errors propagate,
  no fallback; `prepare: false` always; don't hoist `getDb()` to module scope).
- These exports don't get renamed/removed casually — breaking them is a breaking change for
  any embedder and gets a `CHANGELOG.md` entry.
- The hosting-side contract document (entry schema, key management, channel names) lives in
  the hosting repo, not here.

## 6. Testing (all in this repo, all single-tenant-shaped)

Unit (vitest, no real DB — the Phase 0 test style):

1. `resolveDbFor` default returns the shared handle; after `setDbResolver`, returns the
   resolver's handle; second `setDbResolver` throws.
2. Resolver rejection propagates unchanged (an `ApiError` 503 stays a 503) — the negative
   no-fallback case.
3. `resolveProject` runs the existence check against the resolved handle and wraps `next()`
   in it (fake resolver returning a stub handle; assert the handler's `getDb()` === stub).
4. Chokepoint wiring for connections/moderation-apply/metrics-flush: with a fake resolver
   mapping two projectIds to two stub handles, each write lands on its own handle.
5. Registry hardening cases from §4.

Integration: the existing suite runs unchanged with no resolver registered — it remains the
proof that all of this is invisible. **No two-DB fixture here** (scope rule); the multi-DB
harness lives in the hosting repo.

## 7. Explicit non-goals (pointers, so nobody rebuilds them here)

Redis tenant directory, directory/env mode switching, `forEachTenant`, tenant
provision/migrate/doctor/decommission CLI, pgbouncer topology, per-tenant scorer deployment,
BYO-Supabase preflight → all specced in
`../agora-hosting/docs/superpowers/specs/2026-07-06-per-tenant-db-runtime-routing-design.md`.
Per-tenant GoTrue endpoints / storage backends / VAPID keys are named follow-up seams of the
same shape as §2, built only when the hosting repo needs them — and then also as generic
resolvers, never as tenant features here.

## 8. Propagation obligations

Small: `MAX_POOLS` entering the env schema fans out per `docs/PROPAGATION.yaml` (the three
`.env.*.example` templates as a commented tuning knob, `CLAUDE.md` env list, `CHANGELOG.md`).
No new required config, no compose changes, no SECURITY.md regression (the no-fallback
invariant is worth a line under the trust-boundary section when §2 ships).
