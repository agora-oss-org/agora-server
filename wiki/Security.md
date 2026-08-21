# Security

Every line of Agora is written security-first, and the **server is the trust boundary**: it talks to
Postgres as the RLS-bypassing owner role and enforces every read/write rule in the handlers, with RLS
underneath as a verified backstop.

> Full posture, threat model, hardening checklist, and known limitations:
> [`docs/SECURITY.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/SECURITY.md).

## Access-control posture

- **Tokens** — short-lived access tokens (30 m) + refresh tokens (30 d) with rotation, reuse-detection,
  and a 30 s racing-tabs grace window. Auth/crypto stays in the vetted libs (jose, pinned alg).
- **Private by default (auth wall)** — every `/v7/:projectId/*` request requires a valid token;
  anonymous → `401`, suspended → `403 auth/suspended`. The only anonymous surface is the pre-sign-in
  allowlist (`/auth/*`, OAuth authorize/callback, `/projects/lean`, the VAPID public key, the dev
  JWT-signing stub); every mutation is (as before) `requireAuth`. See [[API & Contract|API-Contract]].
- **Space privacy** — a members-only space is invisible to non-members on every path (feed, single
  reads, reactions, comment creation, semantic search).
- **Private chat** — conversation messages are readable only by active members, enforced on the REST
  routes *and* inside the search RPC.
- **End-to-end-encrypted secure chat** — an optional, separate surface where the server stores only
  ciphertext, built so it *cannot* read messages at all (deny-all RLS on every secure table).
  ⚠️ **Unaudited** (MLS via `ts-mls`) — don't rely on it where compromise would put someone at risk.
  See [[Secure Chat]].
- **Moderation visibility** — removed content is always hidden from non-privileged readers (omitted from
  lists, 404'd on single reads, filtered in the search RPC); operators bypass to review. See [[Governance]].
- **Operators, owners/admins, stewards** — a deployment-operator allowlist grants a project-wide
  god-view; within-project, DB-backed `owner`/`admin`/`steward` grants form the
  `operator ⊇ owner ⊇ admin ⊇ steward ⊇ member` hierarchy.
- **Native-auth email links fail closed** — the confirm/reset/resend flows refuse to send
  (`503 auth/email-not-configured`) unless `AUTH_EMAIL_LINK_ALLOWED_ORIGINS` is configured, and a
  client-supplied `emailRedirectTo` is validated against that allowlist (a non-listed origin 400s) so a
  link is never built on an unvalidated host — an **open-redirect guard**. See [[Deployment]].
- **Content deletion defaults to hard** (`CONTENT_DELETE_MODE=hard`) — a delete truly removes the row
  *and* its uploaded media from storage, rather than tombstoning and orphaning the objects in the
  bucket. `soft` keeps the recoverable-tombstone behavior. A privacy-forward default; set per deploy.
- **RLS backstop** — since the auth wall, `anon` has no `SELECT` grants at all (the `0008` public-read
  policies were revoked in migration `0064`); `authenticated` still denies any private-space, removed,
  or draft row directly.

## Principles enforced in every change

- Validate **and authorize** on the server for every request; fail **closed**.
- Wire every gate on every new path (`requireAuth`, ownership, space access, moderation visibility).
- Validate input with zod at the boundary; parameterize all SQL; guard outbound fetches against SSRF.
- Never leak secrets, tokens, internal ids, or another user's PII in responses, logs, or errors.

## Reporting a vulnerability

Please report privately — see the disclosure process in
[`docs/SECURITY.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/SECURITY.md)
(GitHub private security advisory + email). Don't open a public issue for a security report.
