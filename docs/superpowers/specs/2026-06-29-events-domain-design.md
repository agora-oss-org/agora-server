# Spec C — Events Domain (FEATURE_MIGRATION §2)

**Date:** 2026-06-29
**Status:** Approved — ready for implementation plan
**Source doc:** `docs/FEATURE_MIGRATION.md` §2 (Events · RSVPs · Invites · Hosts)
**Effort:** Large. Fully greenfield domain — ~16 endpoints, new router, new schema file, 2 migrations
(Drizzle tables + a custom PostGIS migration), image-gallery wiring.

---

## 1. Context & current state

No events code exists. The infra it leans on **does**: the storage facade
(`apps/api/src/lib/storage.ts` + `lib/storage/`) for cover/gallery images, the `files` table
(`packages/core/src/db/schema/misc.ts:49-70`) with the per-domain FK pattern, PostGIS columns kept in
custom SQL migrations (`drizzle/0001_postgis.sql`), the space-access seam
(`apps/api/src/lib/space-access.ts`), and the project-role gates
(`apps/api/src/lib/project-roles.ts` → `isProjectAdmin`). Route mounting is a one-liner in
`apps/api/src/routes/index.ts`.

Source of truth for shapes: SDK `interfaces/models/Event.ts` + `hooks/events/*` (cited in §2 of the
migration doc).

## 2. Goals

A complete Events domain matching the SDK contract 1:1: event CRUD + cancel, RSVPs, invitees, hosts,
a rich filtered list, and image galleries — all behind server-side authorization, space-access, and
moderation-visibility gates.

**Non-goals:** sockets (pure REST per the doc), recurring events, ticketing/payments, calendar feeds.

## 3. Data model

### 3.1 Tables (new schema file `packages/core/src/db/schema/events.ts`)

All `project_id`-scoped (`notNull().references(projects.id, onDelete:"cascade")`), `created_at`/
`updated_at`, soft-delete `deleted_at` (nullable, app-layer filtered).

- **`events`** — columns from `Event.ts`: `id`, `short_id` (unique per project), `user_id` (creator,
  `set null` on delete), `title`, `description`, `start_time`, `end_time`, `timezone`, `type`
  (`online|physical|hybrid`), `url`, `venue_name`, `address`, `space_id` (**soft ref, no FK**),
  `visibility` (`public|members|invite`, default `public`), `status` (`active|cancelled`),
  `allow_maybe`, `guest_list_visible`, `capacity` (null = unlimited), `cover_image_id` (→ a `files`
  row), `metadata` jsonb, `deleted_at`. **`location`** geography(Point,4326) lives **only in the
  custom PostGIS migration**, not in the Drizzle TS schema (mirror `content.ts:33` /
  `0001_postgis.sql`). `rsvp_counts` and `host_ids` are **computed/derived**, not stored columns.
- **`event_rsvps`** — `(id, event_id, user_id, status [going|maybe|not_going], created_at,
  updated_at)`, **UNIQUE (event_id, user_id)**.
- **`event_invites`** — `(id, event_id, user_id, invited_at, created_at, updated_at)`,
  **UNIQUE (event_id, user_id)**.
- **`event_hosts`** — join table `(event_id, user_id, created_at)`, PK or UNIQUE `(event_id,
  user_id)`. **Decision:** join table (not an array column) — enables add/remove + "events where
  userId is host" queries. `Event.hostIds` is derived from it.
- **`files.event_id`** — add nullable FK (`references(events.id, onDelete:"cascade")`) + index
  `files_event_idx`, mirroring the existing `entity_id`/`comment_id` pattern.

### 3.2 Enums (`packages/core/src/db/schema/_shared.ts`)

`event_type`, `event_visibility`, `event_status`, `rsvp_status` pg enums.

### 3.3 Migrations

1. Drizzle-generated: `events`, `event_rsvps`, `event_invites`, `event_hosts`, `files.event_id`,
   enums. Each new table ships its **own explicit RLS deny-all** (new tables are not covered by the
   one-time `0017` guard — see `auth_credentials`/`project_roles` precedent).
2. Custom PostGIS migration: `events.location` geography column + GiST index (idempotent
   `IF NOT EXISTS`, `SET search_path TO public, extensions;`). Both migrations' `when` must exceed the
   journal max watermark.

## 4. REST API (`apps/api/src/routes/events.ts`, mounted at `/events`)

### 4.1 CRUD
- `POST /events` → `Event` (201). JSON or `multipart/form-data` (cover + gallery). Creator
  auto-added as host. `requireAuth` + space posting check if `space_id` set
  (`assertCanPostInSpace`).
- `GET /events/:eventId?include=user,space,files,userRsvp` → `Event` (visibility-gated, §5).
- `GET /events?<filters>` → `PaginatedResponse<Event>` (standard envelope; filters §4.3).
- `PATCH /events/:eventId` → `Event` (scalar set, all optional, **minus `hostIds`**, plus
  `removeImageIds`).
- `DELETE /events/:eventId` → `204` (soft-delete).
- `POST /events/:eventId/cancel` → `Event` (`status:"cancelled"`).

### 4.2 RSVP / Invites / Hosts
- `POST /events/:eventId/rsvp` `{ status }` → `Event` (upsert, one row/user). `DELETE …/rsvp` →
  `Event`. `GET …/rsvps?page&limit&status` → `{ data: EventRsvp[], pagination }`.
- `POST /events/:eventId/invites` `{ userId }` → `Event` (idempotent add, host-only).
  `DELETE …/invites` `{ userId }` → `Event` (also drops invitee's RSVP + revokes invite-visibility
  access). `GET …/invites` → `{ data: EventInvite[], pagination }` (host-only, 403 otherwise).
- `POST /events/:eventId/hosts` `{ userId }` → `Event` (updated `hostIds`). `DELETE …/hosts`
  `{ userId }` → `Event`. **Reject removing the last host** (`events/last-host`).

**Route ordering:** static/sub-resource paths above `/:eventId` where they could collide.

## 5. Authorization & semantics (decisions resolved)

- **Mutate (update/delete/cancel) + manage hosts/invites:** **any host** (creator is auto-host) **+
  project-admin** (`isProjectAdmin` folds in operator/owner). Helper e.g. `requireEventHost(c,
  event)` that also passes for project-admins. Last host cannot be removed.
- **Capacity:** caps **`going` only** — reject a new `going` RSVP with `400` (`events/capacity-full`)
  once going-count == capacity; `maybe`/`not_going` never blocked and never counted. `null` capacity
  = unlimited.
- **`allow_maybe:false`:** `400` (`events/maybe-not-allowed`) on a `maybe` RSVP. Cancelled or past
  events: `400` on any RSVP (`events/rsvp-closed`).
- **RSVP list visibility:** hosts always; non-hosts only when `guest_list_visible:true`, else `403`.
- **`visibility`:**
  - `public` — readable by anyone (subject to space read access if `space_id` set).
  - `members` — **space members if `space_id` set, else any authenticated project member**.
  - `invite` — readable only by invitees (and hosts/admins); `403` on fetch/list for non-invitees.
- **Moderation visibility:** apply `removedPolicy(c)` to event reads (events are moderatable content);
  removed events hidden from non-admins. Wire `excludeRemovedSql`/`shouldHide` as for entities.
- **`locationFilters`:** radius in **km**, evaluated with PostGIS `ST_DWithin` over the geography
  column (consistent with existing PostGIS usage). `latitude`/`longitude`/`radius` from the
  bracket-serialized query params.
- **`cover_image_id`:** points to a `files` row (uploaded with `event_id` + `position`); gallery is
  the set of `files` with that `event_id`.

## 6. Shaping (`lib/shape.ts`)

`shapeEvent(row, { include })` → camelCase, Date→ISO, GeoJSON `location` (`{type:"Point",
coordinates:[lng,lat]}`), derived `hostIds` (from `event_hosts`), computed `rsvpCounts`
(`{going,maybe,not_going}`), `userRsvp` when `include=userRsvp` + authed, batched `user`/`space`/
`files` includes. `shapeEventRsvp`, `shapeEventInvite` for the list endpoints. Counts are derived
per-request via aggregate query (not denormalized columns) — keep the aggregate efficient (single
grouped query per list page).

## 7. Validation (`packages/contract`)

Zod schemas for create/update/list-query/rsvp/invite/host bodies + the `Event`/`EventRsvp`/
`EventInvite` response types (added to `packages/contract`, re-exported by `shape.ts`/`validation.ts`).
`parseBody` at every write boundary; reject unknown/invalid, don't coerce. Bracket-serialized list
filters parsed with the existing filter-parsing approach used by entities
(`lib/entity-filters.ts`).

## 8. Testing

- **Integration** (`test/integration/**`): full CRUD; **negative auth** (non-host can't
  update/delete/cancel/manage; last-host removal rejected; non-invitee 403 on `invite` event;
  guest-list 403); capacity full → 400; `maybe` when `allow_maybe:false` → 400; RSVP/invite/host
  idempotency; `members` visibility resolves space-vs-project correctly; removed event hidden;
  pagination + filters (timeWindow, spaceId, hostId, type, status, location radius).
- **Unit:** event shaper (GeoJSON, derived hostIds, rsvpCounts, userRsvp); capacity predicate;
  visibility predicate; filter parsing.

## 9. Decisions (resolved)

- Mutation/host/invite auth: **any host + project-admin**.
- Capacity: **cap `going` only**; maybe/not_going uncounted.
- `members` visibility: **space members if `spaceId` set, else project members**.
- `hostIds` storage: **`event_hosts` join table**.
- Radius: **km via PostGIS `ST_DWithin`**; `coverImageId` → a `files` row; `invite` → 403 for
  non-invitees; RSVP/invite **idempotent upserts**.

## 10. Open questions

- **`rsvp_counts` performance** at scale — derived aggregate is fine for v1; revisit denormalized
  trigger-maintained counts (like `reaction_counts`) if event RSVP volume is high. Flagged, not
  blocking.
- Whether `timezone` is validated against IANA names server-side (lenient v1: store as-is; validate
  later if needed).
- Notification/push hooks for invites & event changes are **out of scope here** — they belong to
  Spec D's "mirror in-app notifications" choke point if/when product wants event pushes.
