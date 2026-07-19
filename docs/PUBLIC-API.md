# Public API — internet-public entities & comments

The anonymous, read-only slice of Agora: how a post is published to the open internet, and how a
visitor with **no account** reads it and its comment thread.

Agora is private by default. The auth wall (migration `0064`) requires an authenticated account on
every `/v7/:projectId/*` route outside a tiny allowlist. This surface is one deliberate, narrow,
auditable hole in that wall — it exists so a blog, marketing page, or third-party site can embed a
thread that anyone can read.

- **Contract reference:** `docs/MANIFEST.md` §public · **Security posture:** `docs/SECURITY.md`
- **Design rationale:** `docs/superpowers/specs/2026-07-18-internet-public-entities-design.md`
- **Code:** `apps/api/src/routes/public.ts`, `lib/public-access.ts`, `lib/public-cache.ts`

---

## 1. The visibility ladder

Visibility has three rungs. Each is a strict superset of the audience below it.

| Rung | Who can read | Enforced by |
|---|---|---|
| **Private** | active members of the space | `space.reading_permission = 'members'` |
| **Community-public** | any signed-in account on the project | `space.reading_permission = 'anyone'`, behind the auth wall |
| **Internet-public** | anyone, no account | `entities.is_public` + this `/public/*` surface |

**Ladder invariant: internet ⊇ community ⊇ private.** A post may only become internet-public if it
is *already* community-public — spaceless, or in a live space whose `reading_permission = 'anyone'`.

**Why the ladder, and not an override.** We considered letting `public = true` punch through a
members-only space ("unlisted but linkable"). It was rejected on privacy grounds: that thread's
comments were written by members under an expectation of privacy, and publishing the post would
retroactively expose their words to the world. The ladder structurally eliminates that — a
publishable post's thread was *never* private, so there is no retroactive-exposure question and no
per-comment consent question.

---

## 2. Publishing — the write side

```
PATCH /v7/:projectId/entities/:id/visibility
```

Lives on the **walled** entities router and requires auth. It is a dedicated action rather than a
field on `PATCH /entities/:id` because its authority model is different: privileged, not owner.
(Named `/visibility`, not `/publish` — `/publish` is draft-publishing — and deliberately not
`/public`, to avoid confusion with the anonymous `/public/*` read namespace.)

**Body** — `{ "public": boolean }` · **Returns** — the shaped `Entity`

### Who may flip it

| Principal | May publish? |
|---|---|
| Platform operator | ✅ (folded into `isProjectAdmin`) |
| Project owner / admin | ✅ |
| Space **owner** | ✅ |
| Space member with role `admin` | ✅ |
| Space member with role `moderator` | ❌ |
| The entity's **author** | ❌ |
| Ordinary member / non-member | ❌ |

Authors do not publish their own posts. For a spaceless entity there is no space admin, so the gate
reduces to operator / project-admin.

### Errors

| Status | Code | When |
|---|---|---|
| `400` | `entities/invalid-body` | body fails the zod schema (carries `field`) |
| `400` | `entities/not-community-public` | `public: true` on an entity in a members-only or deleted space |
| `403` | `entities/not-authorized` | caller **can** read the entity but may not publish it |
| `404` | `entities/not-found` | nonexistent, malformed id, soft-deleted, or **the caller cannot read it** |

**No existence oracle.** A caller with no read access to a members-only space's entity gets the same
`404` a nonexistent id gets — never `403`. `403` is only ever returned once existence is already
known to the caller on their own rung. Membership counts only while the space is live: a former
member of a since-deleted members-only space gets `404`, matching the walled read.

**Un-publishing is never blocked.** `public: false` always succeeds for the authorized set, including
after the space has since gone members-only. Only `public: true` is ladder-validated.

Moderation-removed entities are gated the same way the walled single-entity read is: a space
owner/admin gets `404`; operators and project-admins (who review via the admin queue) still succeed.

---

## 3. Reading — the anonymous `/public/*` surface

All routes are **GET-only, anonymous, read-only**. Mounted at `/v7/:projectId/public/*`; `"/public/"`
is the only project-scoped prefix on `AUTH_WALL_ALLOWLIST` besides `/auth/`.

Nothing here branches on the caller's identity. A signed-in user hitting `/public/*` gets exactly
what a stranger gets — privileged users read via the normal walled surface.

### `GET /public/entities/:id`

Returns the shaped `Entity`.

| Query | Notes |
|---|---|
| `include` | comma-separated; `user`, `files` |

### `GET /public/entities/by-foreign-id`

Resolves a published anchor by the host app's own key, so an embed can address it with the stable
handle it already uses on the walled surface instead of a per-install uuid. Returns the same shaped
`Entity` as `/public/entities/:id`, through the same gate.

| Query | Notes |
|---|---|
| `foreignId` | **required**; missing → `400 entities/missing-foreign-id` |
| `include` | comma-separated; `user`, `files` |

**No `createIfNotFound`.** The walled route's flag lazily *inserts* an authorless anchor; honouring
it on an unauthenticated read-only surface would hand anonymous callers a row-creation primitive. An
unknown `foreignId` simply `404`s.

### `GET /public/entities/:id/comments`

One-level comment list — top-level by default, or the replies under `parentId`. Mirrors the walled
`GET /comments?entityId=`.

| Query | Default | Notes |
|---|---|---|
| `parentId` | *(none)* | page replies under a comment; **malformed → `404`**, never `500` |
| `page` | `1` | |
| `limit` | `20` | clamped to `100` |
| `sortBy` | `createdAt` | `createdAt`, `top`, `controversial`. Legacy `new`/`old` still work but emit an RFC 8594 `Deprecation` header |
| `sortDir` | `desc` | applies to `sortBy=createdAt` |
| `include` | *(none)* | `user` |

Returns the standard envelope:

```json
{ "data": [ /* Comment */ ],
  "pagination": { "page": 1, "pageSize": 20, "totalPages": 3, "totalItems": 47, "hasMore": true } }
```

### `GET /public/entities/:id/comments/thread`

The full nested subtree via the `fetch_comment_thread` RPC. Mirrors the walled
`GET /comments/thread`.

| Query | Default | Notes |
|---|---|---|
| `rootId` | *(whole thread)* | subtree root. `parentId` is accepted as an alias. A malformed value is treated as **absent** (serves the whole thread) rather than erroring |
| `limit` | `50` | clamped to `100` |
| `page` | `1` | translated to an offset |
| `include` | *(none)* | `user` |

Returns `{ "data": [ /* Comment & { replies: Comment[] } */ ] }` — **no pagination envelope**, nested
`replies` arrays, parents always before children.

---

## 4. The gate

Every route runs the gate **independently** — no route trusts that another ran first.
`assertEntityInternetPublic` (by uuid) and `assertForeignIdInternetPublic` (by host key) differ only
in the lookup predicate; both funnel into the same check and the same `404`. It passes only if, live:

```
entity exists in this project
AND entity.is_public = true
AND entity.deleted_at IS NULL
AND entity.is_draft = false
AND entity.moderation_status IS DISTINCT FROM 'removed'
AND ( entity.space_id IS NULL
      OR (space exists AND space.deleted_at IS NULL
          AND space.reading_permission = 'anyone') )
```

Anything else → `404 entities/not-found`.

**404, never 403.** The anonymous surface must never reveal that a non-public entity exists.

**Live and fail-closed.** The conjunction is re-derived on every request and is never cached. A
moderation removal, a soft-delete, re-drafting, or flipping the space to members-only un-exposes the
post *even while `is_public` is still `true`* — the stale flag is harmless because it is never the
sole condition. Un-publishing does not require a cleanup pass.

**Malformed input 404s.** A non-UUID entity id (or `parentId`) is rejected before it reaches
Postgres. This surface is probed by anonymous strangers; an invalid `::uuid` cast would otherwise
surface as a `500` and hand them a free error-log generator.

### Comment visibility

- **Removed comments are always hidden** — an anonymous caller is by definition not privileged, so
  the list filters them in SQL and the thread passes `p_hide_removed => true`, which prunes removed
  comments *and their descendant subtrees* (a post-filter would orphan the children).
- **Deleted comments** are excluded by the RPC (`deleted_at IS NULL`); author-deleted ones are
  blanked in place by the shaper (Reddit-style placeholder), exactly as on the walled surface.

---

## 5. Response shapes

Shapes come from the same `shapeEntity` / `shapeComment` used by the walled surface, so types are
identical. Three differences in the *content*:

| Field | On this surface | Why |
|---|---|---|
| `userReaction` | always `null` | no viewer to attribute a reaction to |
| `user.birthdate` | always `null` | least-privilege: not for the open internet |
| `user.metadata` | always `{}` | free-form profile jsonb, ditto |

The redaction (`redactPublicUser`) is applied at **all three** `?include=user` sites. The internet
still gets `username`, `name`, `avatar`, and `bio`.

Per-space reputation (`?spaceReputation*`) is **not** supported here — those params are accepted and
ignored, not rejected.

---

## 6. CORS

`/public/*` responses set `Access-Control-Allow-Origin: *` and never credentials. Third-party
origins embedding a thread is the entire point. The rest of the API keeps the configured
`CORS_ORIGIN`.

This is wired in **two** places, both required:

1. A post-`next()` override in `routes/public.ts` for normal responses.
2. A matching case in the app-level `cors()` origin callback in `app.ts` — because hono's `cors()`
   answers `OPTIONS` itself and returns `204` **without calling `next()`**, so the route-local
   override never runs for a **preflight**. Under a non-`*` `CORS_ORIGIN` an embed would otherwise
   see no matching ACAO and the browser would block the real request.

Unlike the rest of the API, this prefix emits **no `Vary: Origin`** — its ACAO is unconditionally
`*`, so varying by origin would only fragment shared caches one entry per embedding site.

---

## 7. Caching

Success responses carry:

```
Cache-Control: public, max-age=0, s-maxage=300, must-revalidate
ETag: "…"
```

| Directive | Effect |
|---|---|
| `max-age=0` | **browsers revalidate every read** — a reload is always authoritative |
| `s-maxage=300` | shared caches (CDN/proxy) may serve a stored copy for up to 5 minutes |
| `must-revalidate` | once stale, a cache must reach the origin; never serve stale on error |

A matching `If-None-Match` returns a bodyless `304` that retains its `Cache-Control`,
`Access-Control-Allow-Origin: *`, and `X-Source-Code` (AGPL §13), so cross-origin revalidation
works.

**Error responses are `no-store`** — API-wide, but it matters most here: the gate `404`s a
not-yet-published entity, and a shared cache holding that `404` would keep a freshly-published post
invisible at the edge for the whole window, making publishing look broken.

> ⚠️ **Takedown window.** The gate itself is never cached and `max-age=0` keeps every reader's reload
> current, so an un-publish / moderation removal / space-flip is **instant at the origin and for any
> reader who reloads**. But a shared cache may keep serving a stored copy for **up to 300s**
> afterward. This is a ratified, bounded amendment to the original "live, no cache" design property.
> Deployments needing hard-instant takedown should front the surface with a purgeable cache, or drop
> `s-maxage`.

---

## 8. Rate limiting

The shared `/v7/*` IP-keyed limiter (`lib/rate-limit.ts`) covers this prefix — but only when
`RATE_LIMIT_MAX` is configured. **Unset, anonymous internet-public reads are unlimited**, like every
other route. There is no stricter per-route cap here in v1; if scraping becomes a problem, one can be
added the way `/auth/*` has one.

---

## 9. Not included

Deliberate v1 omissions, not oversights:

- **No writes.** No reactions, no comment creation, no reporting. GET only.
- **No single-comment permalink.**
- **No discovery listing.** There is no "all public posts" endpoint at space or project level. The
  surface is **by-direct-link only** — you must already know the entity's uuid *or* its `foreignId`.
  Note the softening: because `foreignId` is chosen by the host app it is often guessable
  (`homepage-comments`, `blog-post-1`), so published entities are enumerable by probing keys in a
  way uuids prevented. Accepted deliberately — the gate is unchanged, so probing can only ever
  surface content someone explicitly published, and a miss is the same `404` as a non-public hit, so
  no unpublished row is reachable. If you want a published entity to stay hard to find, address it
  by uuid and give it an unguessable `foreignId` (or none).
- **No author "request to publish" flow.** An author asking a steward/admin to publish is a designed
  but unbuilt v2 that would reuse the steward caseload pattern.

### SDK consumption

The forked SDK (`../agora-sdk`) **cannot currently consume this surface.** Its hooks hardcode the
walled paths (`useFetchManyComments` → `/{pid}/comments?entityId=`), and `useCommentSectionData`
bundles reads, writes, reactions, and identity into one hook with no read-only mode. An anonymous
embed therefore needs new hooks in the SDK repo — not a server change. The payloads themselves are
already near-identical to the walled surface for a non-privileged viewer.

---

## 10. Trying it locally

`pnpm seed` (from `apps/api`, with the server running) publishes one entity: the **homepage anchor**,
`foreignId: "homepage-comments"`, seeded with a short thread including a nested reply. It's published
through the real `PATCH /entities/:id/visibility` action, so the seed exercises the same authority
and ladder checks a human operator hits.

Its uuid is generated per install, so address it by `foreignId` — that handle is stable everywhere:

```bash
PID=11111111-1111-1111-1111-111111111111
PUB="localhost:4000/v7/$PID/public"

# resolve the anchor by its stable key (no token, no account)
curl -s "$PUB/entities/by-foreign-id?foreignId=homepage-comments&include=user"

# then use the uuid it returns for the thread
EID=$(curl -s "$PUB/entities/by-foreign-id?foreignId=homepage-comments" | jq -r .id)
curl -s  "$PUB/entities/$EID/comments"
curl -s  "$PUB/entities/$EID/comments/thread"
curl -sI "$PUB/entities/$EID"          # Cache-Control + ETag, no Vary
```

The seeder prints the same URLs on the last lines of its output if you'd rather copy them.

The same entity behind the wall (`GET /v7/$PID/entities/$EID`, no token) still returns `401` — the
hole is the `/public/` prefix, not the entity. See `apps/api/README.md` → Seeding for the manifest
fields (`public`, pinned `id`) and their constraints.

## 11. Related

| Doc | Covers |
|---|---|
| `docs/MANIFEST.md` §public | the endpoint contract, in the canonical REST table |
| `docs/MODELS.md` | the `Entity.public` field and full response shapes |
| `docs/SECURITY.md` | the auth wall, both deliberate holes, and the takedown window |
| `wiki/API-Contract.md` | consumer-facing summary |
