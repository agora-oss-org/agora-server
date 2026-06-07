# Secure Chat — End-to-End-Encrypted Messaging (MLS / RFC 9420)

> **Status:** Phase 1 (server delivery service) is implemented, tested, and shipped in `v0.9.0`.
> Phase 2 (web client crypto) and Phase 3 (native + full multi-device) are tracked in
> [`CHAT_TODO.md`](../CHAT_TODO.md).

Agora's **secure chat** is a genuinely end-to-end-encrypted messaging surface where **the server can
never read message content**. It is a *separate path* from the Replyke-compatible plaintext chat
([`apps/api/src/routes/chat.ts`](../apps/api/src/routes/chat.ts)) — that surface is untouched, so the
1:1 SDK contract never drifts. This document is the full technical reference: rationale, threat model,
architecture, schema, wire contract, the crypto seam, the REST + realtime API, key-lifecycle flows,
testing, and the open design questions.

---

## 1. Why

Most community backends — Replyke included — store direct messages as **readable plaintext** in the
database. That makes the operator a custodian of everyone's private conversations, and it makes the
database a single point of catastrophic failure:

- one **database leak / backup exfiltration** exposes every private message ever sent;
- one **subpoena or legal demand** can compel the operator to hand them over;
- one **over-broad admin** (or a compromised admin credential) can read anything;
- one **"smart" feature** — sentiment analysis, an AI assistant, ad targeting — quietly normalizes
  reading private messages.

For a project whose entire pitch is *own your community, no data leaving your project*, storing readable
private messages is the wrong default. Secure chat removes the operator from the trust equation
entirely: **content is encrypted on the sender's device and only ever decrypted on recipients'
devices.** The server relays sealed envelopes it cannot open.

The deliberate trade: features that require *reading* content — LLM moderation, semantic search,
embeddings, server-side mentions resolution — **do not apply to secure chat**. That is the point, not a
limitation. Communities that want those conveniences use the plaintext chat; communities (or
conversations) that want privacy use secure chat.

---

## 2. Threat model & guarantees

Secure chat uses **MLS (Messaging Layer Security, [RFC 9420](https://www.rfc-editor.org/rfc/rfc9420))**
— the IETF standard for group end-to-end encryption. MLS was chosen over alternatives because Agora
needs **1:1 *and* dynamic groups *and* large space-wide channels**: the Double Ratchet / OTRv4 are
1:1-only, and Signal's Sender Keys rekey `O(n)` on every membership change. MLS gives `O(log n)` group
operations with **forward secrecy** (compromising a key doesn't expose past messages) and
**post-compromise security** (the group heals after a compromised member is removed/rekeyed).

### What is protected

- **Message content** — encrypted client-side; the server stores only ciphertext (MLS *PrivateMessage*).
- **Group secrets** — never leave clients; conveyed between members only inside encrypted Welcomes.
- **Key backups** — encrypted under a user passphrase the server never receives.

### What the server (and a DB attacker) can still see — accepted metadata

This is the **Signal-server model**: the relay learns *envelope* metadata, not content.

- **Social graph** — which users share a conversation, and conversation membership over time.
- **Timing & volume** — when messages/handshakes are sent, and their **ciphertext size** (mitigatable
  later with client-side padding — see [§13](#13-open-decisions--risks)).
- **Device counts** — how many devices a user has registered.
- **Optional conversation `name`** — a single deliberate plaintext concession (see [§6](#6-data-model)).

### What the server is *trusted* and *not trusted* for

- **Trusted for nothing about content.** It holds no keys and cannot forge, read, or alter plaintext.
- **Untrusted for availability/ordering.** A malicious/buggy server could drop, reorder, or replay
  ciphertext. MLS application messages carry sender-side generation counters, so a correct client
  **detects** replays/gaps; the server cannot fabricate valid ciphertext. Availability is not a
  cryptographic guarantee.

---

## 3. Architecture — the blind Delivery Service

In MLS terms the Agora server is purely a **Delivery Service (DS)**: it stores and relays MLS objects,
linearizes group state changes, and enforces *authorization* (who may relay through which conversation)
— but it runs **no MLS cryptography** and depends on **no crypto library**.

```
 Client A (holds MLS group state + keys)          Client B (holds MLS group state + keys)
        │  encrypt/decrypt, create/commit groups          ▲
        │  (all crypto here)                               │
        ▼                                                  │
   base64 over HTTPS  ──▶  @agora/api  /v7/:projectId/secure-chat/*  ──▶  (socket.io /secure)
                              │   stores/relays OPAQUE bytea blobs
                              │   enforces membership + epoch ordering
                              ▼
                       Supabase Postgres   secure_* tables (ciphertext only, RLS deny-all)
```

Because the DS is crypto-agnostic, the **entire server side is buildable and testable without choosing
an MLS library.** A deterministic mock (`@agora/secure-chat-core` `MockSecureChatCrypto`) stands in for
real crypto in the integration suite, which asserts the stored bytes never contain the plaintext.

**Key principle:** any future change must preserve "the server cannot read content." No endpoint
accepts or returns plaintext; no column stores it.

---

## 4. MLS concepts (the parts the DS touches)

You don't need to implement MLS to read this doc, but these terms recur:

| Term | What it is | Where it lives in Agora |
|---|---|---|
| **Leaf** | One device's slot in a group's ratchet tree. **A device = a leaf.** | `secure_devices` row |
| **KeyPackage** | A one-time public bundle others consume to **add** a device to a group. | `secure_key_packages` |
| **Group / `group_id`** | The MLS group; identified by an opaque id. | `secure_conversations.mls_group_id` |
| **Epoch** | A `u64` counter; **every group change advances it.** Linearizes history. | `secure_conversations.current_epoch` |
| **Commit** | A message that *enacts* group changes (add/remove); **broadcast** to the group. | `secure_handshake_messages` (`kind='commit'`) |
| **Welcome** | Bootstraps a **newly added** device into the group; **targeted** to that one device. | `secure_handshake_messages` (`kind='welcome'`, `target_device_id`) |
| **Proposal** | A proposed change later enacted by a Commit (reserved; not used by v1 flows). | `secure_handshake_messages` (`kind='proposal'`) |
| **Application message** | An encrypted chat message (MLS *PrivateMessage*). | `secure_messages.ciphertext` |

All MLS bytes cross the wire as **base64** and are stored as Postgres **`bytea`**. The server treats
every one of them as an opaque blob.

---

## 5. Where the code lives

| Concern | File |
|---|---|
| REST delivery service | [`apps/api/src/routes/secure-chat.ts`](../apps/api/src/routes/secure-chat.ts) |
| Realtime `/secure` namespace | [`apps/api/src/realtime/secure-socket.ts`](../apps/api/src/realtime/secure-socket.ts) |
| DB schema (7 tables) | [`apps/api/src/db/schema/secure-chat.ts`](../apps/api/src/db/schema/secure-chat.ts) |
| Row → API shapers (bytea→base64) | [`apps/api/src/lib/secure-chat-shape.ts`](../apps/api/src/lib/secure-chat-shape.ts) |
| Migrations | `apps/api/drizzle/0031_*.sql` (tables) + `0032_secure_chat_rls_triggers.sql` (RLS + trigger) |
| Wire contract (zod + types) | [`packages/contract/src/secure-chat.ts`](../packages/contract/src/secure-chat.ts) |
| Crypto seam (interface + mock) | `packages/secure-chat-core/src/{interface,mock-crypto}.ts` |
| Integration tests | `apps/api/test/integration/secure-chat-*.test.ts` |

---

## 6. Data model

Seven `bytea`-backed tables in [`db/schema/secure-chat.ts`](../apps/api/src/db/schema/secure-chat.ts).
Binary columns use a Drizzle `customType` mapping `Buffer ↔ bytea` (≈33% smaller at rest than
base64-text; commits/welcomes for big groups get large). Enums live in
[`_shared.ts`](../apps/api/src/db/schema/_shared.ts): `secure_conversation_type` (`dm|group|channel`),
`secure_member_role` (`admin|member`), `secure_handshake_kind` (`welcome|commit|proposal`).

| Table | Purpose | Notable columns |
|---|---|---|
| `secure_devices` | A device = an MLS leaf. **Multi-device-ready** (no unique on `user_id` alone). | `device_id` (client string), `signature_public_key`, `credential`, `ciphersuite`, `revoked_at`; `unique(user_id, device_id)` |
| `secure_key_packages` | One-time KeyPackages, **consumed on claim**. | `key_package_ref` (opaque dedupe ref), `key_package`, `consumed_at`, `consumed_by_user_id`, `expires_at`; `unique(device_id, key_package_ref)`; **partial index** `where consumed_at is null` |
| `secure_conversations` | The MLS group. | `type`, `mls_group_id`, `space_id` (channels only), `current_epoch` (`bigint`), `name` (optional plaintext), `created_by_id`, `last_message_at`; `unique(project_id, mls_group_id)`; **check** `space_id present ⇔ type='channel'` |
| `secure_conversation_members` | **User-level authorization** metadata (not the MLS roster). | `role`, `is_active`, `joined_at_epoch`, `last_read_at`, `left_at`; `unique(conversation_id, user_id)` |
| `secure_messages` | Application ciphertext. **No** content/edited/mentions/moderation columns. | `sender_user_id`, `sender_device_id`, `epoch`, `ciphertext`, `content_type`; keyset index `(conversation_id, created_at desc, id desc)` |
| `secure_handshake_messages` | Welcome/Commit/Proposal **relay queue**. | `seq` (**bigserial** delivery cursor), `kind`, `epoch`, `payload`, `sender_device_id`, `target_device_id` (set ⇒ targeted Welcome; null ⇒ broadcast); indexes `(conversation_id, seq)` and `(target_device_id, seq)` |
| `secure_key_backups` | **Passphrase-encrypted** opaque key backup. Server can't decrypt. | `device_id` (nullable, multi-device-ready), `blob`, `nonce`, `kdf`, `kdf_params` (jsonb), `cipher`, `version`; `unique(user_id, device_id)` |

### `current_epoch` semantics

The DS's `current_epoch` is a **commit-linearization counter**, *not* authoritative MLS state (clients
hold that). It exists so the DS can serialize concurrent membership commits with an optimistic check
(see [§11](#11-epoch-ordering--concurrency)).

### RLS

[`0032_secure_chat_rls_triggers.sql`](../apps/api/drizzle/0032_secure_chat_rls_triggers.sql) enables
**deny-all RLS on every secure table** and grants **no** `authenticated` SELECT — stricter than the
plaintext chat (which grants member-scoped reads via the `0017` self-access policies). Rationale: the
secure tables are server-only relays with no client-direct/PostgREST read path; even ciphertext should
never be reachable with a leaked Supabase anon/authenticated key. The server connects as the
RLS-bypassing owner role (the trust boundary), so this is pure defense-in-depth. The same migration
adds an `on_secure_message_insert` trigger that bumps `last_message_at` (mirroring the plaintext
`0002` trigger; the server still never reads the message — only notes its arrival).

> **Migration note:** the `0017` enablement backstop is a one-time loop that ran before these tables
> existed, so `0032` enables RLS on them explicitly. Apply with `pnpm db:migrate:run`.

---

## 7. The wire contract

[`packages/contract/src/secure-chat.ts`](../packages/contract/src/secure-chat.ts) (pure zod + TS, no
hono/drizzle) defines the request schemas and response-model types shared between server and clients.
Two conventions:

- **All binary is base64** on the wire (`base64` zod primitive). The server enforces the real
  **decoded** byte caps; the schema just rejects non-base64 + an absurd pre-decode length.
- **MLS epochs are decimal strings** (`epochString`) — `u64` exceeds JS's safe integer range, so they
  travel as strings and are parsed to `bigint` server-side.

Request schemas: `registerDeviceSchema`, `publishKeyPackagesSchema`, `createSecureConversationSchema`,
`addSecureMemberSchema`, `removeSecureMemberSchema`, `sendSecureMessageSchema`, `uploadKeyBackupSchema`.
Response models: `SecureDeviceModel`, `SecureKeyPackageClaim`, `SecureConversationModel`,
`SecureConversationMemberModel`, `SecureMessageModel`, `SecureHandshakeModel` (carries the `seq`
cursor), `SecureKeyBackupModel`.

---

## 8. The `SecureChatCrypto` seam

All MLS crypto lives **client-side** behind one interface in
`packages/secure-chat-core/src/interface.ts`. This is the abstraction that lets the concrete core —
**ts-mls** (pure TS, runs the same on web/RN/Expo, younger) vs **OpenMLS→WASM** (audited, needs a
native bridge for RN/Expo) — be a **deferred, swappable** decision. **The server depends on none of
it.** Binary is `Uint8Array` in memory; the network layer base64-encodes at the boundary; epochs are
`bigint`.

```ts
interface SecureChatCrypto {
  // identity / device
  generateDeviceIdentity(opts): Promise<{ identity; privateState }>;
  generateKeyPackages(count): Promise<KeyPackageBundle[]>;
  // group lifecycle (outputs are relayed by the server)
  createGroup(opts): Promise<{ group; welcomes }>;
  addMember(group, newDevice): Promise<CommitResult>;     // → Commit + targeted Welcome(s)
  removeMember(group, leafDeviceId): Promise<CommitResult>;
  // application messages
  encryptMessage(group, plaintext): Promise<{ ciphertext; epoch }>;
  decryptMessage(group, ciphertext): Promise<{ plaintext; senderDeviceId; epoch }>;
  // inbound handshakes
  processWelcome(welcome): Promise<GroupHandle>;
  processCommit(group, commit): Promise<GroupHandle>;     // advances epoch
  processProposal(group, proposal): Promise<void>;
  // local state persistence (IndexedDB on web) + passphrase backup
  exportGroupState(group) / importGroupState(state);
  exportBackup(passphrase) / importBackup(passphrase, backup);
}
```

`MockSecureChatCrypto` (same package) is a deterministic, **plaintext-hiding** implementation used by
tests and as a placeholder for early client work: it XORs plaintext with a per-group keystream so the
wrapped bytes never contain the plaintext, conveys the group secret inside the Welcome (so a second mock
instance can decrypt), and round-trips the passphrase backup (wrong passphrase throws). It is **not**
secure — it exists to exercise the relay.

---

## 9. REST API

Base path `/v7/:projectId/secure-chat` (reuses the project resolver, optional-auth, metering, and
`/v7/*` rate limiting). **Every endpoint is `requireAuth`.** Every query is scoped to
`c.var.projectId`. Errors use the standard `{ error, code, field? }` envelope with `secure-chat/*` codes.

### Devices

| Method & path | Body / query | Returns | Notes |
|---|---|---|---|
| `POST /devices` | `registerDeviceSchema` | `201` `SecureDeviceModel` | Upsert on `(userId, deviceId)`; re-registering clears `revoked_at`. Caller registers only their own device. |
| `GET /devices?userId=` | `userId` query | `{ data: SecureDeviceModel[] }` | **Public** device records (signature key + credential) so peers can build a group. Revoked devices excluded. |
| `DELETE /devices/:deviceId` | — | `{ success }` | Revokes the caller's own device (`getMyDevice` scopes to caller). |

### KeyPackages

| Method & path | Body | Returns | Notes |
|---|---|---|---|
| `POST /devices/:deviceId/key-packages` | `publishKeyPackagesSchema` | `201` `{ published: n }` | Bulk publish for the caller's own device; `onConflictDoNothing` on `(deviceId, ref)`. Per-package size cap. |
| `GET /devices/:deviceId/key-packages/count` | — | `{ available: n }` | Unconsumed + unexpired count for the caller's device (replenishment signal). |
| `POST /devices/:deviceId/key-packages/claim` | — | `{ deviceId, keyPackageRef, keyPackage, ciphersuite }` or `409` | **Any** authed user claims one for the *target* device (to add it to a group). |

**Atomic claim** — the hot path is a single statement that locks and consumes exactly one package:

```sql
update secure_key_packages set consumed_at = now(), consumed_by_user_id = $me
where id = (
  select id from secure_key_packages
  where device_id = $target and consumed_at is null and (expires_at is null or expires_at > now())
  order by created_at asc for update skip locked limit 1
) returning ...
```

If no row is available → **`409 secure-chat/key-packages-exhausted`**. After a claim, if the device's
remaining count drops below the low-water mark, the server emits `secure:key-packages-low` to the
device's realtime room.

### Conversations

| Method & path | Body | Returns | Notes |
|---|---|---|---|
| `POST /conversations` | `createSecureConversationSchema` `{ type, mlsGroupId, spaceId?, name?, memberUserIds[], welcomes[] }` | `201` `SecureConversationModel` | Client has already run `createGroup` locally. Channels require `spaceId` + space membership; non-channels reject `spaceId`. Creator → `admin`. Welcomes queued **targeted** to each device; duplicate `mls_group_id` → `409 secure-chat/duplicate-group`. One transaction. |
| `GET /conversations` | `limit`, `cursor` (ISO of `COALESCE(lastMessageAt, createdAt)`) | `{ conversations, hasMore }` | Caller's active conversations, ciphertext-free metadata + `memberCount` + `unreadCount` + `currentMember`. |
| `GET /conversations/:id` | — | `SecureConversationModel` | Member-gated; includes `memberCount` + `currentMember`. |
| `POST /conversations/:id/read` | — | `{ success }` | Sets the member's `last_read_at`. |

### Membership (the client supplies the MLS Commit + Welcomes; the DS linearizes)

| Method & path | Body | Returns | Notes |
|---|---|---|---|
| `POST /conversations/:id/members` | `addSecureMemberSchema` `{ userId, commit, welcomes[] }` | `201` `SecureConversationMemberModel` | **Admin only.** Optimistic epoch bump (see §11); upserts the member; queues the **broadcast Commit** + **targeted Welcome(s)**; fans out. |
| `DELETE /conversations/:id/members/:userId` | `removeSecureMemberSchema` `{ commit }` | `{ success, epoch }` | **Admin** (or self-leave). Optimistic epoch bump; deactivates the member; queues the broadcast Commit. |

### Messages

| Method & path | Body / query | Returns | Notes |
|---|---|---|---|
| `POST /conversations/:id/messages` | `sendSecureMessageSchema` `{ ciphertext, epoch, senderDeviceId, contentType? }` | `201` `SecureMessageModel` | Member-gated; verifies `senderDeviceId` belongs to the caller (`403 secure-chat/device-mismatch`); decoded-size cap; lenient epoch sanity bound; fans out `secure:message`. |
| `GET /conversations/:id/messages` | `limit`, `before` (ISO keyset) | `{ messages, hasMore }` | Member-gated; ciphertext page, `created_at desc`. |

### Handshake inbox + key backup

| Method & path | Body / query | Returns | Notes |
|---|---|---|---|
| `GET /devices/:deviceId/handshakes?since=&limit=` | `since` = last `seq` processed | `{ handshakes: SecureHandshakeModel[], hasMore }` | Caller's own device. Union of **targeted** Welcomes (`target_device_id = device`) + **broadcast** Commits/Proposals in the caller's active conversations, ordered by `seq > since`. The durable catch-up path. |
| `PUT /key-backup` | `uploadKeyBackupSchema` | `{ success, updatedAt }` | Upserts the opaque backup blob (manual upsert via `IS NOT DISTINCT FROM` because `device_id` may be null). Size-capped. |
| `GET /key-backup?deviceId=` | `deviceId` query (optional) | `SecureKeyBackupModel` or `404` | Returns the caller's blob verbatim for client-side decryption. |

### Error codes

`device-not-found`, `user-not-found` / `missing-user`, `invalid-key`, `key-package-too-large`,
`key-packages-exhausted` (409), `conversation-not-found`, `duplicate-group` (409),
`channel-needs-space`, `space-only-channel`, `space-not-found`, `space-not-member` (403),
`not-a-member` (403), `not-admin` (403), `device-mismatch` (403), `epoch-conflict` (409),
`commit-too-large` / `welcome-too-large` / `message-too-large` / `backup-too-large` (413),
`epoch-out-of-range` (400), `backup-not-found` (404).

---

## 10. Realtime — the `/secure` socket.io namespace

[`realtime/secure-socket.ts`](../apps/api/src/realtime/secure-socket.ts) attaches a **separate**
socket.io namespace `/secure` to the same server (defense-in-depth: ciphertext events never mix with
the plaintext handlers). Handshake auth is identical to the main namespace (`auth.token` HS256 over
`ACCESS_TOKEN_SECRET` + `query.projectId`).

**Rooms**
- `secure:conv:{conversationId}` — membership-gated join (`join:secure-conversation`); broadcast
  Commits + application messages.
- `secure:device:{deviceId}` — **auto-joined on connect** for every active device the user owns, so
  targeted Welcomes reach the right tab; also joinable via `join:secure-device` (ownership-verified).

**Server → client events (ciphertext-only payloads)**
`secure:message` (`SecureMessageModel`), `secure:handshake` (broadcast Commit/Proposal),
`secure:welcome` (targeted, to the device room), `secure:member:joined` / `secure:member:left`
(metadata signals), `secure:key-packages-low`, and optional `secure:typing:start|stop`.

REST handlers fan out via `emitToSecureConversation(convId, event, payload)` and
`emitToSecureDevice(deviceId, event, payload)` after writing. **Realtime is a notification
optimization** — the `GET .../handshakes?since=` + `GET .../messages` endpoints remain the durable
source of truth for offline catch-up.

---

## 11. Epoch ordering & concurrency

MLS requires group changes to apply in a strict linear order. The DS enforces this with an
**optimistic concurrency check** on `current_epoch`, without understanding the commit:

```ts
// inside the add/remove transaction — only advance if we're exactly one epoch behind the commit
update secure_conversations set current_epoch = $newEpoch
where id = $conv and current_epoch = $newEpoch - 1
// 0 rows updated → throw 409 secure-chat/epoch-conflict (client must rebase its commit and retry)
```

So two clients racing to commit at the same epoch → one wins, the other gets `409`, refetches
handshakes, rebases, and retries. Application messages carry their `epoch`; the DS only applies a
**lenient sanity bound** (`epoch ≤ current_epoch + EPOCH_WINDOW`, reject otherwise) because it can't
fully validate MLS state. Clients buffer messages whose epoch they haven't reached yet.

---

## 12. Size limits

Decoded-byte caps live in [`lib/env.ts`](../apps/api/src/lib/env.ts), enforced on the base64-decoded
length (never the plaintext — there is none server-side). These are **separate from** the 25 MiB upload
cap (which would invite DoS here):

- `MAX_SECURE_MESSAGE_BYTES` — default **256 KiB** (application messages are small).
- `MAX_SECURE_HANDSHAKE_BYTES` — default **4 MiB** (Welcomes/Commits scale with group size; also caps
  KeyPackages and key-backup blobs).

---

## 13. Server-blindness, proven by tests

Unit + integration suites (vitest):

- **Contract** `packages/contract/src/secure-chat.test.ts` — zod accept/reject.
- **Shapers** `apps/api/src/lib/secure-chat-shape.test.ts` — bytea→base64, no private-column leak,
  bigint→string epochs.
- **Mock crypto** `packages/secure-chat-core/src/mock-crypto.test.ts` — cross-device round-trip +
  plaintext-hiding + passphrase backup.
- **Integration** `apps/api/test/integration/secure-chat-*.test.ts` (real Postgres, project-scoped):
  - `devices` — register, public-fields-only listing, publish/count/claim, exhaustion `409`, revoke,
    cross-user publish refusal.
  - `flow` — full round-trip (register → claim → create group + targeted Welcome → relay → decrypt),
    **asserting `secure_messages.ciphertext` never contains the plaintext** and that a Welcome reaches
    only its target device; device-mismatch + non-member refusals; channel validation.
  - `membership` — add relays Commit + Welcome and advances epoch; stale commit → `epoch-conflict`;
    admin remove deactivates + broadcasts.
  - `realtime` — `/secure` namespace: `secure:message` fan-out, device-room `secure:welcome`, non-member
    join refused.
  - `backup` — PUT/GET round-trips the blob verbatim; the stored blob doesn't contain the plaintext;
    restore-on-new-device works; wrong passphrase fails; upsert (no duplicate rows).

---

## 14. Lifecycle, end to end (web, mock-crypto example)

1. **Register device** — `generateDeviceIdentity()` → `POST /devices` → get the device **row id**
   (used everywhere as `targetDeviceId` / `senderDeviceId`).
2. **Publish KeyPackages** — `generateKeyPackages(n)` → `POST /devices/:id/key-packages`; top up on
   `secure:key-packages-low` / via the count endpoint.
3. **Start a DM** — Alice `claim`s Bob's KeyPackage → `createGroup({initialMembers:[bob]})` →
   `POST /conversations` with the Welcome targeted to Bob's device row id.
4. **Bob joins** — `GET /devices/:id/handshakes?since=<seq>` (or live `secure:welcome`) →
   `processWelcome()` → he now holds the group.
5. **Send** — Alice `encryptMessage()` → `POST .../messages`; Bob `GET .../messages` (or live
   `secure:message`) → `decryptMessage()`.
6. **Add/remove** — admin produces a Commit (+ Welcome) locally → `POST/DELETE .../members`; the DS
   linearizes by epoch and broadcasts; members `processCommit()`.
7. **Backup/restore** — `exportBackup(passphrase)` → `PUT /key-backup`; on a new browser
   `GET /key-backup` → `importBackup(passphrase)`.

---

## 15. Phasing & roadmap

See [`CHAT_TODO.md`](../CHAT_TODO.md) for the live checklist.

- **Phase 1 — DONE (this server).** Delivery service + schema + `/secure` realtime + contract +
  `SecureChatCrypto` seam + mock-tested. Crypto-agnostic.
- **Phase 2 — web client.** Pick + implement a real `SecureChatCrypto` (ts-mls or OpenMLS-WASM) behind
  the interface; IndexedDB group-state persistence; KeyPackage replenishment loop; handshake-pull on
  connect + realtime catch-up; passphrase backup/restore UX (argon2id + strength meter). Expected
  **no server changes**.
- **Phase 3 — native + full multi-device.** React Native + Expo (native MLS bindings if on OpenMLS;
  hardware keystore); multiple `secure_devices` per user as leaves; device-linking/provisioning;
  cross-device history sync (reusing the passphrase-backup mechanism). The core schema is already
  multi-device-ready.

---

## 16. Open decisions & risks

1. **Channel committer strategy (biggest open question).** The server can't add anyone to an MLS group
   (no keys). DMs + small groups work via admin-driven Adds today. Large `channel`s need a committer
   when a space member joins — recommended path is **MLS External Commits** (a newly-authorized user
   self-adds, relayed by the blind DS). The schema is channel-ready now; decide before Phase 2 channels.
2. **No last-resort KeyPackage in v1** (it weakens initial-Welcome forward secrecy). Clients replenish;
   the DS returns `409 key-packages-exhausted` when depleted.
3. **Lenient epoch validation.** The DS isn't running MLS, so it only sanity-bounds message epochs and
   linearizes commits optimistically. Clients must detect drop/replay/reorder via MLS generation
   counters — verify the chosen core enforces this.
4. **Metadata leakage is accepted** (social graph + timing + sizes) — the Signal-server model.
   Client-side ciphertext **padding** to size buckets is a Phase 2 mitigation. `secure_conversations.name`
   is the one deliberate plaintext concession — prefer `null` and carry the display name in an E2EE
   group-info message. **Network-layer** metadata (client IP, geolocation, ISP traffic correlation) is
   outside E2E entirely; the complement is **onion routing** — serving the API as a Tor hidden service
   (`.onion`) and/or routing the client transport through Tor, for both secure chat and normal browsing.
   It's transport/deploy-only (no schema/contract changes) — tracked under "Future exploration" in
   [`CHAT_TODO.md`](../CHAT_TODO.md), with the one gotcha that IP-based rate limiting degenerates behind a
   single onion address.
5. **Backup passphrase strength.** The server holds the ciphertext blob, so a weak passphrase is
   offline-brute-forceable on a DB exfil. Enforce a strong KDF (argon2id, conservative params) + a
   strength meter client-side (Phase 2 UX).
6. **`secure_handshake_receipts`** (per-device ack table) was intentionally left out — Phase 1 is
   cursor-only. Add it only if server-side handshake GC needs it.
7. **Cross-tenant isolation.** Every secure table carries `project_id` (cascade FK); every query filters
   on `c.var.projectId`. Any new endpoint must keep that scoping (especially cross-user device reads).
