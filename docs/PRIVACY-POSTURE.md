# 🔐🏛️ Privacy Posture — "Signal w/ Community"

> **Status:** Positioning + threat-model reference. The privacy *gradient* below is real today;
> the **avoidable-daylight checklist** ([§6](#6-avoidable-daylight--the-roadmap-to-earn-the-banner))
> is the roadmap to fully *earn* the banner. Pairs with [`SECURITY.md`](./SECURITY.md) (operator
> hardening + the trust-boundary model) and [`SECURE_CHAT.md`](./SECURE_CHAT.md) (the blind MLS
> delivery service).
>
> **Claims in this doc were verified against the code on 2026-07-05** — secure-chat blindness +
> crypto maturity, social-graph k-anonymity/dyadic surfaces, at-rest plaintext + deletion-cascade
> behavior, and logging discipline. Where reality differs from the banner (secure-chat client crypto
> is Phase 2/3; deletion of derived data is incomplete), this doc states the *as-built* truth.

Agora's one-line pitch is **"Signal w/ community."** This document is the honest fine print behind
that banner — what it claims, what it does *not* claim, and exactly which guarantee holds on which
surface. The goal: a security-literate person should be able to read this and **not flinch.**

---

## 1. The banner, precisely

> **Chat is Signal-grade. The square is as private as a *functioning* community square can be.**

These are **two different surfaces with two different trust models**, and conflating them is the only
way to get the claim wrong:

- **Chat (secure-chat):** designed for genuine end-to-end encryption (MLS / RFC 9420). **The server is
  operator-blind *by construction today*** — `secure_messages` stores only opaque `bytea` ciphertext
  with **no** plaintext / moderation / embedding columns, and the relay never inspects the bytes. The
  blind *delivery service* is shipped (v0.9.0); the **client-side MLS crypto is a Phase 2/3 deferral**
  (current tests use a mock cipher that is explicitly *not* secure). So the operator-blind *architecture*
  is real now, and the full Signal-grade E2E guarantee **completes when the client crypto lands** — that
  is the bar we're building to and the server already can't read content.
  
  **On self-hosted Agora (especially with Tor), the privacy posture actually *exceeds* Signal's** — not
  only is content encrypted, but *metadata* (who talks to whom, when, connection patterns) stays on
  your infrastructure, never touching a third party. Signal is "content-blind to the operator + metadata-
  visible to Signal Foundation"; self-hosted Agora is "both hidden from everyone but the community."
  See [`SECURE_CHAT.md`](./SECURE_CHAT.md) + [`../CHAT_TODO.md`](../CHAT_TODO.md).
- **Square (feeds, Spaces, follows, reactions, social graph, plaintext chat):** something Signal
  **does not attempt**. It requires a server that can read content to rank, moderate, search, and
  graph. So we do **not** carry Signal's E2E philosophy here — we carry a *different*, weaker-but-still-
  strong guarantee: **invisible to the outside world, readable only by the community that runs it.**

"Signal w/ community" = **Signal-grade chat, bolted onto a community square Signal would never build.**
We claim Signal's bar only where we actually meet it (chat), and we name the square's model honestly
rather than borrowing chat's halo.

---

## 2. The two true floors (no square escapes these)

Some limits are inherent to *any* system that shows plaintext to humans and runs community features.
Signal hits the same floors where they apply. Calling these out matters, because the discipline is to
**never quietly fold an avoidable leak into "inherent."**

1. **Member exfiltration.** Anyone who can *read* a message or post can screenshot it, retype it, or
   photograph the screen with a second device. Disappearing messages and screenshot flags raise the
   *cost*; they do not close the hole. **Signal has the identical floor.** A community is a set of
   humans who can each choose to leak — no protocol fixes that.
2. **Operator-must-read-to-function.** You cannot moderate, rank, embed, or graph ciphertext you can't
   read — not without exotic crypto (homomorphic encryption, TEEs, PIR) that no normal square uses and
   that carries its own caveats. A *functioning* community square therefore requires the operator
   **inside** the trust boundary. This is exactly why secure-chat (which is blind) gives up moderation,
   search, and embeddings — that trade is the point, not a limitation.

Everything else is **a choice**, and choices are where "as private as possible" is earned or lost.

---

## 3. The privacy gradient

The honest picture is a **gradient**, coherent at every tier. Read it as "who can see what":

| Observer | Square (feeds / Spaces / plaintext chat / social graph) | Secure-chat (MLS) |
|---|---|---|
| **Outside world** (with self-host + Tor) | **Nothing** — can't even find the door | **Nothing** — metadata + content both hidden |
| **The host / operator** | *Can* read it — it's their box, and the features require it | **Blind — relays opaque ciphertext** (no plaintext columns; full E2E completes w/ Phase 2/3 client crypto); on self-host, metadata stays with you (exceeds Signal) |
| **Other members** | Per Space read-permissions ([`lib/space-access.ts`](../apps/api/src/lib/space-access.ts)); social-graph surfaces are k-anonymized / dyadic ([`SOCIAL-GRAPH.md`](./SOCIAL-GRAPH.md)) | Only their own MLS group |

The two key reads:

- **Self-host + Tor closes the outsider threat model entirely.** No public DNS, no IP exposure, nothing
  in a CA's certificate-transparency log announcing the community exists, and traffic analysis defeated
  (an observer can't see *that* you connected, let alone to whom). For at-risk communities this is the
  threat model that actually matters.
- **The middle row is the whole subtlety.** Self-host + Tor gives the square **"private from the entire
  world."** Signal's specific, harder promise is **"private even from the operator"** — and *only
  secure-chat keeps that one.* The square is **operator-trusted**; secure-chat is **operator-blind.**
  That's not a contradiction; it's a feature gradient. Claim "Signal-grade" **per surface**, never
  blanket.

---

## 4. Self-host vs. managed hosting — the line that moves the claim

The sentence *"the operator is the community, so no outsider sees the square"* is **only true for
self-host.** This is the single most important caveat, because it collides with Agora's own
managed-hosting roadmap.

- **Self-host (+ Tor):** operator **= the community that owns the box.** "The operator can read the
  square" means "the community can see its own square." The claim holds cleanly (modulo
  [§6](#6-avoidable-daylight--the-roadmap-to-earn-the-banner)). This is the configuration the banner
  is written for. See [`SELF-HOSTING.md`](./SELF-HOSTING.md).
- **Managed hosting (Agora-as-SaaS):** operator **= the hosting provider, NOT the community.** This
  *reintroduces the third-party operator* — precisely the trust problem Signal exists to avoid. In this
  model the square is readable by the hosting company. To keep the self-host claim here you would need
  **per-tenant encryption / confidential compute**, or you accept a weaker tier **and say so plainly.**
  Do not let the self-host banner silently cover the SaaS deployment.

**Rule:** any marketing or docs that say "Signal w/ community" without qualification are describing the
**self-host + Tor** configuration. The managed tier must state its own (weaker, operator-trusted-to-the-
provider) posture explicitly.

---

## 5. What "as private as possible" means beyond the floors

Trusting the operator is **not** the same as trusting "anyone who ever seizes, compromises, or
subpoenas the box." Signal's design religion *below* the E2E line is **minimize what exists to be
taken.** A maximally-private square applies the same religion to everything the operator legitimately
holds:

- **"The operator" is a *set*, not a person** — whoever has DB access, SSH, the backups, the logs, and
  the hosting substrate underneath (unless it's bare metal you own). A rogue admin, a leaked backup, or
  a verbose log line should never see more than the square's function strictly requires.
- **At-rest plaintext widens the blast radius beyond operator-trust.** The square's content *and* its
  derived data — embeddings, the Neo4j social graph, `moderation_analyses`, denormalized counts — sit
  in Postgres/Neo4j. "My operator can read it" (intended) must not quietly become "whoever steals the
  disk can read it" (not intended).
- **Deletion must mean gone — derived data included.** Deleting a post should not leave its embedding,
  its graph edges, its moderation row, or its counts behind.

---

## 6. Avoidable daylight — the roadmap to earn the banner

These are the choices that sit between *today's square* and *the theoretical maximum* given the two
true floors. Each is a checklist item, not an inherent limit. Closing them is how "as private as a
square can be" goes from aspiration to defensible fact.

- [ ] **Encryption at rest** for square content + derived stores (Postgres, Neo4j), so seizure or
      live compromise ≠ operator-trust. (Disk-level encryption helps cold theft; app/column-level is
      stronger against a live breach.)
- [ ] **Retention limits + true deletion of derived data.** *Verified gap:* the primary content row is
      handled — `CONTENT_DELETE_MODE` now defaults to **`hard`**, so by default deleting an
      entity/comment truly `DELETE`s the row, FK-cascades its dependents, and removes its uploaded media
      from storage (`soft` keeps the recoverable `deletedAt` tombstone). But the **derived stores still
      orphan**: `content_embeddings` and `moderation_analyses` have **no FK to the content row** (only to
      `projects`/`spaces`) and the delete handlers don't touch them, and **Neo4j graph edges get no
      cleanup** on content/account deletion — so a hard delete removes the plaintext row while its
      embedding, moderation analysis, and graph edges persist. "Delete means gone" requires propagating
      deletion to all derived stores.
- [ ] **Operator least-privilege** — scope DB-admin roles, lock down backups, audit that **logs never
      carry content**. (Agora's logging discipline already enforces this: `info`/`error` are
      message-only, raw payloads only on `debug` which is off in production — see `CLAUDE.md` →
      *Log with intent*. Keep it that way; treat any content-in-logs regression as a privacy defect.)
- [ ] **Member control over intra-community metadata** — who can see my follows, my activity, my
      presence in the social graph. The Constellation is already k-anonymized and the Neighborhood is
      dyadic ([`SOCIAL-GRAPH.md`](./SOCIAL-GRAPH.md)); extend the principle to member-facing controls.
- [ ] **Tor / onion deployment as a first-class, documented path** — the network-layer guarantee that
      closes the outsider threat model. Document it in [`SELF-HOSTING.md`](./SELF-HOSTING.md).
- [ ] **Managed-tier encryption story** — per-tenant encryption / confidential compute, or an explicit
      published statement of the weaker SaaS posture ([§4](#4-self-host-vs-managed-hosting--the-line-that-moves-the-claim)).

> **Process rule:** every new square feature that reads, derives from, persists, or exposes member
> content gets checked against this table. Which tier does it live in? Does it widen at-rest plaintext?
> Does it leak metadata between members? Does deletion reach its derived data? A feature that can't
> answer those is incomplete — same posture as the security gates in `CLAUDE.md`.

---

## 7. The claim you can defend without flinching

> **Chat is operator-blind by construction (MLS / RFC 9420) — the server stores and relays only
> opaque ciphertext, with no plaintext columns. The blind delivery service ships today; the full
> Signal-grade end-to-end guarantee completes as the client-side MLS crypto lands (Phase 2/3).**
> On self-hosted Agora (especially with Tor), the privacy posture *exceeds* Signal's: not only is
> content encrypted, but metadata stays with you, completely invisible to the outside world.
>
> **The square is maximally private within its function:** invisible to the outside world
> (self-host + Tor), readable only by the community that runs the box — and we minimize everything
> else (at-rest, retention, deletion of derived data, operator scope) so *"the operator can read it"*
> never quietly becomes *"anyone who breaches the box can."*
>
> **The two floors we don't escape — and neither does Signal:** any member who can read can leak, and
> a community square's operator must be able to read content to moderate, rank, and search it. We meet
> Signal's bar exactly where Signal sets it (chat), and we're honest about the square being a different,
> operator-trusted surface.

"Signal w/ community" is the banner. **This table is the fine print.** Keep them both true.

---

## See also

- [`SECURE_CHAT.md`](./SECURE_CHAT.md) — the blind MLS delivery service (the "Signal" half).
- [`SECURITY.md`](./SECURITY.md) — operator hardening, the server-as-trust-boundary model, known limits.
- [`SOCIAL-GRAPH.md`](./SOCIAL-GRAPH.md) — k-anonymity + dyadic-brightness privacy in the social graph.
- [`SELF-HOSTING.md`](./SELF-HOSTING.md) — self-host deployment (where the banner's claim holds).
