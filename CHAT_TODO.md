# Secure Chat (E2E / MLS) — Roadmap & Open Decisions

Secure chat is end-to-end-encrypted group messaging built on **MLS (RFC 9420)**, on a path entirely
separate from the Replyke-compatible plaintext chat. **Phase 1 is done** (this repo): the server is a
blind MLS *Delivery Service* — it stores/relays opaque ciphertext, enforces membership + commit
ordering, and never reads content. All crypto is client-side behind the `SecureChatCrypto` seam
(`@agora/secure-chat-core`); the concrete MLS core (ts-mls vs OpenMLS-WASM) is **deliberately deferred**.

Design doc: `docs/superpowers/specs/` / the approved plan. Server reference: `apps/api/src/routes/secure-chat.ts`,
`apps/api/src/db/schema/secure-chat.ts`, `apps/api/src/realtime/secure-socket.ts`.

---

## Phase 1 — DONE (server delivery service, crypto-agnostic)

- [x] Schema: `secure_devices`, `secure_key_packages`, `secure_conversations`,
      `secure_conversation_members`, `secure_messages`, `secure_handshake_messages` (`seq` cursor),
      `secure_key_backups` — `bytea`, multi-device-ready, RLS deny-all (migrations `0031`/`0032`).
- [x] REST delivery service (`/v7/:projectId/secure-chat/*`) + `/secure` socket.io namespace.
- [x] Contract wire types (`@agora/contract` `secure-chat`) + `@agora/secure-chat-core` (interface + mock).
- [x] Integration tests with the mock crypto (incl. the server-never-stores-plaintext assertion).

---

## Phase 2 — Web client (real crypto behind the interface)

The server is expected to need **no changes** (the DS is complete); any gap feeds back as an additive
migration.

- [ ] **Pick + implement a real `SecureChatCrypto`.** Decide ts-mls (pure TS, same JS on web/RN/Expo,
      younger/less-audited) vs OpenMLS→WASM (audited, but RN/Expo need a native bridge). Implement it as
      a new module in `packages/secure-chat-core` behind the existing interface; the mock stays for tests.
- [ ] **Key storage (IndexedDB).** Persist device identity + per-group MLS state via
      `exportGroupState`/`importGroupState`. Handle Safari/`clear browsing data` eviction gracefully.
- [ ] **KeyPackage replenishment loop.** Publish a batch on registration; top up on the
      `secure:key-packages-low` signal and via the `/key-packages/count` endpoint.
- [ ] **Handshake processing.** On connect, pull `GET /devices/:id/handshakes?since=<lastSeq>` then live
      via `secure:welcome` / `secure:handshake`; process Welcomes/Commits in `seq` order; buffer
      application messages whose epoch the client hasn't reached yet.
- [ ] **Passphrase backup UX (option 2).** `exportBackup`→`PUT /key-backup` on a schedule; restore on a
      new browser via `GET /key-backup`→`importBackup`. Enforce a strong KDF (argon2id, conservative
      params) + a passphrase-strength meter — the server holds the ciphertext blob, so a weak passphrase
      is offline-brute-forceable on a DB exfil.
- [ ] **Client-side ciphertext padding** to size buckets, to blunt size-fingerprinting (metadata).
- [ ] **Safety-number / key verification UI** (out-of-band fingerprint compare) for TOFU hardening.

## Phase 3 — Native + full multi-device

- [ ] **React Native + Expo.** If on OpenMLS, build the native Rust bridge (uniffi/JSI) + an Expo config
      plugin/dev client; if on ts-mls, mostly "ship the same JS." Use the hardware keystore (iOS
      Keychain / Android Keystore) for key material. The core schema is already multi-device-ready.
- [ ] **Full multi-device.** Multiple `secure_devices` per user as MLS leaves; a device-linking/
      provisioning flow (QR / verification code); cross-device history sync (reuse the passphrase-backup
      mechanism as the history-transfer channel); self-device management (list/revoke) UI.

---

## Open decisions / risks (flagged in Phase 1, resolve before the relevant phase)

1. **Channel committer strategy (biggest open question).** The server can't add anyone to an MLS group
   (no keys). DMs + small groups work via admin-driven Adds today. Large `channel`s need a committer
   when a space member joins — recommended path is **MLS External Commits** (newly-authorized user
   self-adds, relayed by the blind DS). Decide before shipping Phase 2 channels. The schema is
   channel-ready now.
2. **No last-resort KeyPackage in v1** (it weakens initial-Welcome forward secrecy) — clients must
   replenish; the DS returns `409 key-packages-exhausted` when depleted. Revisit if depletion bites.
3. **Epoch validation is lenient.** The DS isn't running MLS, so it only sanity-bounds message epochs
   (`<= currentEpoch + EPOCH_WINDOW`) and linearizes commits optimistically. Clients must detect
   drop/replay/reorder via MLS generation counters — verify the chosen core enforces this.
4. **Metadata leakage is accepted** (social graph + timing + sizes), the Signal-server model.
   `secure_conversations.name` is the one deliberate plaintext concession — prefer `null` and carry the
   display name inside an E2EE group-info message. **Network-layer** metadata (client IP, geolocation,
   ISP traffic correlation) is *not* addressed by E2E at all — see "Future exploration: Tor" below.
5. **`secure_handshake_receipts`** (per-device ack table) was left out — Phase 1 is cursor-only. Add it
   only if server-side handshake GC needs it.

---

## Future exploration — network-layer privacy (Tor / onion routing)

E2E hides message *content*; it does nothing about the *network* metadata the server and any on-path
observer still see — **client IP / geolocation, connection timing, and traffic-volume correlation**.
For a threat model that includes "don't even reveal *who is talking to this server from where*," the
complement to MLS is **onion routing**. Worth investigating (not committed):

- [ ] **Serve the API as a Tor hidden service (`.onion`).** Clients reach `@agora/api` over Tor, so the
      server never learns a real client IP and there's no exit node — end-to-end inside the Tor network.
      Applies to **both** secure chat *and* normal browsing/REST traffic. Mostly an ops/deploy concern
      (a `tor` sidecar publishing the onion address); the app is transport-agnostic.
- [ ] **Client-side: route the SDK/socket.io transport through Tor** (native Tor, Orbot on Android, or
      Arti) for clients that opt in — independent of whether the server runs a hidden service.
- [ ] **socket.io over Tor.** Confirm long-lived realtime connections behave under Tor's added latency
      (reconnection/backoff, handshake timeouts).
- [ ] **Pairs with** client-side ciphertext **size-bucket padding** (Phase 2) — onion routing hides the
      endpoints, padding blunts traffic-shape fingerprinting; together they close most of the metadata gap.

This is **orthogonal to the MLS work** and needs no schema/contract changes — it's a transport/deploy
hardening track that can land any time after Phase 1.

### Anti-abuse without IP — the real work (feasible, not a blocker)

Behind a single `.onion` every request arrives from the local Tor daemon, so the IP-keyed limiter
(`lib/rate-limit.ts`, keyed via `RATE_LIMIT_TRUSTED_HOPS` / `X-Forwarded-For`) degenerates — one
abuser looks like everyone. That does **not** kill Tor support; IP limiting was already a weak heuristic
(CGNAT/corporate NAT share one IP; mobile IPs rotate; VPNs are cheap). The fix is to **swap the key, not
drop the control:**

- [ ] **Authenticated routes → key on the account/token (`sub`), not the IP.** Every mutation is
      `requireAuth`, so the abuse-sensitive write surface keys cleanly on identity — *strictly better*
      than IP (an attacker can't escape it by switching networks). Localized change; the limiter store is
      already pluggable (in-process / Redis).
- [ ] **Unauthenticated surface is the hard part** — `/auth/*` (login brute-force, signup spam, the
      stricter `RATE_LIMIT_AUTH_MAX`) and anonymous reads. Mitigations (standard for Tor/VPN-facing
      services): a **proof-of-work or CAPTCHA challenge** on signup/login; **account/email-keyed** limits
      + email-confirmation gating; **global/endpoint caps** on the onion ingress as a blast-radius
      backstop; or simply **keep signup/login on clearnet** and use the `.onion` for the authenticated app.
- [ ] **Two ingresses, two policies.** Don't apply one limiter to both doors: clearnet keeps the IP-keyed
      limiter as-is; the `.onion` gets an account-keyed + challenge policy. Additive "onion mode," not a
      rearchitecture.

**Honest cost:** you trade IP heuristics for **account-level controls + challenges**. A determined
abuser who farms many accounts is harder to stop than one you could IP-ban — but that's inherent to
offering anonymity (the same trade every privacy service makes), and the account-level **stewardship**
layer is already the right lever for it. Feasible: yes. Free: no — Tor promotes account/challenge-based
anti-abuse from nice-to-have to **required** for the onion's unauthenticated endpoints.
