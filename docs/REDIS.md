# Redis in Agora

Redis is **optional** and has exactly **two consumers**. Agora boots without it — each feature gates on
`REDIS_URL` and degrades cleanly when it's unset.

| Consumer | Purpose | Keys | Behaviour without Redis |
|---|---|---|---|
| **Suspension index** | O(1) disabled-account enforcement on the hot path | `suspended:profiles` (SET) | Falls back to the authoritative Postgres read |
| **Rate-limit store** | Shared fixed-window limiter across multiple API replicas | `rl:*` | Per-process in-memory limiting |

Both live in the shared kernel (`@agora/core`): `lib/redis.ts` (the lazy client), `lib/suspension-index.ts`
(the SET), `apps/api/src/lib/rate-limit.ts` (the limiter). The client is fail-fast and ready-probe-free —
`maxRetriesPerRequest: 1`, `enableOfflineQueue: false`, `enableReadyCheck: false` — so a least-privilege
ACL user needs no `INFO`.

## When you need it

| Deploy | Redis? | Why |
|---|---|---|
| Single-replica API (Supabase or selfhost) | **No** | In-memory rate limiting; suspensions via the DB read |
| Multi-replica API | `--profile scale` | One shared limiter so the cap holds across replicas |
| **secure-chat** (`--profile secure-chat` / `full`) | **Yes — hard dependency** | The suspension index is its only suspension-enforcement path |

The bundled compose `redis` service rides the `secure-chat`, `scale`, and `full` profiles. Point the
apps at it with `REDIS_URL=redis://redis:6379` (or the ACL form below).

---

## 1. Disabled-account (suspension) enforcement

A suspension is **active** when `startDate <= now < endDate` (a null `endDate` is indefinite). Enforcement
reads this predicate on every authenticated request (`requireAuth`) and on the realtime handshakes. Doing
that as a Postgres lookup per request is wasteful, so when `REDIS_URL` is set the read goes through a Redis
**SET of suspended profile IDs** (`suspended:profiles`) — an O(1) `SISMEMBER`.

```
requireAuth / socket handshake → hasActiveSuspension(profileId)
   REDIS_URL set?  ── yes ──▶ SISMEMBER suspended:profiles   (fail-closed)
                   └─ no  ──▶ Postgres read (authoritative)
```

**Security properties (`lib/suspension-index.ts`):**

- **Fail-closed read.** When the index is enabled and Redis is unreachable, the membership check **throws
  503** — the request is denied, never silently allowed. There is deliberately **no DB fallback** for a
  configured-but-down Redis; that would be a fail-*open* surface.
- **Readiness gate.** Traffic is served only after a successful boot hydrate, so an un-hydrated (empty) set
  can never let a suspended user slip through.
- **Atomic rebuilds.** The set is replaced via a temp key + `RENAME` (`suspended:profiles:rebuild` →
  `suspended:profiles`), so a half-built set is never visible.

**How the set stays correct:**

| Mechanism | Where | What |
|---|---|---|
| Boot hydrate | both apps, before listening | Atomic rebuild from the DB's currently-active suspensions |
| Write-through | `@agora/api` on suspend/lift | Best-effort `SADD`/`SREM` (logged, not thrown — backstopped below) |
| Reconcile cron | `POST /internal/cron/sync-suspensions` (every 5 min) | One atomic rebuild catches new suspensions, lifts, **and** `endDate` expiries with no diffing |

Write-through is best-effort because the boot hydrate + reconcile cron are the backstops, and suspending a
user already revokes their refresh-token families (so access is TTL-bounded regardless).

---

## 2. How secure-chat uses it

`@agora/secure-chat` is a separate process that stores/relays only ciphertext. It still must refuse
suspended users, and it has no API in its request path — so the **Redis suspension index is its sole
enforcement mechanism**, making Redis a **hard dependency**:

- **Boot hydrate or refuse to start.** `index.ts` calls `hydrateSuspensionIndex()` *before* it listens; a
  hydrate failure logs and exits (the orchestrator restarts it; compose `depends_on: redis (healthy)`
  guarantees Redis is up first).
- **Readiness gate on `/health`.** Until the index has hydrated, `/health` returns **503** so a load
  balancer won't route to a not-yet-ready (fail-open-risk) instance.
- **Read-only on the SET** at request time (`SISMEMBER`), plus the boot rebuild. The **write** endpoints
  (suspend/lift) stay in `@agora/api` — secure-chat never mints or revokes tokens.

secure-chat shares the **same** Redis (and Postgres) as the API in v1. See
[`docs/SECURE_CHAT.md`](SECURE_CHAT.md) and [`apps/secure-chat/README.md`](../apps/secure-chat/README.md).

---

## 3. Rate-limit store

When `REDIS_URL` is set, the edge limiter (`/v7/*`, stricter on `/auth/*`) uses Redis instead of per-process
memory so the cap holds across replicas. It's a single atomic fixed-window Lua script under the `rl:` prefix
(`EVAL` → `INCR` + `PEXPIRE` + `PTTL`) keyed on the real client IP. **Fail-open by design:** a Redis error is
logged and the limiter degrades to in-memory (availability over a perfectly-shared counter — the opposite of
the suspension index, which fails *closed*).

---

## 4. ACL configuration (least privilege)

Each consumer touches a tiny, fixed command set on a known key prefix. On a **shared or exposed** Redis,
lock the connecting user down with a Redis 6+ [ACL]. (The bundled compose `redis` runs with no persistence
and the default user — fine for a trusted internal-only network; add an ACL when Redis is shared.)

**Key/command surface:**

| Consumer | Keys | Commands |
|---|---|---|
| Suspension index | `suspended:profiles`, `suspended:profiles:rebuild` | `SISMEMBER` `SADD` `SREM` `DEL` `RENAME` `MULTI` `EXEC` |
| Rate-limit store | `rl:*` | `EVAL` `INCR` `PEXPIRE` `PTTL` |

**secure-chat** user (suspension index only):

```bash
# Redis 6+ — read + rebuild the suspension SET, nothing else:
ACL SETUSER agora-sc on >REPLACE_WITH_STRONG_PASSWORD \
    resetkeys ~suspended:profiles ~suspended:profiles:rebuild \
    resetchannels \
    nocommands +sismember +sadd +srem +del +rename +multi +exec
#   REDIS_URL=redis://agora-sc:REPLACE_WITH_STRONG_PASSWORD@redis:6379
```

**API** user. With one `REDIS_URL`, the API may use both features at once (suspension index always when
`REDIS_URL` is set; the shared limiter under `--profile scale`), so grant the **union**:

```bash
ACL SETUSER agora-api on >REPLACE_WITH_STRONG_PASSWORD \
    resetkeys ~suspended:profiles ~suspended:profiles:rebuild ~rl:* \
    resetchannels \
    nocommands +sismember +sadd +srem +del +rename +multi +exec +eval +incr +pexpire +pttl
#   REDIS_URL=redis://agora-api:REPLACE_WITH_STRONG_PASSWORD@redis:6379
```

> **Rate-limit-only user** (a multi-replica API with **no** secure-chat and suspensions left on the DB read)
> is the narrow subset — `~rl:*` + `+eval +incr +pexpire +pttl`. See [`apps/api/README.md`](../apps/api/README.md) → *Redis ACL*.

Persist the user in `redis.conf` / an `aclfile` (then `ACL SAVE`), e.g.
`user agora-api on >… ~suspended:profiles ~suspended:profiles:rebuild ~rl:* resetchannels -@all +sismember +sadd +srem +del +rename +multi +exec +eval +incr +pexpire +pttl`.

[ACL]: https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/

---

## Operational notes

- **Eviction policy — don't evict the suspension SET.** The suspension SET has **no TTL**, while rate-limit
  keys do. The bundled compose runs `--maxmemory-policy allkeys-lru`, which is fine for a rate-limit-only
  Redis but makes the no-TTL suspension SET eligible for eviction under memory pressure — a **fail-open**
  risk. When the same Redis holds the suspension index, prefer **`volatile-lru`** (evicts only TTL-bearing
  rate-limit keys, never the SET) or give Redis enough headroom that eviction never triggers. The dataset is
  tiny (a set of UUIDs + short-lived counters), so headroom is cheap.
- **Persistence isn't required.** Both structures are rebuilt from Postgres on boot (the suspension index)
  or are ephemeral (rate-limit windows), so `--save ""` is fine. A cold Redis just re-hydrates.
- **TLS / auth in production.** Use `rediss://` + the ACL user above when Redis is reachable off a trusted
  network; never expose the default user.
