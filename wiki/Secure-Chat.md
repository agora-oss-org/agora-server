# Secure Chat

A community backend that keeps everyone's DMs in readable plaintext is a breach waiting to happen.
Storing readable private messages is the bad default Agora refuses to ship — so **secure chat is
end-to-end encrypted, and built so the server *cannot* read it.**

> ### ⚠️ Status: unaudited
>
> Secure Chat implements MLS (RFC 9420) via [`ts-mls`](https://github.com/LukaJCB/ts-mls). Neither
> `ts-mls` nor Agora's integration around it has received an independent security audit. The design is
> documented below and the server stores only ciphertext — but **design intent is not the same as
> verified implementation**. Do not rely on Secure Chat where compromise would put someone at risk.
> Independent cryptographic review is explicitly welcome — see [[Security]].

> Full design, threat model, schema, endpoints, and roadmap:
> [`docs/SECURE_CHAT.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/SECURE_CHAT.md).

## A blind delivery service on MLS

Secure chat is built as a **blind delivery service** on **MLS (RFC 9420)** — the IETF
messaging-layer-security standard, the same family of guarantees as Signal but designed for large,
dynamic groups.

- **The server is blind.** It stores and relays only **opaque ciphertext**. It enforces *who* may post
  and the *order* of group changes, but never sees *what* — it learns social-graph + timing metadata
  only (the Signal-server model). All cryptography is client-side; the server depends on no crypto library.
- **No AI in your DMs — on purpose.** Secure chat runs **no** LLM moderation, embeddings, or semantic
  search. Those require reading content, which is exactly what we refuse to do. That trade is the point.
- **A separate path *and* a separate process.** It lives at `/v7/:projectId/secure-chat/*`, entirely
  apart from the Replyke-compatible plaintext chat (which is untouched), and runs as its own deployable
  service (`@agora/secure-chat`) with its `/secure` realtime namespace on engine.io path
  `/secure-socket/`. See [[Deployment]] (`--profile secure-chat` / `--profile full`).
- **Your keys, your history.** Keys live on the client. Two recovery paths — both opaque to the server —
  restore history onto a re-provisioned device: a passphrase-encrypted backup, and **device-to-device
  history restore** (a peer seals back-history into an ephemeral, targeted blob the server relays
  blindly). See
  [`apps/secure-chat/docs/RESTORE.md`](https://github.com/agora-oss-org/agora-server/blob/root/apps/secure-chat/docs/RESTORE.md).
- **The crypto stays swappable.** All MLS lives behind a small `SecureChatCrypto` interface, so the
  concrete core (ts-mls vs OpenMLS-WASM) is a deferred, reversible choice — the server never changes.

## Where the code lives

The blind relay (routes, socket, shapes) is the `@agora/secure-chat` app
([`apps/secure-chat/README.md`](https://github.com/agora-oss-org/agora-server/blob/root/apps/secure-chat/README.md)).
The **client** crypto packages live in the separate `agora-sdk-plus` repo (see [[Ecosystem]]); this repo
only devDepends on the mock for tests.

## Diagnostics

A secure-chat log correlator (`apps/api/scripts/diag/`) lifts the client-SDK and server log streams into
one event schema for debugging realtime issues. Background and the longer-term harness plan:
[`docs/SECURE-CHAT-DIAG-HARNESS.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/SECURE-CHAT-DIAG-HARNESS.md).
