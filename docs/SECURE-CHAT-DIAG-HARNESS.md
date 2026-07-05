# Secure-Chat Diagnostic Client Harness (`chat-diag`) — Concept

**Status:** 💡 Concept / parked for later. Nothing built yet.
**Owner repo (proposed):** `../agora-sdk-plus` (it is an SDK *client*, not server code — see "Where it lives").
**Captured:** 2026-06-17, out of a live secure-chat debugging session.

---

## Why this exists (the problem)

Diagnosing the MLS secure-chat ("waiting for key update…") failures **browser-to-browser is an
uncontrollable test rig**:

- Device identity churns on every reload (a fresh `secure_devices` row each load), so Welcomes end
  up targeting a device the browser no longer is → permanent "waiting for key update".
- IndexedDB state is invisible and per-origin; port/host churn silently forks it.
- **The SDK emits zero logs** — no logger, no debug flag anywhere in `secure-chat/core` or
  `secure-chat/crypto`. The browser console is empty even on failure, so there is nothing to read.

The result is guess-and-check debugging against state we can't see. We need a **deterministic,
scriptable, observable** way to drive two real secure-chat clients full-circle through the live
server — and to keep it around for load testing and regression knowledge.

## What already exists (and why it's not enough)

- **`../agora-sdk-plus/e2e/secure-chat.e2e.ts`** (~312 lines) drives the *real* `ts-mls` crypto +
  `SecureChatRestClient` + `SecureChatSocketClient` against a live agora-server, headless, no React.
  It does the full cycle: register → publish key-packages → `createGroup` + Welcome →
  `processWelcome` → encrypt/send → list/`decryptMessage` (+ one live socket round + backup/restore).
  **But** it runs *both* "devices" as in-memory objects **inside one Node process**, as a vitest
  pass/fail test against a throwaway DB. It is **not** two independently-invocable, persistent,
  handle-addressable client processes. It proves the protocol works *in vitro*; it is not an
  operable two-terminal harness.
- **`apps/secure-chat/test/integration/secure-chat-*.test.ts`** (devices / flow / membership / realtime /
  backup) prove the **server API contract** with `MockSecureChatCrypto`. Green. *(These moved with the
  service split — none remain under `apps/api`.)*
- **Gap:** nothing exercises the **persistence / reload seam** the browser bug actually lives in —
  the `SecureChatRepository` + store + device-rehydrate cycle ("save device → simulate reload →
  `loadDevice` should rehydrate, NOT re-register"). The e2e holds group handles in local vars; it
  never reloads through the repository.

## The concept: `chat-diag`, a real headless secure-chat client as a CLI

Two **separate processes**, addressable by user handle, rendezvousing **through the live server**
(the blind delivery service) — i.e. genuinely full-circle, not in-memory:

```sh
# Terminal 1 — initiator: register jenova's device, create a DM to alice, send
chat-diag @jenova --to @alice
#   → starts client 1, opens a new secure session jenova → alice, sends message(s)

# Terminal 2 — responder: register alice's device, find the chat from jenova, receive/decrypt
chat-diag @alice --for @jenova
#   → starts client 2, opens any chat from jenova, drains handshakes, decrypts, (optionally) replies
```

### Three use cases it must serve

1. **Diagnosis** — verbose, step-by-step DEBUG at every crypto + REST boundary; reproduces the
   device-churn / persistence failure on demand with state we can actually read.
2. **Load testing** — `--count N`, `--rate`, `--concurrency` to drive volume and measure the system
   under load.
3. **Full-circle e2e + stats** — assert both directions decrypt; report statistics (per-step
   latency, decrypt success rate, epoch progression, throughput) for fine-tuning and knowledge.

## Building blocks (all headless-ready, already exported)

The harness is essentially **"what the React hooks do," re-implemented imperatively as a CLI client.**
The orchestration is already fully mapped:

| Need | Use |
| --- | --- |
| Real MLS crypto (Node) | `createTsMlsSecureChatCrypto()` — `secure-chat-crypto/ts-mls` (runs under plain Node; ESM-only) |
| REST transport | `SecureChatRestClient` — `core/src/transport/rest.ts` (lazy `getBaseUrl`/`getAccessToken`/`projectId`; standalone-usable) |
| Realtime | `SecureChatSocketClient` — `core/src/transport/socket.ts` (namespace `/secure` on engine.io path `/secure-socket/`, targeting the `@agora/secure-chat` service) |
| Persistence façade | `SecureChatRepository` — `core/src/persistence/repository.ts` (keys: `device`, `group:{convId}`, `handshake:cursor`) |
| Store | `MemoryStore` exists (`core/src/persistence/memory-store.ts`); **harness wants a new filesystem store** so two processes + reloads persist (see below) |

**Imperative sequence to replicate** (from the hook orchestration map):

1. **Device**: `loadDevice()` → if present `importDeviceState()` and DO NOT re-register; else
   `generateDeviceIdentity()` → `registerDevice()` → `exportDeviceState()` → `saveDevice()`.
   *(This is the exact step that fails in the browser — the harness must make non-re-registration on
   reload an explicit, asserted invariant.)*
2. **Key-packages**: `generateKeyPackages()` → `publishKeyPackages(device.id, …)`; replenish on
   low-water.
3. **Create DM (initiator)**: `listDevices(peerUserId)` → `claimKeyPackage(d.id)` per device →
   `crypto.createGroup({ initialMembers })` → `createConversation({ type:"dm", mlsGroupId, welcomes })`
   → `repo.saveGroupState(convId, group)`.
4. **Drain handshakes (responder)**: poll `GET /devices/:id/handshakes?since={cursor}` →
   for `welcome` `processWelcome` + `saveGroupState` + `socket.joinConversation`; for `commit`
   `processCommit`; advance + persist `handshake:cursor` (advance even on error — poison-row safe).
5. **Send**: `encryptMessage(group, plaintext)` → `sendMessage(convId, { ciphertext, epoch, senderDeviceId })`.
6. **Receive/decrypt**: socket `secure:message` or `listMessages` → `decryptMessage(group, ciphertext)`.
   Pending iff **no local group** or **`message.epoch > group.epoch`**; rejected otherwise (fail-closed).

### ID distinction to respect (a known footgun)
`deviceId` (client-generated **text**, stable, minted once) **≠** `device.id` (server **row UUID**).
Handshake targeting, key-package claim, and message `senderDeviceId` use the **server row UUID**.

## Key design decisions (proposed, not final)

- **Language: TypeScript, mandatory.** Real MLS only exists in the TS SDK (`ts-mls`); a Python client
  cannot `processWelcome`/`decrypt`. Python could only ever be a *separate, no-crypto API-stability
  oracle* (hammer the raw REST API to prove the server persists devices/welcomes/messages/epochs).
- **Persistent on-disk store, per handle.** A new `SecureChatStore` backed by the filesystem
  (e.g. `~/.agora-chat-diag/<handle>/`), so two processes coexist and **reload semantics are real** —
  which is precisely the seam the browser bug lives in. (For pure logic tests, the IndexedDB store can
  also be driven in Node via `fake-indexeddb`, but the CLI wants a real durable store.)
- **Handle → auth.** Resolve `@handle` → `profiles.username` → mint an HS256 JWT over
  `ACCESS_TOKEN_SECRET` (`sub = profile.id`), same recipe as `apps/api/scripts/chat-e2e.mjs` /
  `e2e/bootstrap.ts`. Project id configurable (default the demo `11111111-…`).
- **Target: live by default.** Point at the running dev server (`:4000`) + its real DB so it mirrors
  the browser's actual environment; allow overriding base URL / project / handles.
- **Exchange pattern:** default **bidirectional ping-pong** (both send + both decrypt, verifies both
  directions + epoch advance), with a `--one-way` flag for the minimal repro.
- **Observability:** the harness logs every boundary itself (it calls the SDK pieces directly, so it
  needs no SDK change). **Separately**, consider adding an opt-in logger seam *inside* the SDK
  (hooks + repository + crypto) so the **browser** becomes diagnosable too — that's a distinct,
  larger-blast-radius change in `agora-sdk-plus`, tracked as a follow-up.

## Where it lives

**Not in `agora-server`.** It's an SDK consumer. Natural home: **`../agora-sdk-plus`** (alongside
`e2e/`, reusing `e2e/bootstrap.ts` + `e2e/crypto-factory.ts`), as a small `bin`/CLI package — or a
tiny standalone repo if we want it installable independently. The server repo only owns the *API
contract* it exercises.

## Open questions for revisit

- Scope: TS harness only, or also the Python API-stability oracle? (Lean: TS first; Python only if the
  server falls under suspicion.)
- Goal weighting: one-shot diagnosis tool vs durable, maintained regression suite (or both, in order)?
- Do we fold in the **SDK logger seam** at the same time (browser diagnosability), or keep it a
  follow-up?
- Statistics surface: what exactly to report for "fine-tuning" (latency histograms, decrypt-success %,
  epoch lag, key-package burn rate, handshake drain time)?
- Multi-device per user: model it (a user with N devices ⇒ N Welcomes per DM) or keep to one device
  per handle for v1?

## Related

- `docs/SECURE_CHAT.md` — the secure-chat subsystem design.
- `apps/secure-chat/src/routes/secure-chat.ts` — the server REST surface it drives (now in the separate
  **`@agora/secure-chat`** service, no longer `apps/api`). The realtime it correlates is the `/secure`
  namespace on engine.io path **`/secure-socket/`**, served by that same service — so the **server-stream
  logs to capture come from the secure-chat app's process**, not `@agora/api`. The diag *script* itself
  stays at `apps/api/scripts/diag/secure-chat-log-normalize.mjs`.
- `../agora-sdk-plus/e2e/secure-chat.e2e.ts` — the in-process e2e to learn the flow from / reuse bootstrap.
- Server-side logging gaps worth closing regardless: no logs today on key-package claim, member
  add/remove, message send, handshake delivery, or any 409 epoch-conflict
  (`apps/secure-chat/src/routes/secure-chat.ts`).
