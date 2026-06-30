# Spec D — Push Notifications (FEATURE_MIGRATION §1)

**Date:** 2026-06-29
**Status:** Approved — ready for implementation plan
**Source doc:** `docs/FEATURE_MIGRATION.md` §1 (Push notifications)
**Effort:** Large. Greenfield — new table, a dispatch provider seam (FCM/APNs/Web Push), credential
storage, an unauthenticated VAPID endpoint, and wiring into the notification choke point.

---

## 1. Context & current state

No push code, tables, or dependencies exist. What we can build on:
- **Credential storage:** `project_integrations` table already exists
  (`packages/core/src/db/schema/projects.ts:48-54`) — `(name, data jsonb)` per project; ideal for
  `fcm`/`apns`/`vapid` credential blobs.
- **In-app notifications:** `app_notifications` table + routes
  (`apps/api/src/routes/notifications.ts`) are the existing notification surface — this is the
  **choke point** push will hook into.
- **Provider-seam precedent:** the storage seam (`lib/storage/` — `index.ts` `getStorage()`,
  `provider.ts` interface, `supabase.ts`/`s3.ts`) is the pattern to mirror for the push dispatch seam.
- **Rate limiting:** `lib/rate-limit.ts` + `middleware/rate-limit.ts` for the unauthenticated VAPID
  endpoint.

The SDK registers/deregisters an OS push token per device and fetches the VAPID public key before
sign-in; the **server is solely responsible for actually sending** FCM/APNs/Web Push to offline
recipients.

## 2. Goals

1. Store push device registrations (`push_devices`), upsert on register, idempotent delete on
   deregister, multi-device per user.
2. Serve the VAPID public key unauthenticated (rate-limited).
3. A dispatch seam with **all three** providers (FCM HTTP v1, APNs HTTP/2, Web Push RFC 8030/8292)
   implemented; **Web Push is the end-to-end-testable path** (self-generated VAPID, no paid account).
4. Dispatch on the notification choke point (mirror in-app notifications); prune stale tokens.

**Non-goals:** notification taxonomy redesign (reuse existing `app_notifications` event types); rich
notification preferences UI; Expo relay (the SDK uses **raw** APNs/FCM tokens via
`getDevicePushTokenAsync`, so we dispatch directly — no Expo push service).

## 3. Data model

### 3.1 `push_devices` (new migration; idempotent, ships its own RLS deny-all)

```
push_devices
  id            uuid PK default gen_random_uuid()
  project_id    uuid NOT NULL FK → projects(id) ON DELETE CASCADE
  user_id       uuid NOT NULL FK → profiles(id) ON DELETE CASCADE   -- profiles, per repo convention
  platform      text NOT NULL CHECK (platform IN ('ios','android','web'))
  token         text NULL        -- iOS APNs / Android FCM
  subscription  jsonb NULL       -- web: { endpoint, keys: { p256dh, auth } }
  created_at    timestamptz NOT NULL DEFAULT now()
  updated_at    timestamptz NOT NULL DEFAULT now()

  CHECK ( (platform IN ('ios','android') AND token IS NOT NULL AND subscription IS NULL)
       OR (platform = 'web' AND subscription IS NOT NULL AND token IS NULL) )

  UNIQUE (project_id, user_id, platform, token)            WHERE platform IN ('ios','android')
  UNIQUE (project_id, user_id, (subscription->>'endpoint')) WHERE platform = 'web'
```

The partial-unique-on-expression indexes are custom SQL (Drizzle can't express the web one cleanly) —
hand-write them in the migration. Drizzle schema (`schema/misc.ts` or new `schema/push.ts`) models the
columns; the CHECK + partial uniques live in the migration body.

## 4. REST API (`apps/api/src/routes/push-notifications.ts`, mounted at `/push-notifications`)

- `POST /devices` — `requireAuth`. Body = the `PushDeviceIdentifier` union (native `{platform,token}`
  or web `{platform,subscription}`). **Upsert** (dedupe native on `(project,user,platform,token)`,
  web on `(project,user,endpoint)`), bumping `updated_at`. Response `204`.
- `DELETE /devices` — `requireAuth`. Same union in the body. **Idempotent** (`204` even if unknown).
  Matches native by `(project,user,platform,token)`, web by `(project,user,endpoint)`.
- `POST /devices/deregister` — **proxy-safe fallback** for `DELETE`, identical body + semantics
  (decision §7: some gateways strip DELETE bodies; Caddy doesn't, but the alias is cheap insurance).
- `GET /vapid-public-key` — **UNAUTHENTICATED**, rate-limited. Resolves per-project VAPID public key,
  falling back to the global env key (§5). Response `{ publicKey: string | null }`.

Zod schema for the device-identifier union in `packages/contract`; `parseBody` at the boundary.

## 5. Credentials & VAPID scope (decision resolved)

- **VAPID: per-project with global env fallback.** `getVapidKeys(projectId)` checks
  `project_integrations` (`name='vapid'`) first; if absent, uses deployment env
  (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, validated optional). Single-project self-hosts "just work"
  with one env keypair; multi-tenant can isolate per project. `GET /vapid-public-key` returns the
  resolved public key (or `null` if neither configured — web push simply disabled).
- **FCM / APNs:** credentials in `project_integrations` (`name='fcm'` service-account JSON;
  `name='apns'` `.p8` key + key/team/bundle IDs). Resolved lazily at dispatch time; absent → that
  transport is skipped (fail-safe, logged at `debug`).
- **No secret leakage:** never log credential blobs or tokens; `info`/`error` are message-only,
  raw detail only on `debug` (Log-with-intent policy).

## 6. Dispatch seam (`apps/api/src/lib/push/`, mirrors `lib/storage/`)

- `provider.ts` — `PushProvider` interface: `send(device, payload) → { ok, prune? }`.
- `fcm.ts` — FCM HTTP v1 (OAuth from the service account). `apns.ts` — APNs HTTP/2 (JWT from the
  `.p8`). `webpush.ts` — RFC 8030 + VAPID RFC 8292 (web-push library or hand-rolled aes128gcm).
- `index.ts` — `dispatchToUser(projectId, userId, payload)`: load the user's devices, route each to
  its provider, send to **all** devices, prune on terminal errors.
- **Stale-token pruning:** delete the `push_devices` row on FCM/APNs "not registered" / "unregistered"
  and Web Push `410 Gone` / `404`.
- **Library choice:** prefer maintained libs (`web-push` for web; FCM/APNs via their HTTP APIs with a
  thin client or `firebase-admin`/an APNs lib) — keep auth/crypto in vetted libs per the security
  posture. Decide exact deps in the plan; guard all outbound calls (these are first-party push
  endpoints, not user-controlled URLs, so SSRF guard N/A, but pin hosts).

## 7. Trigger / wiring (decision resolved)

**Mirror in-app notifications.** A single dispatch choke point: `lib/notifications.ts` `insert()` (the
one place every `app_notifications` row is written) calls `dispatchNotificationPush(projectId,
recipientId, type)` after the existing socket fan-out. Self-notify is already skipped upstream in
`insert()` (`recipientId === actorId`), so push inherits that for free. Dispatch is **fire-and-forget**
(don't block the request; log failures at `error` message-only + `debug` detail).

**Push-worthy allowlist (decision §10).** Not every `app_notifications` type is push-worthy. v1 pushes
the human-attention types and **suppresses reactions, reaction-milestones, AND steward events** (kept
in-app only). The allowlist + per-type copy are **one pure function**
(`notificationPushPayload(type) → PushPayload | null`): the allowlist IS the keys of the copy map — it
returns `null` for any type not in the map (the bridge then no-ops), else a PII-free payload whose
title is keyed by type. Pushed types:

```
PUSH:   entity-comment, comment-reply, comment-mention, entity-mention,
        new-follow, connection-request, connection-accepted,
        space-membership-approved
SILENT: entity-upvote, comment-upvote, entity-reaction, comment-reaction,
        entity-reaction-milestone-specific/total, comment-reaction-milestone-specific/total,
        steward-case-opened/-in-mediation/-resolved, steward-content-removed,
        steward-mediation-invite
```

**Steward events are deliberately push-silent** — conflict-resolution is sensitive, a lock-screen push
must never hint a case exists or that content was removed (SECURITY.md; mirrors the PII discipline in
`stewardCaseRecipients`). They remain visible in-app only.

**Per-type copy (decision §10).** Title is keyed by type (`entity-comment → "New comment"`,
`comment-reply → "New reply"`, `*-mention → "You were mentioned"`, `new-follow → "New follower"`,
`connection-request → "New connection request"`, `connection-accepted → "Connection accepted"`,
`space-membership-approved → "Membership approved"`); body is the generic, PII-free `"Open the app to
see what's new."`. Clients deep-link via `data.type`.

Chat-message push is **out of scope for v1** (chat messages don't flow through this `app_notifications`
choke point; wiring chat + its online/offline socket gating is a separate later change — §11).

## 8. Files touched / added

- `packages/core/src/db/schema/push.ts` (or `misc.ts`) — `push_devices` columns.
- `apps/api/drizzle/00xx_push_devices.sql` — **new** migration (table + CHECK + partial uniques + RLS
  deny-all; `when` > journal max).
- `apps/api/src/routes/push-notifications.ts` — **new** router.
- `apps/api/src/lib/push/{index,provider,fcm,apns,webpush}.ts` — **new** dispatch seam.
- `apps/api/src/lib/push/vapid.ts` (or in `index.ts`) — `getVapidKeys()` resolver.
- Notification-creation site(s) (`lib/` around `app_notifications`, chat message create) — call
  `dispatchToUser`.
- `packages/contract` — device-identifier zod + `PushDevice` model (add to `MODELS.md` too).
- `routes/index.ts` — mount `/push-notifications`.
- Env schema (`@agora/core`) — optional `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`.

## 9. Testing (hermetic — providers mocked, no real FCM/APNs/Web Push calls)

- **Unit:** register upsert dedupe (native vs web); delete idempotency + matcher; device-identifier
  parsing/validation; stale-token pruning on the terminal-error codes; `dispatchToUser` fan-out to
  multiple devices routes each to the right (mocked) provider; VAPID resolver per-project→global
  fallback→null.
- **Integration:** `POST/DELETE /devices` + the `/deregister` fallback persist/remove rows scoped by
  project; `GET /vapid-public-key` unauthenticated + rate-limited; the notification choke point calls
  dispatch.

## 10. Decisions (resolved)

- **VAPID scope:** per-project, global env fallback.
- **Trigger taxonomy:** mirror in-app notifications (single choke point at `insert()`).
- **Push-worthy allowlist:** push the human-attention types; **suppress reactions, reaction-milestones,
  and steward events** (in-app only). Allowlist = the keys of the copy map; one pure
  `notificationPushPayload(type) → PushPayload | null` (§7).
- **Per-type copy:** title keyed by type, generic PII-free body. Corrects `follow` → real `new-follow`.
- **Steward events push-silent:** conflict-resolution stays in-app only (never surface a case on a lock
  screen).
- **Chat push:** out of scope for v1 (chat doesn't hit this choke point; deferred with its online-gating).
- **Transports:** all three behind a seam; Web Push is the testable path; FCM/APNs complete but
  exercised once creds exist.
- **Deregister:** DELETE-with-body **plus** a `POST /devices/deregister` fallback.
- Credentials in `project_integrations`; orphan tokens handled by FK cascade on user delete.

## 11. Open questions

- **Resolved — push-worthy types:** push the human-attention allowlist (§7/§10); suppress reactions,
  reaction-milestones, and steward events (in-app only). Self-notify already skipped upstream in `insert()`.
- **Deferred — chat-message push + its online/offline socket gating.** Chat messages don't flow through
  the `app_notifications` choke point, so v1 doesn't push them; a later change wires chat and decides the
  "send only to members whose socket is disconnected" gate.
- **Deferred — per-user push preferences** (mute, quiet hours, per-type opt-out) — a future spec. v1's
  allowlist is the only filter.
- **Deferred — provider-resolution caching (fast-follow perf).** `getProviders` resolves VAPID + FCM +
  APNs from `project_integrations` on every push-worthy notification, and the FCM OAuth access token is
  re-minted per `send`. Mirror `lib/social-config.ts`'s short-TTL per-project cache for the provider map,
  and cache the FCM access token until near expiry. Non-blocking (web path is the only hot one; native is
  credential-gated) — file as a follow-up ticket.
- **Deferred — web-subscription cross-user persistence.** Web uniqueness is `(project, user, endpoint)`,
  so a browser endpoint can persist under two users; if the SDK doesn't deregister on logout, user A's
  stale row keeps delivering A's (generic, PII-free) pushes to a device later used by user B. By design
  (deregister-on-logout is the SDK's job; the generic payload bounds the blast radius), but track it
  alongside logout-deregister behavior.
