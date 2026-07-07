// /v7/:projectId/events/* — events, RSVPs, invites, hosts (SDK v7.6.2). Pure REST (no sockets).
import { Hono } from "hono";
import { and, eq, isNull, inArray, sql, count, asc, desc, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import { events, eventHosts, eventRsvps, eventInvites, spaceMembers, spaces, profiles } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { parseBody } from "../lib/validation.js";
import { createEventSchema, updateEventSchema, rsvpSchema, eventUserIdSchema, eventTypeEnum, eventStatusEnum, rsvpStatusEnum } from "@agora-server/contract";
import { shapeEvent, shapeEventRsvp, shapeEventInvite, generateShortId, loadUsers, parseInclude } from "../lib/shape.js";
import { isProjectAdmin } from "../lib/project-roles.js";
import { removedPolicy, shouldHide } from "../lib/moderation-visibility.js";
import { env } from "../lib/env.js";
import { collectFileRows, removeMediaAsync } from "../lib/storage-cleanup.js";
import { assertCanPostInSpace, assertCanReadSpace } from "../lib/space-access.js";
import { isEventHost, canViewEvent, canRsvpGoing, wouldOrphanHosts } from "../lib/events-policy.js";
import { storeImageFromUpload } from "../lib/images.js";
import { logger } from "../lib/logger.js";

type EventRow = typeof events.$inferSelect;

// ── shared helpers ───────────────────────────────────────────────────────────
export async function getEventOr404(c: any, id: string): Promise<EventRow> {
  const [row] = await getDb().select().from(events)
    .where(and(eq(events.projectId, c.var.projectId), eq(events.id, id), isNull(events.deletedAt))).limit(1);
  if (!row) throw Errors.notFound("events/not-found", "Event not found");
  return row;
}

export async function loadHostIds(eventId: string): Promise<string[]> {
  const rows = await getDb().select({ userId: eventHosts.userId }).from(eventHosts)
    .where(eq(eventHosts.eventId, eventId)).orderBy(asc(eventHosts.createdAt));
  return rows.map((r) => r.userId);
}

export async function loadRsvpCounts(eventId: string): Promise<{ going: number; maybe: number; not_going: number }> {
  const rows = await getDb().select({ status: eventRsvps.status, n: count() }).from(eventRsvps)
    .where(eq(eventRsvps.eventId, eventId)).groupBy(eventRsvps.status);
  const out = { going: 0, maybe: 0, not_going: 0 };
  for (const r of rows) (out as any)[r.status] = r.n;
  return out;
}

export async function loadLocation(eventId: string): Promise<{ lat: number; lng: number } | null> {
  const res = (await getDb().execute(sql`
    select ST_Y(location::geometry) as lat, ST_X(location::geometry) as lng
    from events where id = ${eventId}::uuid and location is not null
  `)) as unknown as { lat: number; lng: number }[];
  return res[0] ? { lat: Number(res[0].lat), lng: Number(res[0].lng) } : null;
}

// Is the caller a member for `visibility:"members"`? space members if spaceId set, else any authed user.
export async function isMemberForEvent(c: any, row: EventRow): Promise<boolean> {
  const uid = c.var.auth?.userId;
  if (!uid) return false;
  if (!row.spaceId) return true; // project member = any authenticated user
  const [m] = await getDb().select({ id: spaceMembers.id }).from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, row.spaceId), eq(spaceMembers.userId, uid), eq(spaceMembers.status, "active"))).limit(1);
  if (m) return true;
  const [s] = await getDb().select({ userId: spaces.userId }).from(spaces).where(eq(spaces.id, row.spaceId)).limit(1);
  return !!s && s.userId === uid;
}

// Assert every supplied userId is a real profile IN THIS PROJECT before a host/invite write. The
// event_hosts/event_invites FKs reference profiles.id but are NOT project-scoped, so a raw insert
// would 500 on a non-existent id and — worse — silently accept a profile id from ANOTHER project
// (a cross-tenant leak). Reject with a clean 400 instead. Trust boundary is the server.
export async function assertProfilesInProject(projectId: string, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  const rows = await getDb().select({ id: profiles.id }).from(profiles)
    .where(and(eq(profiles.projectId, projectId), inArray(profiles.id, ids)));
  const found = new Set(rows.map((r) => r.id));
  if (ids.some((id) => !found.has(id))) {
    throw Errors.badRequest("events/invalid-user", "No such user in this project", "userId");
  }
}

export async function isInvited(eventId: string, userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const [r] = await getDb().select({ id: eventInvites.id }).from(eventInvites)
    .where(and(eq(eventInvites.eventId, eventId), eq(eventInvites.userId, userId))).limit(1);
  return !!r;
}

// Throws if the caller may not VIEW this event — the shared visibility gate used by GET /:eventId
// AND every per-event read/write that returns event data (RSVP set/withdraw, guest-list read). Mirrors
// GET /:eventId exactly: removed → 404, space-read gate, then the per-row visibility predicate.
export async function assertCanViewEvent(c: any, row: EventRow): Promise<void> {
  const removed = await removedPolicy(c);
  if (shouldHide(removed, row.moderationStatus)) throw Errors.notFound("events/not-found", "Event not found");
  const isAdmin = !!(c.var.auth && isProjectAdmin(c.var.auth));
  if (row.spaceId && !isAdmin) {
    // The event's space must be LIVE. A soft-deleted (or missing) space hides the event from the list
    // (spaceReadable requires `deleted_at is null`), so single-GET must 404 to match — otherwise an
    // orphaned event leaks on direct fetch. Admins/operators bypass (they manage orphaned content).
    const [live] = await getDb().select({ id: spaces.id }).from(spaces)
      .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, row.spaceId), isNull(spaces.deletedAt))).limit(1);
    if (!live) throw Errors.notFound("events/not-found", "Event not found");
  }
  if (row.spaceId) await assertCanReadSpace(c, row.spaceId); // space read gate first
  const hostIds = await loadHostIds(row.id);
  const isHostOrAdmin = !!(c.var.auth && (isProjectAdmin(c.var.auth) || isEventHost(hostIds, c.var.auth.userId)));
  const visible = canViewEvent(row, {
    isAuthed: !!c.var.auth, isHostOrAdmin,
    isMember: await isMemberForEvent(c, row),
    isInvited: await isInvited(row.id, c.var.auth?.userId),
  });
  if (!visible) throw Errors.forbidden("events/not-visible", "You don't have access to this event");
}

// Throws 403 unless the caller is a host or a project-admin.
export function requireEventManage(c: any, hostIds: string[]): void {
  const auth = c.var.auth;
  if (auth && (isProjectAdmin(auth) || isEventHost(hostIds, auth.userId))) return;
  throw Errors.forbidden("events/not-host", "Only a host or admin can manage this event");
}

// Assemble the full Event response (hostIds, rsvpCounts, location, optional includes).
export async function buildEventResponse(c: any, row: EventRow, opts: { include?: Set<string> } = {}) {
  const [hostIds, rsvpCounts, location] = await Promise.all([loadHostIds(row.id), loadRsvpCounts(row.id), loadLocation(row.id)]);
  const include = opts.include ?? new Set<string>();
  let userRsvp: string | null | undefined;
  if (include.has("userRsvp") && c.var.auth?.userId) {
    const [r] = await getDb().select({ status: eventRsvps.status }).from(eventRsvps)
      .where(and(eq(eventRsvps.eventId, row.id), eq(eventRsvps.userId, c.var.auth.userId))).limit(1);
    userRsvp = r?.status ?? null;
  }
  let user: unknown;
  if (include.has("user") && row.userId) {
    const um = await loadUsers(c.var.projectId, [row.userId]);
    user = um.get(row.userId) ?? null;
  }
  return shapeEvent(row, { hostIds, rsvpCounts, location, ...(userRsvp !== undefined ? { userRsvp } : {}), ...(user !== undefined ? { user } : {}) });
}

// Set the PostGIS location from a {latitude, longitude} input (or clear it when null).
export async function writeLocation(eventId: string, loc: { latitude: number; longitude: number } | null | undefined) {
  if (loc === undefined) return;
  if (loc === null) { await getDb().execute(sql`update events set location = null where id = ${eventId}::uuid`); return; }
  await getDb().execute(sql`update events set location = ST_SetSRID(ST_MakePoint(${loc.longitude}, ${loc.latitude}), 4326)::geography where id = ${eventId}::uuid`);
}

// Pull scalar event fields out of a multipart form (cover/gallery handled separately).
function parseMultipartEventFields(form: Record<string, unknown>): Record<string, unknown> {
  const str = (k: string) => { const v = form[k]; return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined; };
  const json = (k: string) => { const s = str(k); if (s === undefined) return undefined; try { return JSON.parse(s); } catch { return undefined; } };
  return {
    title: str("title"), startTime: str("startTime"), type: str("type"), description: str("description"),
    endTime: str("endTime"), timezone: str("timezone"), url: str("url"), venueName: str("venueName"),
    address: str("address"), location: json("location"), spaceId: str("spaceId"), visibility: str("visibility"),
    capacity: json("capacity"), allowMaybe: json("allowMaybe"), guestListVisible: json("guestListVisible"),
    hostIds: json("hostIds"), metadata: json("metadata"),
  };
}

export const eventRoutes = new Hono<{ Variables: Variables }>()
  .post("/", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const userId = c.var.auth!.userId;
    const contentType = c.req.header("content-type") ?? "";
    const isMultipart = contentType.includes("multipart/form-data");
    let coverFiles: File[] = [], galleryFiles: File[] = [];
    let coverOpts: Record<string, unknown> = {}, galleryOpts: Record<string, unknown> = {};
    let rawBody: Record<string, unknown>;
    if (isMultipart) {
      const form = await c.req.parseBody({ all: true });
      rawBody = parseMultipartEventFields(form);
      const cv = form["cover"]; coverFiles = (Array.isArray(cv) ? cv : cv ? [cv] : []).filter((f): f is File => typeof f !== "string");
      const gl = form["gallery"]; galleryFiles = (Array.isArray(gl) ? gl : gl ? [gl] : []).filter((f): f is File => typeof f !== "string");
      if (typeof form["cover.options"] === "string") { try { coverOpts = JSON.parse(form["cover.options"] as string); } catch { /* ignore */ } }
      if (typeof form["gallery.options"] === "string") { try { galleryOpts = JSON.parse(form["gallery.options"] as string); } catch { /* ignore */ } }
    } else {
      rawBody = await c.req.json().catch(() => ({}));
    }
    const body = parseBody(createEventSchema, rawBody, "events");
    await assertCanPostInSpace(c, body.spaceId ?? null); // enforce space posting permission if attached
    // Validate supplied co-hosts are real in-project profiles BEFORE any write (no orphan event on reject).
    if (body.hostIds?.length) await assertProfilesInProject(projectId, body.hostIds);

    const [row] = await getDb().insert(events).values({
      projectId, userId, shortId: generateShortId(),
      title: body.title, description: body.description ?? null,
      startTime: new Date(body.startTime), endTime: body.endTime ? new Date(body.endTime) : null,
      timezone: body.timezone ?? null, type: body.type, url: body.url ?? null,
      venueName: body.venueName ?? null, address: body.address ?? null, spaceId: body.spaceId ?? null,
      visibility: body.visibility ?? "public", capacity: body.capacity ?? null,
      allowMaybe: body.allowMaybe ?? true, guestListVisible: body.guestListVisible ?? true,
      metadata: body.metadata ?? undefined,
    }).returning();
    if (!row) throw Errors.badRequest("events/create-failed", "Insert returned no row");
    await writeLocation(row.id, body.location);

    // Hosts: creator + any supplied hostIds (deduped). Creator is always a host.
    const hostIds = [...new Set([userId, ...(body.hostIds ?? [])])];
    await getDb().insert(eventHosts).values(hostIds.map((uid) => ({ projectId, eventId: row.id, userId: uid }))).onConflictDoNothing();

    // Cover (first) + gallery images → files rows linked by event_id; cover_image_id points to the cover file.
    let coverImageId: string | null = null;
    for (const file of coverFiles) {
      const { fileRow } = await storeImageFromUpload({ projectId, userId, file, optionsBody: coverOpts, assoc: { eventId: row.id } });
      coverImageId = fileRow.id; break; // one cover
    }
    for (const file of galleryFiles) {
      await storeImageFromUpload({ projectId, userId, file, optionsBody: galleryOpts, assoc: { eventId: row.id } });
    }
    if (coverImageId) await getDb().update(events).set({ coverImageId }).where(eq(events.id, row.id));

    const [fresh] = await getDb().select().from(events).where(eq(events.id, row.id)).limit(1);
    logger.info({ projectId, eventId: row.id, userId, spaceId: row.spaceId ?? null, hosts: hostIds.length }, "event: created");
    return c.json(await buildEventResponse(c, fresh!), 201);
  })
  .get("/", async (c) => {
    // List with filters: page/limit, sortBy (startTime|going), sortDir, timeWindow, spaceId, hostId,
    // type, status, startsAfter/Before, locationFilters[latitude|longitude|radius] (km).
    const projectId = c.var.projectId;
    const { page, limit, offset } = readPagination(c);
    const q = (k: string) => { const v = c.req.query(k); return v && v !== "null" && v !== "undefined" ? v : undefined; };
    const conds: SQL[] = [eq(events.projectId, projectId), isNull(events.deletedAt)];
    if (q("spaceId")) conds.push(eq(events.spaceId, q("spaceId")!));
    // Validate enum filters against the contract enum BEFORE the ::cast — a bad value is a client
    // error (clean 400), not a Postgres invalid-enum 500. Reject, don't coerce.
    const typeQ = q("type");
    if (typeQ !== undefined) {
      if (!eventTypeEnum.safeParse(typeQ).success) throw Errors.badRequest("events/invalid-filter", "Invalid 'type' filter", "type");
      conds.push(sql`${events.type} = ${typeQ}::event_type`);
    }
    const statusQ = q("status");
    if (statusQ !== undefined) {
      if (!eventStatusEnum.safeParse(statusQ).success) throw Errors.badRequest("events/invalid-filter", "Invalid 'status' filter", "status");
      conds.push(sql`${events.status} = ${statusQ}::event_status`);
    }
    if (q("startsAfter")) conds.push(sql`${events.startTime} >= ${q("startsAfter")}::timestamptz`);
    if (q("startsBefore")) conds.push(sql`${events.startTime} <= ${q("startsBefore")}::timestamptz`);
    const tw = q("timeWindow");
    if (tw === "upcoming") conds.push(sql`${events.startTime} > now()`);
    else if (tw === "past") conds.push(sql`coalesce(${events.endTime}, ${events.startTime}) < now()`);
    else if (tw === "ongoing") conds.push(sql`${events.startTime} <= now() and coalesce(${events.endTime}, ${events.startTime}) >= now()`);
    if (q("hostId")) conds.push(sql`exists (select 1 from event_hosts h where h.event_id = ${events.id} and h.user_id = ${q("hostId")}::uuid)`);
    const lat = q("locationFilters[latitude]"), lng = q("locationFilters[longitude]"), radiusKm = q("locationFilters[radius]");
    if (lat && lng && radiusKm) {
      conds.push(sql`location is not null and ST_DWithin(location, ST_SetSRID(ST_MakePoint(${Number(lng)}, ${Number(lat)}), 4326)::geography, ${Number(radiusKm) * 1000})`);
    }
    // Hide removed events from non-admins.
    const removed = await removedPolicy(c);
    if (!removed.privileged) conds.push(sql`(${events.moderationStatus} is null or ${events.moderationStatus} <> 'removed')`);
    // Visibility: anonymous/non-members only see public events; admins see all. (Per-row invite/members
    // refinement is enforced on single GET; the list shows public + the caller's own visible set.)
    if (!(c.var.auth && isProjectAdmin(c.var.auth))) {
      const uid = c.var.auth?.userId ?? null;
      // Can the caller READ the event's space? (mirrors assertCanReadSpace / readableEntitiesFilter):
      // space null, OR readingPermission='anyone', OR the caller owns / actively belongs to the space.
      // Fail closed for anonymous.
      const spaceReadable = uid
        ? sql`(${events.spaceId} is null or exists (select 1 from spaces s where s.id = ${events.spaceId} and s.deleted_at is null and (s.reading_permission = 'anyone' or s.user_id = ${uid}::uuid or exists (select 1 from space_members m where m.space_id = s.id and m.user_id = ${uid}::uuid and m.status = 'active'))))`
        : sql`(${events.spaceId} is null or exists (select 1 from spaces s where s.id = ${events.spaceId} and s.deleted_at is null and s.reading_permission = 'anyone'))`;
      // The space-read gate applies to EVERY event with a space (single-GET runs assertCanReadSpace
      // for all visibilities, before the host short-circuit), so AND spaceReadable across the whole
      // visibility predicate — not just the public branch. Otherwise the list is more permissive than
      // single-GET (e.g. an invitee or host who can't read a members-reading space would see the row
      // here but 403 on the single fetch). Fail closed.
      conds.push(uid
        ? sql`(${spaceReadable} and (${events.visibility} = 'public'
            or (${events.visibility} = 'members' and (${events.spaceId} is null or exists (select 1 from space_members m where m.space_id = ${events.spaceId} and m.user_id = ${uid}::uuid and m.status = 'active') or exists (select 1 from spaces s where s.id = ${events.spaceId} and s.user_id = ${uid}::uuid)))
            or (${events.visibility} = 'invite' and exists (select 1 from event_invites i where i.event_id = ${events.id} and i.user_id = ${uid}::uuid))
            or exists (select 1 from event_hosts h where h.event_id = ${events.id} and h.user_id = ${uid}::uuid)))`
        : sql`(${spaceReadable} and ${events.visibility} = 'public')`);
    }
    const where = and(...conds);
    const sortBy = q("sortBy");
    const dir = q("sortDir") === "asc" ? sql`asc` : sql`desc`;
    const orderBy = sortBy === "going"
      ? sql`(select count(*) from event_rsvps r where r.event_id = ${events.id} and r.status = 'going') ${dir}, ${events.startTime} asc`
      : sql`${events.startTime} ${dir}`;
    const rows = await getDb().select().from(events).where(where).orderBy(orderBy).limit(limit).offset(offset);
    const [{ total } = { total: 0 }] = await getDb().select({ total: count() }).from(events).where(where);
    const data = await Promise.all(rows.map((r) => buildEventResponse(c, r)));
    return c.json(paginate(data, total, page, limit));
  })
  .get("/:eventId", async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    await assertCanViewEvent(c, row);
    return c.json(await buildEventResponse(c, row, { include: parseInclude(c) }));
  })
  .patch("/:eventId", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id));
    const body = parseBody(updateEventSchema, await c.req.json().catch(() => ({})), "events");
    // Re-gate space reassignment: moving an event into a space requires posting permission there
    // (mirrors create-time `assertCanPostInSpace`; no-ops for spaceId → null). Throw BEFORE any write.
    if (body.spaceId !== undefined && body.spaceId !== row.spaceId) {
      await assertCanPostInSpace(c, body.spaceId);
    }
    const patch: Record<string, unknown> = {};
    const set = (k: keyof typeof body, col: string, transform?: (v: any) => unknown) => {
      if (body[k] !== undefined) patch[col] = transform ? transform(body[k]) : body[k];
    };
    set("title", "title"); set("description", "description"); set("type", "type"); set("url", "url");
    set("venueName", "venueName"); set("address", "address"); set("timezone", "timezone");
    set("visibility", "visibility"); set("status", "status"); set("capacity", "capacity");
    set("allowMaybe", "allowMaybe"); set("guestListVisible", "guestListVisible"); set("spaceId", "spaceId");
    set("metadata", "metadata"); set("startTime", "startTime", (v) => new Date(v));
    set("endTime", "endTime", (v) => (v ? new Date(v) : null));
    if (Object.keys(patch).length) await getDb().update(events).set(patch).where(eq(events.id, row.id));
    if (body.location !== undefined) await writeLocation(row.id, body.location);
    if (body.removeImageIds?.length) {
      await getDb().execute(sql`delete from files where event_id = ${row.id}::uuid and id = any(${sql`array[${sql.join(body.removeImageIds.map((id) => sql`${id}::uuid`), sql`, `)}]`})`);
      // If the cover image was among those removed, clear the now-dangling pointer.
      if (row.coverImageId && body.removeImageIds.includes(row.coverImageId)) {
        await getDb().update(events).set({ coverImageId: null }).where(eq(events.id, row.id));
      }
    }
    const [fresh] = await getDb().select().from(events).where(eq(events.id, row.id)).limit(1);
    return c.json(await buildEventResponse(c, fresh!));
  })
  .delete("/:eventId", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id));
    if (env.CONTENT_DELETE_MODE === "hard") {
      // Collect files rows (cover image) BEFORE the delete — the FK cascade takes them with the row.
      const fileRows = await collectFileRows(c.var.projectId, { eventId: row.id });
      await getDb().delete(events).where(eq(events.id, row.id));
      removeMediaAsync(fileRows, `event ${row.id}`);
    } else {
      await getDb().update(events).set({ deletedAt: new Date() }).where(eq(events.id, row.id));
    }
    logger.info({ projectId: c.var.projectId, eventId: row.id, userId: c.var.auth!.userId, mode: env.CONTENT_DELETE_MODE }, "event: deleted");
    return c.body(null, 204);
  })
  .post("/:eventId/cancel", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id));
    await getDb().update(events).set({ status: "cancelled" }).where(eq(events.id, row.id));
    const [fresh] = await getDb().select().from(events).where(eq(events.id, row.id)).limit(1);
    return c.json(await buildEventResponse(c, fresh!));
  })
  .post("/:eventId/rsvp", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    await assertCanViewEvent(c, row); // can't RSVP to an event you can't see
    const { status } = parseBody(rsvpSchema, await c.req.json().catch(() => ({})), "events");
    if (row.status === "cancelled" || row.startTime.getTime() < Date.now()) {
      throw Errors.badRequest("events/rsvp-closed", "RSVPs are closed for this event");
    }
    if (status === "maybe" && !row.allowMaybe) throw Errors.badRequest("events/maybe-not-allowed", "This event does not allow 'maybe'");
    const uid = c.var.auth!.userId;
    if (status === "going") {
      // Serialize concurrent going-RSVPs for this event so the capacity check + write are atomic — a
      // plain read-then-insert is a TOCTOU race that could overshoot capacity. `for update` on the
      // event row makes each going-RSVP re-count under the lock; maybe/not_going/withdraw never add a
      // seat, so they skip the lock. Invariant held: the going count can never exceed capacity.
      await getDb().transaction(async (tx) => {
        await tx.execute(sql`select 1 from events where id = ${row.id}::uuid for update`);
        const [g = { n: 0 }] = await tx.select({ n: count() }).from(eventRsvps)
          .where(and(eq(eventRsvps.eventId, row.id), eq(eventRsvps.status, "going")));
        const [mine] = await tx.select({ status: eventRsvps.status }).from(eventRsvps)
          .where(and(eq(eventRsvps.eventId, row.id), eq(eventRsvps.userId, uid))).limit(1);
        // Only count an additional seat if the caller isn't already 'going'.
        const effectiveGoing = mine?.status === "going" ? Number(g.n) - 1 : Number(g.n);
        if (!canRsvpGoing(effectiveGoing, row.capacity)) throw Errors.badRequest("events/capacity-full", "This event is at capacity");
        await tx.insert(eventRsvps).values({ projectId: c.var.projectId, eventId: row.id, userId: uid, status })
          .onConflictDoUpdate({ target: [eventRsvps.eventId, eventRsvps.userId], set: { status, updatedAt: new Date() } });
      });
    } else {
      await getDb().insert(eventRsvps).values({ projectId: c.var.projectId, eventId: row.id, userId: uid, status })
        .onConflictDoUpdate({ target: [eventRsvps.eventId, eventRsvps.userId], set: { status, updatedAt: new Date() } });
    }
    return c.json(await buildEventResponse(c, row));
  })
  .delete("/:eventId/rsvp", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    await assertCanViewEvent(c, row); // can't touch RSVP state on an event you can't see
    await getDb().delete(eventRsvps).where(and(eq(eventRsvps.eventId, row.id), eq(eventRsvps.userId, c.var.auth!.userId)));
    return c.json(await buildEventResponse(c, row));
  })
  .get("/:eventId/rsvps", async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    await assertCanViewEvent(c, row); // visibility gate first — anonymous/stranger can't enumerate the guest list
    const hostIds = await loadHostIds(row.id);
    const isHostOrAdmin = !!(c.var.auth && (isProjectAdmin(c.var.auth) || isEventHost(hostIds, c.var.auth.userId)));
    // Additional non-host gate: a viewer of an event with guestListVisible=false still can't see the roster.
    if (!isHostOrAdmin && !row.guestListVisible) throw Errors.forbidden("events/guest-list-hidden", "The guest list is private");
    const { page, limit, offset } = readPagination(c);
    const status = c.req.query("status");
    // Validate the optional status filter against the enum before the ::cast (clean 400, not a 500).
    if (status !== undefined && status !== "" && !rsvpStatusEnum.safeParse(status).success) {
      throw Errors.badRequest("events/invalid-filter", "Invalid 'status' filter", "status");
    }
    const where = and(eq(eventRsvps.eventId, row.id), status ? sql`${eventRsvps.status} = ${status}::rsvp_status` : undefined);
    const rows = await getDb().select().from(eventRsvps).where(where).orderBy(desc(eventRsvps.createdAt)).limit(limit).offset(offset);
    const [{ total } = { total: 0 }] = await getDb().select({ total: count() }).from(eventRsvps).where(where);
    const include = parseInclude(c);
    const userMap = include.has("user") ? await loadUsers(c.var.projectId, rows.map((r) => r.userId)) : null;
    const data = rows.map((r) => shapeEventRsvp(r, userMap ? userMap.get(r.userId) ?? null : undefined));
    return c.json(paginate(data, total, page, limit));
  })
  // ── invites (host-only) ──
  .post("/:eventId/invites", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id));
    const { userId } = parseBody(eventUserIdSchema, await c.req.json().catch(() => ({})), "events");
    await assertProfilesInProject(c.var.projectId, [userId]);
    await getDb().insert(eventInvites).values({ projectId: c.var.projectId, eventId: row.id, userId }).onConflictDoNothing();
    return c.json(await buildEventResponse(c, row));
  })
  .delete("/:eventId/invites", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id));
    const { userId } = parseBody(eventUserIdSchema, await c.req.json().catch(() => ({})), "events");
    // Removing an invite also drops that user's RSVP (revokes access to invite-only events).
    await getDb().delete(eventInvites).where(and(eq(eventInvites.eventId, row.id), eq(eventInvites.userId, userId)));
    await getDb().delete(eventRsvps).where(and(eq(eventRsvps.eventId, row.id), eq(eventRsvps.userId, userId)));
    return c.json(await buildEventResponse(c, row));
  })
  .get("/:eventId/invites", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id)); // host-only list
    const { page, limit, offset } = readPagination(c);
    const rows = await getDb().select().from(eventInvites).where(eq(eventInvites.eventId, row.id))
      .orderBy(desc(eventInvites.createdAt)).limit(limit).offset(offset);
    const [{ total } = { total: 0 }] = await getDb().select({ total: count() }).from(eventInvites).where(eq(eventInvites.eventId, row.id));
    const include = parseInclude(c);
    const userMap = include.has("user") ? await loadUsers(c.var.projectId, rows.map((r) => r.userId)) : null;
    const data = rows.map((r) => shapeEventInvite(r, userMap ? userMap.get(r.userId) ?? null : undefined));
    return c.json(paginate(data, total, page, limit));
  })
  // ── hosts ──
  .post("/:eventId/hosts", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id));
    const { userId } = parseBody(eventUserIdSchema, await c.req.json().catch(() => ({})), "events");
    await assertProfilesInProject(c.var.projectId, [userId]);
    await getDb().insert(eventHosts).values({ projectId: c.var.projectId, eventId: row.id, userId }).onConflictDoNothing();
    return c.json(await buildEventResponse(c, row));
  })
  .delete("/:eventId/hosts", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    const hostIds = await loadHostIds(row.id);
    requireEventManage(c, hostIds);
    const { userId } = parseBody(eventUserIdSchema, await c.req.json().catch(() => ({})), "events");
    if (wouldOrphanHosts(hostIds, userId)) throw Errors.badRequest("events/last-host", "An event must have at least one host");
    await getDb().delete(eventHosts).where(and(eq(eventHosts.eventId, row.id), eq(eventHosts.userId, userId)));
    return c.json(await buildEventResponse(c, row));
  });
