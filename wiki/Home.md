# Agora — the open social layer

> *Own your community.*

**Agora is an open-source, self-hosted community & social backend that's 1:1-compatible with the
Replyke SDK.** It implements the same API the SDK speaks, so the
[`agora-sdk`](https://github.com/jenova-marie/agora-sdk) (a repointed fork of the Replyke SDK) talks
to **your** server instead of `api.replyke.com` — byte-for-byte the same REST paths, response shapes,
auth semantics, and socket.io events. You keep
Replyke's feature set (posts, threaded comments, reactions & feeds, follows & connections, nested
spaces, real-time chat, notifications, moderation & stewardship, semantic search) and run it on
infrastructure you control, under **AGPL-3.0**.

---

## Start here

- **[[Getting Started]]** — clone, install, configure `.env`, run the API locally.
- **[[Architecture]]** — the monorepo, the request flow, and the server-as-trust-boundary model.
- **[[Deployment]]** — the two-axis Docker Compose profile model and every deploy recipe.

## The four pillars

Agora is opinionated about four things most community backends treat as someone else's problem:

1. **Governance is first-class, not a bolt-on.** Moderation queues, an AI moderator, and a full
   **stewardship** conflict-resolution caseload ship in the box, enforced at the server trust boundary.
   → **[[Governance]]**
2. **Private means private — end-to-end-encrypted chat.** A blind MLS (RFC 9420) delivery service that
   stores and relays only ciphertext; the server *cannot* read messages. → **[[Secure Chat]]**
3. **Your social graph, pointed back at the community — not at you.** An optional, off-by-default Neo4j
   layer ("the Garden") that renders community health as warmth, with friction quarantined and decaying.
   → **[[Social Graph]]**
4. **The contract is the constraint.** Every REST path, envelope, and socket event matches the SDK 1:1,
   or the SDK's typed hooks break. → **[[API & Contract|API-Contract]]**

## Operate & contribute

- **[[Security]]** — the access-control posture and how to report a vulnerability.
- **[[Ecosystem]]** — the three separate repos (server · SDK · demo) and why the fork exists.
- **[[Contributing]]** — how to jump in.

---

*This page is generated from [`wiki/Home.md`](https://github.com/agora-oss-org/agora-server/blob/root/wiki/Home.md)
in the main repo — edit it there, not here.*
