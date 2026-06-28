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
  fan-out, every authenticated socket auto-joins a per-user room and receives a `notification:created`
  event, so the bell/badge updates live for every notification type. Optional cross-replica fan-out via
  Redis when `REDIS_URL` is set.

## Why a fork?

The published Replyke SDK hardcodes `https://api.replyke.com/v7`. `agora-sdk` repoints that base URL;
because it does, the URL shape, token semantics, envelopes, response object shapes, and socket event
names all line up 1:1 with this server. That's the whole point. More in [[Ecosystem]].

## Forward-looking changes

Proposed contract-affecting changes (tagged by compatibility impact) are tracked in
[`docs/PROPOSED.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/PROPOSED.md).
