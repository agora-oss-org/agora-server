# IUC restore-blob relay — integration guide

**Audience:** the agora-sdk-plus secure-chat team (the consumer of this endpoint).
**Status:** server contract for the IUC **ENVELOPE** variant. Implements the cross-repo request of
2026-06-20.
**Server design / rationale:** `docs/superpowers/specs/2026-06-20-iuc-restore-blob-design.md`
**Feature design (SDK side):** `docs/superpowers/specs/2026-06-18-iuc-history-restore-design.md` *(SDK repo)*

This document is the source of truth for **what the server provides** and **what the SDK must do** to
restore conversation back-history onto a re-provisioned device without weakening E2EE.

---

## 1 · What this is

When device **B** is reinstalled and re-joins a conversation, MLS forward secrecy lets it read *future*
messages but **nothing** from before — the old message keys were single-use and are gone. Recovery
requires a peer device **A** (still holding the plaintext) to hand it over.

- **Small histories → INLINE.** A sends the history over MLS application messages. No server
  involvement; this endpoint is not used.
- **Large histories → ENVELOPE.** A seals the history into one opaque AEAD blob, **uploads it here**,
  and sends only the decryption key `K` to B **over MLS**. This relay is the courier for that blob.

The relay is a **targeted, ephemeral, opaque drop-box**: A uploads a blob addressed to B, only B can
fetch it, it is consumed once and swept. The server stores **opaque bytes** and learns **no key and no
plaintext** — the same blindness it already has for KeyPackages, Welcomes, and message ciphertext.

## 2 · The blindness contract (what the server can and cannot see)

| The server stores / sees | The server NEVER sees |
|---|---|
| opaque blob bytes (`bytea`) | the decryption key `K` |
| uploader device id, target device id | the plaintext history |
| `conversationId`, blob byte-size, timestamps | `sha256`, `count`, AAD, or any transfer descriptor |

`K` travels **only** inside the MLS `iuc/restore-envelope` control message (A→B, inside the group). It
**must never** appear in any field of any request to this endpoint. The server does not validate the
blob — no AAD check, no `sha256` check, no decryption. B validates integrity locally after decrypting.

The only new observable vs. what the server already had (it relayed the Commit/Welcome that added B) is
**blob size + timing** — inherent to bulk store-and-forward, and accepted.

## 3 · Authorization model (read this — it differs from the request's wording)

The request specified "only the **device** matching `targetDeviceId` may fetch." Agora access tokens are
**user-scoped, not device-scoped** (the JWT `sub` is a userId; there is no per-device credential). So the
server enforces the equivalent, strongest predicate it can:

> **the caller is the *user who owns* device row `targetDeviceId`.**

This is equivalent for the threat model (B is the user's own re-provisioned device; a user's devices
share a trust domain). Practical consequences for the SDK:

- **Upload (A):** the caller must own `fromDeviceId` **and** be an active member of `conversationId`.
- **Fetch / delete (B):** the caller must own `targetDeviceId`. Because B re-provisioned, "own" means
  B's **current, non-revoked** device row — register/re-register the device first, then fetch.
- **Existence oracle is closed.** On GET/DELETE, *blob missing*, *blob expired*, and *caller is not the
  target's owner* all return the **same 404**. A non-recipient can never confirm a blob exists. Treat
  404 as "nothing for me" — never branch on it.

## 4 · Lifecycle / sequencing

```
A (holds history)                         server (blind relay)                 B (re-provisioned)
  │                                                                                   │
  │ 1. seal: blob = XChaCha20Poly1305(K, history), AAD = transfer descriptor          │
  │ 2. POST /restore-blobs {conversationId, fromDeviceId, targetDeviceId, blob} ─────▶ │
  │ ◀──────────────────────────────────── 201 {blobId, expiresAt}                     │
  │ 3. send over MLS:  iuc/restore-envelope {transferId, blobId, K, count, sha256} ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ▶
  │                                        (server never sees this message)            │
  │                                                                  4. GET /restore-blobs/:blobId ─────▶
  │                                        200 {blob, conversationId, fromDeviceId,…} ◀───────────────── │
  │                                                          5. AEAD-decrypt with K, verify sha256+AAD   │
  │                                                          6. persist to local encrypted store         │
  │                                        7. DELETE /restore-blobs/:blobId ────────────────────────────▶
  │                                        204 ◀───────────────────────────────────────────────────────│
  │                                                                                   │
  │ (8. backstop: any blob B never DELETEs is swept after TTL — §7)                    │
```

**Resume-safety:** the GET is **non-destructive**. If B crashes between fetch (4) and persist (6), it
re-GETs the same `blobId`. B issues the `DELETE` (7) only **after** the history is durably stored. Do
not delete on read.

## 5 · REST reference

Base path: **`{baseUrl}/{projectId}/secure-chat`** (e.g. `https://host/v7/{projectId}/secure-chat`).
All three endpoints require the standard `Authorization: Bearer <accessToken>`. Binary fields cross the
wire as **base64**.

### `POST /restore-blobs` — upload (device A)

Request body:
```jsonc
{
  "conversationId": "uuid",
  "fromDeviceId":   "uuid",   // A's OWN device row id — caller must own it
  "targetDeviceId": "uuid",   // B's current (non-revoked) device row id
  "blob":           "base64"  // opaque XChaCha20-Poly1305 ciphertext
}
```

> **`fromDeviceId` is required and is an addition to the request's sketch.** The server cannot infer
> *which* of the caller's devices is A from a user-scoped token, and the GET response must echo it. Set
> it exactly as you set `senderDeviceId` on `POST /conversations/:id/messages`.

Responses:

| Status | Code | When |
|---|---|---|
| `201` | — | `{ "blobId": "uuid", "expiresAt": "ISO-8601" }` |
| `404` | `secure-chat/device-not-found` | caller does not own `fromDeviceId` |
| `403` | `secure-chat/not-a-member` | caller is not an active member of `conversationId` |
| `404` | `secure-chat/restore-target-not-member` | `targetDeviceId` missing/revoked, or its owner is not a member |
| `413` | `secure-chat/restore-blob-too-large` | blob exceeds the size cap (§6) — **chunk or fall back to INLINE** |
| `429` | `common/rate-limited` | outstanding-blob quota exceeded (§6) — **back off and retry** |

### `GET /restore-blobs/:blobId` — fetch (device B), non-destructive

Responses:

| Status | Code | When |
|---|---|---|
| `200` | — | `{ "blobId", "conversationId", "fromDeviceId", "blob": "base64", "createdAt", "expiresAt" }` |
| `404` | `secure-chat/restore-blob-not-found` | missing **or** expired **or** caller is not the target's owner |

### `DELETE /restore-blobs/:blobId` — confirm + remove (device B)

Call only **after** the history is durably persisted locally.

| Status | Code | When |
|---|---|---|
| `204` | — | deleted (empty body) |
| `404` | `secure-chat/restore-blob-not-found` | missing **or** caller is not the target's owner |

## 6 · Limits the SDK must respect (server-configurable; these are the deployment defaults)

| Limit | Default | What the SDK does about it |
|---|---|---|
| **Per-blob size** (`MAX_SECURE_RESTORE_BLOB_BYTES`) | **16 MB** | If the sealed blob would exceed it: chunk into ≤16 MB blobs, or fall back to INLINE. A `413` with code `secure-chat/restore-blob-too-large` is the signal. |
| **TTL** (`SECURE_RESTORE_BLOB_TTL_SECONDS`) | **900 s (15 min)** | A restore must complete within the window. After TTL the blob is swept and GET returns 404; A must re-upload. Don't stall a transfer across the TTL. |
| **Per-pair quota** (`MAX_SECURE_RESTORE_BLOBS_PER_PAIR`) | **16** outstanding A→B | Bounds in-flight chunks per recipient (~256 MB at 16 MB). On `429`, back off and retry as B drains (fetches+deletes) earlier chunks. |
| **Per-target quota** (`MAX_SECURE_RESTORE_BLOBS_PER_TARGET`) | **64** outstanding to B | Aggregate backstop across all uploaders. Same `429` handling. |

These are **per deployment** — do not hardcode 16 MB or any quota in the SDK. Discover the size limit
empirically (size client-side; treat `413` as the authoritative cap and chunk down) rather than
assuming a value.

> **Status note:** too-large is **HTTP 413**, not the `400` the original request sketched (413 is the
> correct status for an oversized payload). Key your INLINE/chunk fallback on the **error code**
> `secure-chat/restore-blob-too-large`, which is the stable contract.

## 7 · Chunking a large history

The endpoint is **single-blob and stateless about chunking.** A history larger than one blob is sent as
**N independent transfers**:

- N× `POST /restore-blobs` → N distinct `blobId`s.
- N× `iuc/restore-envelope` MLS messages (one `K`/`blobId`/`sha256`/index per chunk), or one MLS message
  carrying the list — your choice; the server is not involved.
- B fetches each `blobId`, decrypts, and **reassembles client-side** in the order your descriptor
  encodes. There is no server-side `transferId` grouping and no total-size concept; bound the transfer
  with your own descriptor (e.g. `transferId`, `chunkIndex`, `chunkCount`).

**Reassembly integrity is the SDK's job:** verify each chunk's `sha256` and AAD binding after AEAD
decrypt, and verify the assembled whole against your descriptor before trusting it.

> **Open item to confirm:** the original request said the SDK will *"chunk **or** fall back to INLINE."*
> If a large history past one blob falls back to INLINE rather than chunking, it degrades to thousands
> of MLS app-messages — the pathology ENVELOPE exists to avoid. The server supports chunking today with
> zero changes; please confirm the SDK chunks for the large case. (This does not block the server work.)

## 8 · Optional realtime nudge

On a successful upload the server emits, to **B's device socket only**, on the `/secure` realtime
(engine.io path `/secure-socket/`):

```
event: "secure:restore-blob-available"
data:  { "conversationId": "uuid" }
```

It carries **no `blobId` and no key** — B already learns `blobId` from the MLS `iuc/restore-envelope`
message. This is a **latency nicety, not required for correctness**: B can equally poll/act on the MLS
message alone. Do not depend on it.

## 9 · What the SDK must guarantee (so blindness holds)

- Seal client-side with a **full-entropy random `K`** (256-bit CSPRNG — never a passphrase/KDF) using
  **XChaCha20-Poly1305**, binding the transfer descriptor (`transferId`, `conversationId`,
  `fromDeviceId`, `targetDeviceId`, `chunkIndex`, `count`) as **AAD** so a blob can't be replayed into a
  different transfer/slot.
- Transmit `K` **only** inside the MLS `iuc/restore-envelope` message. Never in any field of any request
  to this endpoint.
- Send **only** opaque base64 + the routing ids (`conversationId`, `fromDeviceId`, `targetDeviceId`) on
  the wire here.
- After AEAD-decrypting locally, verify `sha256` (over your pinned canonical form) and the AAD binding
  **before** trusting the history. The server validates none of this.

## 10 · SDK implementation checklist

- [ ] Type-only re-export `UploadRestoreBlobBody`, `RestoreBlobModel`, `UploadRestoreBlobResponse` from
      `@agora-server/contract` (added in the minor bump 0.12.1 → 0.13.0) into `core/src/contract/`.
- [ ] REST-client methods: `uploadRestoreBlob(body)` → `{ blobId, expiresAt }`, `getRestoreBlob(blobId)`
      → `RestoreBlobModel | null` (map 404 → null), `deleteRestoreBlob(blobId)` → void.
- [ ] Include `fromDeviceId` in the upload body.
- [ ] Seal/AAD/`K`-over-MLS per §9; `iuc/restore-envelope` control message (+ chunk descriptor for §7).
- [ ] Sender (A): size → chunk on `413`, back off on `429`, complete within TTL.
- [ ] Receiver (B): register the current device first; GET (non-destructive) → decrypt → verify →
      persist → **then** DELETE; re-GET on crash before persist; treat 404 as "nothing for me."
- [ ] Move the SDK's `@agora-server/contract` dependency to the published minor once it ships.

## 11 · Out of scope

No plaintext storage, no key storage, no MLS awareness server-side, no decryption, no message-history
ledger, no durable retention. This is a one-shot drop-box — not a backup service. (The deprecated
passphrase `key-backup` endpoint was the durable-backup mechanism; this is explicitly not that.)
