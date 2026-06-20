# IUC restore-blob endpoint — server design

**Date:** 2026-06-20
**Status:** approved design (pre-implementation)
**Owner:** agora-server (`@agora/secure-chat` + `@agora-server/contract`)
**Requested by:** agora-sdk-plus (secure-chat) — see the cross-repo request, 2026-06-20
**Relates to:** the IUC history-restore feature (ENVELOPE variant), specified SDK-side in
`docs/superpowers/specs/2026-06-18-iuc-history-restore-design.md` *(lives in the SDK repo)*

---

## 1 · Problem

IUC ("history restore on a re-provisioned device") lets a reinstalled device **B** recover the
plaintext back-history of a conversation it has re-joined, handed over by a peer device **A** that
still holds it. MLS forward secrecy means B can read *future* messages after re-joining but **nothing**
from before — the old application-message keys were single-use and deleted. The only recovery path is
for A to hand B the plaintext it decrypted-once-and-stored.

- **INLINE variant** — small histories ride MLS application messages directly. No server change; the
  existing message relay already covers it.
- **ENVELOPE variant** — large histories are sealed client-side into one opaque AEAD blob, uploaded to
  the server, with **only the decryption key** sent over MLS (A→B, inside the group). Moving the bulk
  off the MLS channel avoids the pathology of thousands of individually-ratcheted, fanned-out app
  messages.

The ENVELOPE variant needs a server capability we don't have: **a targeted, ephemeral, opaque blob
relay** — A uploads a blob addressed to B; only B can fetch it; it is consumed once and swept. The
server stores **opaque bytes** and learns **no plaintext and no key** — the same blindness it already
has for KeyPackages, Welcomes, and application ciphertext.

This is structurally identical to the blind-Delivery-Service posture already in `secure-chat.ts`
(store opaque `bytea`, enforce membership/ownership, relay) — so it slots in cleanly rather than
introducing a new trust model.

## 2 · Hard requirements (these preserve E2EE — non-negotiable)

1. **Server stays blind.** The blob is `XChaCha20-Poly1305(K, history)` sealed **client-side**. The
   server stores/relays it as opaque bytes and never receives, logs, or can derive `K` or the
   plaintext. `K` travels **only** over MLS and never touches this endpoint or any server field.
2. **Targeted delivery.** A blob is addressed to one recipient device B. Only B (see §6 for how
   "device" maps to our user-scoped auth) may fetch or delete it.
3. **Ephemeral.** Consumed once and removed promptly — a courier drop-box, not durable storage.
4. **Membership-scoped.** Both A (uploader) and B (target) must be **current members of
   `conversationId`** at upload time.
5. **Bounded.** A maximum blob size is enforced; oversize uploads are rejected with a distinct error.

**Metadata the server sees** (and already effectively has, since it relayed the Commit/Welcome that
added B): uploader device, target device, conversationId, blob byte-size, timestamps. The only
genuinely new observable is **blob size + timing**, inherent to any store-and-forward of bulk data and
acceptable.

## 3 · Chosen approach

**Approach A — dedicated table, explicit `DELETE` + TTL backstop, lazy-expiry on read, cron sweep.**

Selected over (B) consume-on-read — which loses resume-safety (a fetch-then-crash forces A to
re-upload) and *still* needs a TTL sweep for never-fetched blobs — and over (C) piggybacking the
existing `secure_handshake_messages` relay, which is broadcast, commit-ordered by a monotonic `seq`
cursor, and capped for handshakes; a one-shot targeted bulk blob with a TTL does not belong in the
commit inbox.

Every piece of Approach A mirrors an existing pattern: lazy expiry copies `secure_key_packages`
(`expiresAt` filtered on read); the cron sweep copies `POST /internal/cron/sync-suspensions`; the
`fromDeviceId` ownership check copies `senderDeviceId` on `POST /conversations/:id/messages`.

## 4 · Configuration (all env-driven, `packages/core/src/lib/env.ts`)

Validated with the existing `z.coerce.number().int().positive().default(...)` pattern (empty string →
default).

| Env var | Default | Meaning |
|---|---|---|
| `MAX_SECURE_RESTORE_BLOB_BYTES` | `16777216` (16 MB) | per-blob (= per-chunk) size cap |
| `SECURE_RESTORE_BLOB_TTL_SECONDS` | `900` (15 min) | TTL backstop; sweep deletes anything B never DELETEs |
| `MAX_SECURE_RESTORE_BLOBS_PER_PAIR` | `16` | max outstanding (unexpired) blobs per (uploader→target) pair |
| `MAX_SECURE_RESTORE_BLOBS_PER_TARGET` | `64` | aggregate outstanding backstop per target device |

**Sizing rationale.** The per-blob cap is **chunk granularity, not a ceiling on total restorable
history** — a large history is N independent single-blob transfers (each its own `blobId` + its own
MLS key message), reassembled client-side. The server is stateless about chunking; it only ever sees N
ordinary single-blob drops. Total in-flight history is therefore bounded by the quota, not the size
cap: at 16 MB × 16 per pair ≈ 256 MB in flight to one peer. A 15-minute TTL reflects that a restore
must complete in a reasonable window; B normally fetches within seconds of receiving the MLS key
message.

## 5 · Schema — new table `secure_restore_blobs`

`packages/core/src/db/schema/secure-chat.ts` (the single source of truth; `secure_*` schema lives in
`@agora/core`).

```
id              uuid  pk default random        -- this IS the blobId
projectId       uuid  notNull → projects (cascade)
conversationId  uuid  notNull → secure_conversations (cascade)
fromDeviceId    uuid  notNull → secure_devices (cascade)   -- uploader A
targetDeviceId  uuid  notNull → secure_devices (cascade)   -- recipient B
blob            bytea notNull                  -- opaque AEAD ciphertext (bytea: ~33% smaller than b64)
expiresAt       timestamptz notNull            -- createdAt + TTL
createdAt       timestamptz default now notNull
```

Indexes:
- `(targetDeviceId, createdAt)` — B's authz lookup + per-target outstanding count.
- `(fromDeviceId, targetDeviceId)` — per-pair outstanding count.
- `(expiresAt)` — cron sweep.

**Deliberately absent:** `K`, `sha256`, `count`, `transferId`. Those are MLS-only; persisting them
would either break blindness (`K`) or add metadata for no server purpose. (`transferId` was offered by
the SDK "purely for correlation/logging" — declined to keep the row minimal; chunking needs no
server-side grouping.)

**Migration flow:** edit `schema/*.ts` → `pnpm db:generate` (table DDL) → **append an idempotent RLS
deny-all** to the generated migration. A brand-new table is *not* covered by the one-time `0017`
enablement guard, so it must ship its own explicit `alter table … enable row level security` (+ force),
mirroring `project_roles` in `0045` and `auth_credentials`. These tables have **no SELECT grant** — they
are server-only relays with no client-direct read path.

## 6 · Authorization — device-level intent on user-scoped auth (security-critical)

The request specifies "only the **device** matching `targetDeviceId` may fetch." Our access tokens are
**user-scoped, not device-scoped** (`sub` = userId; there is no per-device credential in the JWT). The
strongest enforceable predicate is therefore:

> **the caller is the *user who owns* device row `targetDeviceId`** — a `getMyDevice`-style ownership
> check (`secure_devices` row where `id = targetDeviceId AND userId = caller AND revokedAt IS NULL`).

This is equivalent for the threat model: B is the user's own re-provisioned device, and a user's
devices share a trust domain. This is the single deviation from the request's literal contract and is
called out here so it is a conscious, reviewed decision rather than an implicit gap.

**Existence oracle is closed:** every authz failure on GET/DELETE — blob missing, expired, OR caller
not the target's owner — returns **404 with the same code**, never 403. A non-recipient cannot confirm
a blob exists.

## 7 · Routes — `apps/secure-chat/src/routes/secure-chat.ts`

All `requireAuth`. Wire format matches the module: binary crosses as base64, stored `bytea`; errors
throw `Errors.*`.

**Deviation from the request's sketch:** the upload body adds **`fromDeviceId`**. The request omitted
it, but (a) the GET response must return `fromDeviceId`, and (b) user-scoped auth cannot disambiguate
*which* of the caller's devices is A. The SDK already knows its own device id and supplies it — exactly
as `senderDeviceId` works on `POST /conversations/:id/messages`.

### `POST /restore-blobs`
Body: `{ conversationId, fromDeviceId, targetDeviceId, blob }` (validated by `uploadRestoreBlobSchema`).

1. `getMyDevice(c, fromDeviceId)` — caller owns A, in project, not revoked → else **404**
   `secure-chat/device-not-found`.
2. `requireSecureMember(c, conversationId)` — caller is an active member → else **403**
   `secure-chat/not-a-member`.
3. Resolve `targetDeviceId` → its owning `userId` (project-scoped, not revoked). A missing/revoked
   target device, **or** a target whose owning user is not an active member of `conversationId`, both
   return **404** `secure-chat/restore-target-not-member` (single non-distinguishing code — the
   endpoint does not confirm an arbitrary device's existence or conversation membership).
4. `assertSize(blob, env.MAX_SECURE_RESTORE_BLOB_BYTES, "secure-chat/restore-blob-too-large")` →
   **413** distinct code.
5. Quota (both counts over **unexpired** rows):
   - pair A→B count ≥ `MAX_SECURE_RESTORE_BLOBS_PER_PAIR` → **429** `Errors.rateLimited`
     ("restore blob quota exceeded for this recipient").
   - target B aggregate count ≥ `MAX_SECURE_RESTORE_BLOBS_PER_TARGET` → **429**.
6. Insert row, `expiresAt = now() + SECURE_RESTORE_BLOB_TTL_SECONDS`.
7. **Optional realtime (low cost, included):** `emitToSecureDevice(targetDeviceId,
   "secure:restore-blob-available", { conversationId })` — carries **no** `blobId`/key (B already learns
   `blobId` over MLS; this is a latency nicety only).
8. → **201** `{ blobId, expiresAt }`.

`logger.debug({ projectId, conversationId, fromDeviceId, targetDeviceId, blobBytes, expiresAt }, …)` —
message-only on info/error per the logging policy; raw detail on debug.

### `GET /restore-blobs/:blobId` (non-destructive — resume-safe)
Fetch by `id`, project-scoped, **`expiresAt > now()`**. Authz per §6 (caller owns `targetDeviceId`).
Any miss / expired / non-owner → **404** `secure-chat/restore-blob-not-found` (single
non-distinguishing code). → **200** `{ blobId, conversationId, fromDeviceId, blob, createdAt,
expiresAt }`. The GET is non-destructive so B may retry if it crashes between fetch and local persist.

### `DELETE /restore-blobs/:blobId`
Same authz (§6). Delete the row → **204** (no body — follows the request contract; note our other
DELETEs return `{ success: true }`, this one matches the SDK's stated 204). Miss / non-owner → **404**,
same code.

## 8 · Contract — `@agora-server/contract` (minor bump, 0.12.1 → 0.13.0)

Additive surface only:
- zod `uploadRestoreBlobSchema` — `{ conversationId: uuid, fromDeviceId: uuid, targetDeviceId: uuid,
  blob: nonempty base64 string }`. Re-exported from `@agora/core/lib/validation` (so `parseBody` call
  sites are unchanged).
- type `RestoreBlobModel` — the GET response `{ blobId, conversationId, fromDeviceId, blob, createdAt,
  expiresAt }` (camelCase, ISO dates).
- type `UploadRestoreBlobResponse` — `{ blobId, expiresAt }`.
- shaper `shapeSecureRestoreBlob(row)` in `apps/secure-chat/src/lib/secure-chat-shape.ts` — camelCase,
  base64 `blob`, `Date → ISO`.

The SDK type-only re-exports these from its `core/src/contract/` and adds thin REST-client methods
(`uploadRestoreBlob` / `getRestoreBlob` / `deleteRestoreBlob`).

## 9 · TTL sweep — `apps/secure-chat/src/app.ts`

`POST /internal/cron/purge-restore-blobs`, `cronGuard`/`CRON_SECRET`-gated (503 until set, 401 on bad
secret), mirroring `/internal/cron/sync-suspensions`: `delete from secure_restore_blobs where
expires_at <= now()`, return `{ purged: count }`, `logger.info` the count.

- New line in `apps/api/crontab` targeting the secure-chat host (the `cron` container fires the
  secret-gated `/internal/cron/*` endpoints over the internal network).
- Standalone `apps/secure-chat/scripts/purge-restore-blobs.mjs` for manual/standalone runs (mirrors the
  existing `scripts/clean-secure-chat.mjs` and the api's cron scripts).

**Lazy expiry on read makes correctness independent of the sweep** — GET/DELETE already filter
`expiresAt > now()`, so an un-swept expired blob is invisible and undeliverable. The sweep only
reclaims storage.

## 10 · Tests (security negatives are the highest priority — CLAUDE.md)

**Unit** (`*.test.ts`, vitest, no DB):
- `shapeSecureRestoreBlob` — camelCase, base64 round-trip, ISO dates.
- The pure size/quota guard predicates (extract if it keeps them branch-testable).

**Integration** (`test/integration/**`, real Postgres, isolated by `project_id`):
- upload happy path → 201, row present, `expiresAt` ≈ now + TTL.
- non-member uploader → **403**.
- target device's user not a member → **404**.
- oversize blob → **413** (distinct code).
- pair quota exceeded → **429**; target aggregate quota exceeded → **429**.
- GET by non-owner (a different user) → **404** (existence oracle closed).
- GET happy path → blob bytes round-trip exactly; includes `conversationId` + `fromDeviceId`.
- GET an expired blob → **404**.
- DELETE by owner → **204**, then GET → **404** (consumed).
- DELETE by non-owner → **404**, blob still fetchable by the real owner.
- cron purge deletes only `expiresAt <= now()` rows, leaves live ones.

## 11 · Cross-repo notes back to the SDK team

1. **Upload body gains `fromDeviceId`** — required for the GET `fromDeviceId` field and because our auth
   is user- not device-scoped. The SDK supplies its own device id (as it already does for
   `senderDeviceId`).
2. **Too-large is HTTP 413** (code `secure-chat/restore-blob-too-large`), not the sketched 400 — 413 is
   the correct status. The SDK keys its INLINE/chunk fallback on the **error code**, which is
   guaranteed stable.
3. **No `transferId` persisted; chunking is N independent single-blob transfers** (server stateless).
   **Open confirm:** does the SDK *chunk* large histories into multiple ENVELOPE blobs, or fall back to
   INLINE past one blob? This does **not** change the server design — a single-blob stateless endpoint
   is correct either way — it only validates that the quota defaults (§4) are sized for the chunking
   path.
4. **Rate-limit responses are 429** with code `common/rate-limited`. The SDK should surface/back-off on
   429 rather than treating it as fatal.

## 12 · Explicitly NOT in scope

No plaintext storage, no key storage, no MLS awareness, no decryption, no message-history ledger, no
durable/long-term retention. This is a one-shot drop-box, not a backup service (the deprecated
passphrase `key-backup` path was the durable-backup mechanism; this is not that).
