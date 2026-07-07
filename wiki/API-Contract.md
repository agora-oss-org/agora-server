# API & Contract

Agora's entire reason to exist is that the forked SDK's typed hooks (`useEntity`, `useComments`,
`useChat`, …) work **unchanged** against your own server. So the API contract is non-negotiable: match
it exactly, or the SDK breaks.

> **The contract is the constraint.** Any change to request/response shapes, REST paths, or socket.io
> events must keep [`agora-sdk`](https://github.com/jenova-marie/agora-sdk) working 1:1.

## The two source-of-truth documents

- **[`docs/MANIFEST.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/MANIFEST.md)** —
  the contract: every REST endpoint (method + path, marked ✅ SDK-confirmed vs 🔶 inferred), the
  socket.io event names, and the auth / pagination / error envelopes. This is the checklist.
- **[`docs/MODELS.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/MODELS.md)** —
  field-level response shapes; the source of truth for both API output and the database schema.

These are mirrored 1:1 by the shared `@agora-server/contract` package (TS types + zod schemas), which
both the server and the admin app consume — so a type can't drift from the docs without the build
noticing.

## Conventions at a glance

- **URL shape is fixed:** `/v7/:projectId/<domain>/...`.
- **Envelopes are contract.** Lists return `{ data, pagination }`; errors return `{ error, code, field? }`.
  (The connections module uses a different pagination shape — see MANIFEST.)
- **Auth:** anonymous reads, authenticated writes. Agora mints short-lived access tokens + rotating
  refresh tokens (see [[Security]]).
- **Realtime is socket.io** — event names stay byte-identical to the SDK's socket types. Beyond chat
  message fan-out, every authenticated socket auto-joins a per-user room and receives a
  `notification:created` event, so the bell/badge updates live for every notification type. The same
  per-user rooms carry a live **conversation inbox** — `conversation:created` plus `message:created`
  fan-out (so a new DM or a reply surfaces without a poll) and connection request/accept notifications.
  Optional cross-replica fan-out via Redis when `REDIS_URL` is set.

## Agora extensions

Beyond the 1:1 Replyke surface, Agora adds first-party domains that follow the same envelopes, auth,
and `/v7/:projectId/...` shape (contract in `docs/MANIFEST.md`):

- **Events** (`§events`) — community events with RSVPs, invites, and co-hosts, visibility-tiered
  (`public | members | invite`). See [[Governance]] for the enforcement model.
- **Push notifications** (`§push-notifications`) — a device registry (Web Push / FCM / APNs) that
  mirrors a push-worthy allowlist of in-app notifications to background sends; gated by the `VAPID_*`
  env trio (see [[Deployment]]). Per-user opt-out preferences (`§push-notifications`) let a user
  disable specific notification types.
- **User matching** (`§match`) — `POST /match/users` currently ships the request contract only
  (validated `passive`/`directed` modes) and always resolves `{ results: [] }`; the real
  facet/embedding matching engine is a future spec.

New contract-affecting behavior is announced in-band: legacy sort aliases (e.g. `sortBy=new`) now emit
an **RFC 8594 `Deprecation`** response header rather than breaking, so SDK consumers get a migration
window.

## Why a fork?

The published Replyke SDK hardcodes `https://api.replyke.com/v7`. `agora-sdk` repoints that base URL;
because it does, the URL shape, token semantics, envelopes, response object shapes, and socket event
names all line up 1:1 with this server. That's the whole point. More in [[Ecosystem]].

## Forward-looking changes

Proposed contract-affecting changes (tagged by compatibility impact) are tracked in
[`docs/PROPOSED.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/PROPOSED.md).
