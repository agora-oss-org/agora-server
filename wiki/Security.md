# Security

Every line of Agora is written security-first, and the **server is the trust boundary**: it talks to
Postgres as the RLS-bypassing owner role and enforces every read/write rule in the handlers, with RLS
underneath as a verified backstop.

> Full posture, threat model, hardening checklist, and known limitations:
> [`docs/SECURITY.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/SECURITY.md).

## Access-control posture

- **Tokens** — short-lived access tokens (30 m) + refresh tokens (30 d) with rotation, reuse-detection,
  and a 30 s racing-tabs grace window. Auth/crypto stays in the vetted libs (jose, pinned alg).
- **Anonymous reads, authenticated writes** — public content is readable without a token (matching the
  contract); every mutation is `requireAuth`.
- **Space privacy** — a members-only space is invisible to non-members on every path (feed, single
  reads, reactions, comment creation, semantic search).
- **Private chat** — conversation messages are readable only by active members, enforced on the REST
  routes *and* inside the search RPC.
- **End-to-end-encrypted secure chat** — an optional, separate surface where the server stores only
  ciphertext and *cannot* read messages at all (deny-all RLS on every secure table). See [[Secure Chat]].
- **Moderation visibility** — removed content is always hidden from non-privileged readers (omitted from
  lists, 404'd on single reads, filtered in the search RPC); operators bypass to review. See [[Governance]].
- **Operators, owners/admins, stewards** — a deployment-operator allowlist grants a project-wide
  god-view; within-project, DB-backed `owner`/`admin`/`steward` grants form the
  `operator ⊇ owner ⊇ admin ⊇ steward ⊇ member` hierarchy.
- **RLS backstop** — denies `anon`/`authenticated` any private-space, removed, or draft row directly.

## Principles enforced in every change

- Validate **and authorize** on the server for every request; fail **closed**.
- Wire every gate on every new path (`requireAuth`, ownership, space access, moderation visibility).
- Validate input with zod at the boundary; parameterize all SQL; guard outbound fetches against SSRF.
- Never leak secrets, tokens, internal ids, or another user's PII in responses, logs, or errors.

## Reporting a vulnerability

Please report privately — see the disclosure process in
[`docs/SECURITY.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/SECURITY.md)
(GitHub private security advisory + email). Don't open a public issue for a security report.
