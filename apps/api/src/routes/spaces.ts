// /v7/:projectId/spaces/*  — spaces, membership, rules, moderation.
// Static routes (/by-slug, /user-spaces, …) MUST stay above /:id.
// NOTE: :memberId is treated as the member's USER id (operate on space_members by user).
import { Hono } from "hono";
import { and, eq, isNull, desc, asc, count, inArray, ilike, or, sql } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { spaces, spaceMembers, spaceRules, entities, comments, profiles, reports } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { shapeSpace, shapeRule, shapeUser, generateShortId, parseInclude, loadSpaceFiles } from "../lib/shape.js";
import {
  parseBody, createSpaceSchema, updateSpaceSchema, createRuleSchema, updateRuleSchema,
  reorderRulesSchema, memberRoleSchema, moderationSchema, spaceSortByEnum,
} from "../lib/validation.js";
import { notifyOnSpaceApproved } from "../lib/notifications.js";
import * as webhooks from "../lib/webhooks.js";
import { isProjectAdmin } from "../lib/project-roles.js";

type SpaceRow = typeof spaces.$inferSelect;
type Membership = typeof spaceMembers.$inferSelect;

// Max nesting depth for spaces (root = 0, so this allows MAX_SPACE_DEPTH+1 levels). The cycle
// guard prevents loops; this caps how deep a tree can go.
const MAX_SPACE_DEPTH = 5;

async function getSpace(c: any): Promise<SpaceRow> {
  const [row] = await getDb().select().from(spaces)
    .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, c.req.param("id")), isNull(spaces.deletedAt))).limit(1);
  if (!row) throw Errors.notFound("spaces/not-found", "Space not found");
  return row;
}

async function membershipOf(projectId: string, spaceId: string, userId: string): Promise<Membership | null> {
  const [m] = await getDb().select().from(spaceMembers)
    .where(and(eq(spaceMembers.projectId, projectId), eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId))).limit(1);
  return m ?? null;
}

// Owner counts as admin. Returns the effective role or throws 403.
async function requireSpaceRole(c: any, space: SpaceRow, roles: Array<"admin" | "moderator" | "member">): Promise<"admin" | "moderator" | "member"> {
  const uid = c.var.auth.userId as string;
  // Project admins/owners/operators satisfy any space-role check (operator ⊇ owner ⊇ admin ⊇ steward ⊇
  // member — CLAUDE.md); they manage spaces they don't own from the admin Spaces section.
  if (c.var.auth && isProjectAdmin(c.var.auth)) return "admin";
  if (space.userId === uid) return "admin";
  const m = await membershipOf(c.var.projectId, space.id, uid);
  if (!m || m.status !== "active" || !roles.includes(m.role)) {
    throw Errors.forbidden("spaces/insufficient-role", "Insufficient space role");
  }
  return m.role;
}

// True if making `newParentId` the parent of `spaceId` would create a cycle — i.e. newParentId
// is `spaceId` itself or one of its descendants. Walks up the ancestor chain from newParentId.
async function wouldCreateCycle(spaceId: string, newParentId: string): Promise<boolean> {
  let current: string | null = newParentId;
  const seen = new Set<string>();
  while (current) {
    if (current === spaceId) return true;
    if (seen.has(current)) break; // safety against pre-existing corrupt data
    seen.add(current);
    const [p] = await getDb().select({ parent: spaces.parentSpaceId }).from(spaces).where(eq(spaces.id, current)).limit(1);
    current = p?.parent ?? null;
  }
  return false;
}

export const spaceRoutes = new Hono<{ Variables: Variables }>()
  .get("/", async (c) => {
    const { page, limit, offset } = readPagination(c);
    // SDK sends an absent filter as the literal string "null"/"undefined".
    const q = (k: string) => { const v = c.req.query(k); return v && v !== "null" && v !== "undefined" ? v : undefined; };
    const pq = c.req.query("parentSpaceId");
    const parent = pq && pq !== "null" && pq !== "undefined" ? pq : undefined;

    const conds = [
      eq(spaces.projectId, c.var.projectId),
      isNull(spaces.deletedAt),
      parent ? eq(spaces.parentSpaceId, parent) : isNull(spaces.parentSpaceId),
    ];
    const any = q("searchAny");
    if (any) conds.push(or(ilike(spaces.name, `%${any}%`), ilike(spaces.slug, `%${any}%`), ilike(spaces.description, `%${any}%`))!);
    if (q("searchName")) conds.push(ilike(spaces.name, `%${q("searchName")}%`));
    if (q("searchSlug")) conds.push(ilike(spaces.slug, `%${q("searchSlug")}%`));
    if (q("searchDescription")) conds.push(ilike(spaces.description, `%${q("searchDescription")}%`));

    // memberOf=true → restrict to spaces the caller is an ACTIVE member of (literal "true" only).
    const uid = c.var.auth?.userId;
    if (q("memberOf") === "true") {
      if (!uid) return c.json(paginate([], 0, page, limit));
      conds.push(inArray(spaces.id, getDb().select({ id: spaceMembers.spaceId }).from(spaceMembers)
        .where(and(eq(spaceMembers.projectId, c.var.projectId), eq(spaceMembers.userId, uid), eq(spaceMembers.status, "active")))));
    }

    const sortByRaw = q("sortBy");
    if (sortByRaw !== undefined && !spaceSortByEnum.safeParse(sortByRaw).success) {
      throw Errors.badRequest("spaces/invalid-filter", "Invalid 'sortBy' filter", "sortBy");
    }
    const orderBy = sortByRaw === "members" ? desc(spaces.membersCount)
      : sortByRaw === "alphabetical" ? asc(spaces.name)
      : desc(spaces.createdAt);

    const where = and(...conds);
    const [{ n } = { n: 0 }] = await getDb().select({ n: count() }).from(spaces).where(where);
    const rows = await getDb().select().from(spaces).where(where).orderBy(orderBy).limit(limit).offset(offset);
    const include = parseInclude(c);
    const fileMap = include.has("files") ? await loadSpaceFiles(c.var.projectId, rows.map((r) => r.id)) : null;
    return c.json(paginate(
      rows.map((r) => shapeSpace(r, fileMap ? { files: fileMap.get(r.id) ?? [] } : {})),
      n, page, limit,
    ));
  })
  .post("/", requireAuth, async (c) => {
    const body = parseBody(createSpaceSchema, await c.req.json().catch(() => ({})), "spaces");
    const check = await webhooks.validate(c.var.projectId, "space.created", { ...body, userId: c.var.auth!.userId });
    if (!check.valid) throw Errors.forbidden("spaces/rejected", check.message ?? "Space rejected by validation webhook");
    let depth = 0;
    if (body.parentSpaceId) {
      const [parent] = await getDb().select().from(spaces)
        .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, body.parentSpaceId), isNull(spaces.deletedAt))).limit(1);
      if (!parent) throw Errors.badRequest("spaces/bad-parent", "Parent space not found", "parentSpaceId");
      // Only an admin (or owner) of the parent space may create a subspace under it.
      await requireSpaceRole(c, parent, ["admin"]);
      depth = parent.depth + 1;
      if (depth > MAX_SPACE_DEPTH) throw Errors.badRequest("spaces/too-deep", `Spaces can nest at most ${MAX_SPACE_DEPTH} levels deep`, "parentSpaceId");
    }
    const [row] = await getDb().insert(spaces).values({
      projectId: c.var.projectId, userId: c.var.auth!.userId, shortId: generateShortId(),
      name: body.name, slug: body.slug, description: body.description,
      readingPermission: body.readingPermission, postingPermission: body.postingPermission,
      requireJoinApproval: body.requireJoinApproval, parentSpaceId: body.parentSpaceId, depth,
      metadata: body.metadata,
    }).returning();
    // Creator joins as admin (trigger bumps members_count).
    await getDb().insert(spaceMembers).values({
      projectId: c.var.projectId, spaceId: row!.id, userId: c.var.auth!.userId, role: "admin", status: "active",
    }).onConflictDoNothing();
    const shaped = shapeSpace(row!);
    logger.info({ projectId: c.var.projectId, spaceId: row!.id, userId: c.var.auth!.userId, parentSpaceId: row!.parentSpaceId ?? null }, "space: created");
    webhooks.broadcast(c.var.projectId, "space.created.complete", shaped);
    return c.json(shaped, 201);
  })
  .get("/by-short-id", async (c) => {
    const shortId = c.req.query("shortId");
    if (!shortId) throw Errors.badRequest("spaces/missing-short-id", "shortId is required", "shortId");
    const [row] = await getDb().select().from(spaces)
      .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.shortId, shortId), isNull(spaces.deletedAt))).limit(1);
    if (!row) throw Errors.notFound("spaces/not-found", "Space not found");
    return c.json(shapeSpace(row));
  })
  .get("/by-slug", async (c) => {
    const slug = c.req.query("slug");
    if (!slug) throw Errors.badRequest("spaces/missing-slug", "slug is required", "slug");
    const [row] = await getDb().select().from(spaces)
      .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.slug, slug), isNull(spaces.deletedAt))).limit(1);
    if (!row) throw Errors.notFound("spaces/not-found", "Space not found");
    return c.json(shapeSpace(row));
  })
  .get("/check-slug", async (c) => {
    const slug = c.req.query("slug");
    if (!slug) throw Errors.badRequest("spaces/missing-slug", "slug is required", "slug");
    const [row] = await getDb().select({ id: spaces.id }).from(spaces)
      .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.slug, slug))).limit(1);
    return c.json({ available: !row });
  })
  .get("/user-spaces", requireAuth, async (c) => {
    const { page, limit, offset } = readPagination(c);
    const uid = c.var.auth!.userId;
    const where = and(eq(spaceMembers.projectId, c.var.projectId), eq(spaceMembers.userId, uid));
    const [{ n } = { n: 0 }] = await getDb().select({ n: count() }).from(spaceMembers).where(where);
    const rows = await getDb().select({ space: spaces, m: spaceMembers })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(and(where, isNull(spaces.deletedAt)))
      .orderBy(desc(spaceMembers.joinedAt)).limit(limit).offset(offset);
    const data = rows.map((r) => ({
      space: shapeSpace(r.space),
      membership: { membershipId: r.m.id, role: r.m.role, status: r.m.status, joinedAt: r.m.joinedAt },
    }));
    return c.json(paginate(data, n, page, limit));
  })
  // SDK (useFetchMutualSpaces) — spaces in which BOTH the caller and :userId are active members.
  // Declared above /:id so the static `mutual` segment wins.
  .get("/mutual/:userId", requireAuth, async (c) => {
    const { page, limit, offset } = readPagination(c);
    const meId = c.var.auth!.userId;
    const otherId = c.req.param("userId");
    const activeFor = (uid: string) =>
      getDb().select({ sid: spaceMembers.spaceId }).from(spaceMembers).where(and(
        eq(spaceMembers.projectId, c.var.projectId),
        eq(spaceMembers.userId, uid),
        eq(spaceMembers.status, "active"),
      ));
    const where = and(
      eq(spaces.projectId, c.var.projectId),
      isNull(spaces.deletedAt),
      inArray(spaces.id, activeFor(meId)),
      inArray(spaces.id, activeFor(otherId)),
    );
    const [{ n } = { n: 0 }] = await getDb().select({ n: count() }).from(spaces).where(where);
    const rows = await getDb().select().from(spaces).where(where)
      .orderBy(desc(spaces.createdAt)).limit(limit).offset(offset);
    return c.json(paginate(rows.map((r) => shapeSpace(r)), n, page, limit));
  })
  .get("/:id", async (c) => {
    const space = await getSpace(c);
    const uid = c.var.auth?.userId;
    const isMember = uid ? !!(await membershipOf(c.var.projectId, space.id, uid)) : undefined;
    return c.json(shapeSpace(space, { isMember }));
  })
  .patch("/:id", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin"]);
    const body = parseBody(updateSpaceSchema, await c.req.json().catch(() => ({})), "spaces");
    const check = await webhooks.validate(c.var.projectId, "space.updated", { ...body, id: space.id });
    if (!check.valid) throw Errors.forbidden("spaces/rejected", check.message ?? "Space update rejected by validation webhook");
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.slug !== undefined) patch.slug = body.slug;
    if (body.description !== undefined) patch.description = body.description;
    if (body.readingPermission !== undefined) patch.readingPermission = body.readingPermission;
    if (body.postingPermission !== undefined) patch.postingPermission = body.postingPermission;
    if (body.requireJoinApproval !== undefined) patch.requireJoinApproval = body.requireJoinApproval;
    if (body.metadata !== undefined) patch.metadata = body.metadata;

    // Reparenting — only when parentSpaceId actually changes. Guard against cycles.
    if (body.parentSpaceId !== undefined && body.parentSpaceId !== space.parentSpaceId) {
      const newParentId = body.parentSpaceId;
      if (newParentId) {
        if (newParentId === space.id) throw Errors.badRequest("spaces/cycle", "A space cannot be its own parent", "parentSpaceId");
        const [parent] = await getDb().select().from(spaces)
          .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, newParentId), isNull(spaces.deletedAt))).limit(1);
        if (!parent) throw Errors.badRequest("spaces/bad-parent", "Parent space not found", "parentSpaceId");
        if (await wouldCreateCycle(space.id, newParentId)) {
          throw Errors.badRequest("spaces/cycle", "Cannot move a space under its own descendant", "parentSpaceId");
        }
        if (parent.depth + 1 > MAX_SPACE_DEPTH) {
          throw Errors.badRequest("spaces/too-deep", `Spaces can nest at most ${MAX_SPACE_DEPTH} levels deep`, "parentSpaceId");
        }
        patch.parentSpaceId = newParentId;
        patch.depth = parent.depth + 1;
      } else {
        patch.parentSpaceId = null;
        patch.depth = 0;
      }
      // child_spaces_count isn't trigger-maintained on UPDATE, so adjust both parents here.
      if (space.parentSpaceId) {
        await getDb().update(spaces).set({ childSpacesCount: sql`greatest(0, ${spaces.childSpacesCount} - 1)` }).where(eq(spaces.id, space.parentSpaceId));
      }
      if (newParentId) {
        await getDb().update(spaces).set({ childSpacesCount: sql`${spaces.childSpacesCount} + 1` }).where(eq(spaces.id, newParentId));
      }
    }

    const [row] = await getDb().update(spaces).set(patch).where(eq(spaces.id, space.id)).returning();
    const shaped = shapeSpace(row!);
    logger.info({ projectId: c.var.projectId, spaceId: space.id, userId: c.var.auth!.userId, fields: Object.keys(patch) }, "space: updated");
    webhooks.broadcast(c.var.projectId, "space.updated.complete", shaped);
    return c.json(shaped);
  })
  .delete("/:id", requireAuth, async (c) => {
    const space = await getSpace(c);
    if (space.userId !== c.var.auth!.userId) throw Errors.forbidden("spaces/not-owner", "Only the owner can delete");
    await getDb().update(spaces).set({ deletedAt: new Date() }).where(eq(spaces.id, space.id));
    logger.info({ projectId: c.var.projectId, spaceId: space.id, userId: c.var.auth!.userId }, "space: deleted");
    return c.json({ success: true, deletedSpace: { id: space.id, name: space.name } });
  })
  .get("/:id/breadcrumb", async (c) => {
    // Walk up the parent chain (depth is small).
    let current = await getSpace(c);
    const chain: SpaceRow[] = [current];
    while (current.parentSpaceId) {
      const [p] = await getDb().select().from(spaces).where(eq(spaces.id, current.parentSpaceId)).limit(1);
      if (!p) break;
      chain.unshift(p);
      current = p;
    }
    return c.json({ data: chain.map((s) => shapeSpace(s)) });
  })
  .get("/:id/children", async (c) => {
    const { page, limit, offset } = readPagination(c);
    const where = and(eq(spaces.projectId, c.var.projectId), eq(spaces.parentSpaceId, c.req.param("id")), isNull(spaces.deletedAt));
    const [{ n } = { n: 0 }] = await getDb().select({ n: count() }).from(spaces).where(where);
    const rows = await getDb().select().from(spaces).where(where).orderBy(desc(spaces.createdAt)).limit(limit).offset(offset);
    return c.json(paginate(rows.map((r) => shapeSpace(r)), n, page, limit));
  })
  // ── membership ──────────────────────────────────────────────────────────
  .post("/:id/join", requireAuth, async (c) => {
    const space = await getSpace(c);
    const uid = c.var.auth!.userId;
    const status = space.requireJoinApproval ? "pending" : "active";
    const [row] = await getDb().insert(spaceMembers)
      .values({ projectId: c.var.projectId, spaceId: space.id, userId: uid, role: "member", status })
      .onConflictDoNothing().returning();
    const m = row ?? (await membershipOf(c.var.projectId, space.id, uid))!;
    return c.json({ message: "ok", membership: { id: m.id, spaceId: space.id, userId: uid, role: m.role, status: m.status, joinedAt: m.joinedAt } });
  })
  .delete("/:id/leave", requireAuth, async (c) => {
    await getDb().delete(spaceMembers).where(and(
      eq(spaceMembers.projectId, c.var.projectId), eq(spaceMembers.spaceId, c.req.param("id")), eq(spaceMembers.userId, c.var.auth!.userId)
    ));
    return c.json({ message: "left" });
  })
  .get("/:id/membership/me", requireAuth, async (c) => {
    const space = await getSpace(c);
    const uid = c.var.auth!.userId;
    if (space.userId === uid) {
      return c.json({ isMember: true, role: "admin", status: "active", joinedAt: null,
        permissions: { canPost: true, canModerate: true, canRead: true, isAdmin: true, isModerator: true } });
    }
    const m = await membershipOf(c.var.projectId, space.id, uid);
    if (!m) return c.json({ isMember: false, role: null, status: null, joinedAt: null,
      permissions: { canPost: space.postingPermission === "anyone", canModerate: false, canRead: space.readingPermission === "anyone", isAdmin: false, isModerator: false } });
    // Only an *active* member gains read/write/moderation beyond what anyone gets. A pending
    // (awaiting approval), rejected, or banned membership row must NOT unlock members-only access.
    const isActive = m.status === "active";
    const isAdmin = isActive && m.role === "admin";
    const isMod = isActive && m.role === "moderator";
    return c.json({ isMember: isActive, role: m.role, status: m.status, joinedAt: m.joinedAt,
      permissions: {
        canPost: isActive && (space.postingPermission !== "admins" || isAdmin || isMod),
        canModerate: isAdmin || isMod,
        canRead: space.readingPermission === "anyone" || isActive,
        isAdmin, isModerator: isMod,
      } });
  })
  .get("/:id/members", async (c) => {
    const { page, limit, offset } = readPagination(c);
    // Optional filters (SDK's useFetchSpaceMembers sends these; e.g. status=pending for join requests).
    const statusQ = c.req.query("status");
    const roleQ = c.req.query("role");
    const conds = [eq(spaceMembers.projectId, c.var.projectId), eq(spaceMembers.spaceId, c.req.param("id"))];
    if (statusQ) conds.push(eq(spaceMembers.status, statusQ as any));
    if (roleQ) conds.push(eq(spaceMembers.role, roleQ as any));
    const where = and(...conds);
    const [{ n } = { n: 0 }] = await getDb().select({ n: count() }).from(spaceMembers).where(where);
    const rows = await getDb().select({ m: spaceMembers, p: profiles })
      .from(spaceMembers).innerJoin(profiles, eq(profiles.id, spaceMembers.userId))
      .where(where).orderBy(asc(spaceMembers.joinedAt)).limit(limit).offset(offset);
    const data = rows.map((r) => ({ membershipId: r.m.id, role: r.m.role, status: r.m.status, joinedAt: r.m.joinedAt, user: shapeUser(r.p) }));
    return c.json(paginate(data, n, page, limit));
  })
  .get("/:id/team", async (c) => {
    const rows = await getDb().select({ m: spaceMembers, p: profiles })
      .from(spaceMembers).innerJoin(profiles, eq(profiles.id, spaceMembers.userId))
      .where(and(
        eq(spaceMembers.projectId, c.var.projectId), eq(spaceMembers.spaceId, c.req.param("id")),
        inArray(spaceMembers.role, ["admin", "moderator"])
      )).orderBy(asc(spaceMembers.joinedAt));
    return c.json({ data: rows.map((r) => ({ membershipId: r.m.id, role: r.m.role, status: r.m.status, joinedAt: r.m.joinedAt, user: shapeUser(r.p) })) });
  })
  .delete("/:id/members/:memberId", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    await getDb().delete(spaceMembers).where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, c.req.param("memberId"))));
    return c.json({ success: true });
  })
  .patch("/:id/members/:memberId/role", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin"]);
    const { role } = parseBody(memberRoleSchema, await c.req.json().catch(() => ({})), "spaces");
    const [m] = await getDb().update(spaceMembers).set({ role }).where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, c.req.param("memberId")))).returning();
    if (!m) throw Errors.notFound("spaces/member-not-found", "Member not found");
    return c.json({ message: "ok", membership: { id: m.id, role: m.role, status: m.status, joinedAt: m.joinedAt, userId: m.userId } });
  })
  .patch("/:id/members/:memberId/approve", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    const [m] = await getDb().update(spaceMembers).set({ status: "active" }).where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, c.req.param("memberId")))).returning();
    if (!m) throw Errors.notFound("spaces/member-not-found", "Member not found");
    await notifyOnSpaceApproved(space.projectId, c.req.param("memberId"), c.var.auth!.userId, {
      id: space.id, name: space.name, shortId: space.shortId, slug: space.slug, avatar: space.avatarFileId,
    });
    return c.json({ message: "approved", membership: { id: m.id, status: m.status, joinedAt: m.joinedAt } });
  })
  .patch("/:id/members/:memberId/decline", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    const [m] = await getDb().update(spaceMembers).set({ status: "rejected" }).where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, c.req.param("memberId")))).returning();
    if (!m) throw Errors.notFound("spaces/member-not-found", "Member not found");
    return c.json({ message: "declined", membership: { id: m.id, status: m.status } });
  })
  .patch("/:id/members/:memberId/unban", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    const [m] = await getDb().update(spaceMembers).set({ status: "active" }).where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, c.req.param("memberId")))).returning();
    if (!m) throw Errors.notFound("spaces/member-not-found", "Member not found");
    return c.json({ message: "unbanned", membership: { id: m.id, status: m.status } });
  })
  // ── digest config ─────────────────────────────────────────────────────────
  .get("/:id/digest-config", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin"]);
    return c.json({
      digestEnabled: space.digestEnabled,
      digestWebhookUrl: space.digestWebhookUrl,
      digestWebhookSecret: space.digestWebhookSecret ? "••••••••" : null,
      digestScheduleHour: space.digestScheduleHour,
      digestTimezone: space.digestTimezone,
    });
  })
  .patch("/:id/digest-config", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin"]);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const [row] = await getDb().update(spaces).set({
      ...(body.digestEnabled !== undefined ? { digestEnabled: !!body.digestEnabled } : {}),
      ...(body.digestWebhookUrl !== undefined ? { digestWebhookUrl: body.digestWebhookUrl as string } : {}),
      ...(body.digestWebhookSecret !== undefined ? { digestWebhookSecret: body.digestWebhookSecret as string } : {}),
      ...(body.digestScheduleHour !== undefined ? { digestScheduleHour: body.digestScheduleHour as number } : {}),
      ...(body.digestTimezone !== undefined ? { digestTimezone: body.digestTimezone as string } : {}),
    }).where(eq(spaces.id, space.id)).returning();
    return c.json({
      digestEnabled: row!.digestEnabled, digestWebhookUrl: row!.digestWebhookUrl,
      digestWebhookSecret: row!.digestWebhookSecret ? "••••••••" : null,
      digestScheduleHour: row!.digestScheduleHour, digestTimezone: row!.digestTimezone,
    });
  })
  // ── rules ───────────────────────────────────────────────────────────────
  .get("/:id/rules", async (c) => {
    const rows = await getDb().select().from(spaceRules)
      .where(and(eq(spaceRules.projectId, c.var.projectId), eq(spaceRules.spaceId, c.req.param("id"))))
      .orderBy(asc(spaceRules.order));
    return c.json({ data: rows.map(shapeRule), count: rows.length });
  })
  .post("/:id/rules", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin"]);
    const body = parseBody(createRuleSchema, await c.req.json().catch(() => ({})), "spaces");
    const [row] = await getDb().insert(spaceRules).values({
      projectId: c.var.projectId, spaceId: space.id, title: body.title, description: body.description,
      order: body.order ?? 0, lastApprovedBy: c.var.auth!.userId,
    }).returning();
    return c.json(shapeRule(row!), 201);
  })
  .patch("/:id/rules/reorder", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin"]);
    const { order } = parseBody(reorderRulesSchema, await c.req.json().catch(() => ({})), "spaces");
    await Promise.all(order.map((ruleId, i) =>
      getDb().update(spaceRules).set({ order: i }).where(and(eq(spaceRules.spaceId, space.id), eq(spaceRules.id, ruleId)))
    ));
    const rows = await getDb().select().from(spaceRules).where(eq(spaceRules.spaceId, space.id)).orderBy(asc(spaceRules.order));
    return c.json({ data: rows.map(shapeRule), count: rows.length });
  })
  .get("/:id/rules/:ruleId", async (c) => {
    const [row] = await getDb().select().from(spaceRules)
      .where(and(eq(spaceRules.spaceId, c.req.param("id")), eq(spaceRules.id, c.req.param("ruleId")))).limit(1);
    if (!row) throw Errors.notFound("spaces/rule-not-found", "Rule not found");
    return c.json(shapeRule(row));
  })
  .patch("/:id/rules/:ruleId", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin"]);
    const body = parseBody(updateRuleSchema, await c.req.json().catch(() => ({})), "spaces");
    const [row] = await getDb().update(spaceRules).set({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.order !== undefined ? { order: body.order } : {}),
    }).where(and(eq(spaceRules.spaceId, space.id), eq(spaceRules.id, c.req.param("ruleId")))).returning();
    if (!row) throw Errors.notFound("spaces/rule-not-found", "Rule not found");
    return c.json(shapeRule(row));
  })
  .delete("/:id/rules/:ruleId", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin"]);
    const [row] = await getDb().delete(spaceRules).where(and(eq(spaceRules.spaceId, space.id), eq(spaceRules.id, c.req.param("ruleId")))).returning();
    if (!row) throw Errors.notFound("spaces/rule-not-found", "Rule not found");
    return c.json({ message: "deleted", deletedRule: { id: row.id, title: row.title } });
  })
  // ── moderation ──────────────────────────────────────────────────────────
  .patch("/:id/entities/:entityId/moderation", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    const { status, reason } = parseBody(moderationSchema, await c.req.json().catch(() => ({})), "spaces");
    const [row] = await getDb().update(entities).set({
      moderationStatus: status, moderationReason: reason, moderatedAt: new Date(),
      moderatedById: c.var.auth!.userId, moderatedByType: "user",
    }).where(and(eq(entities.projectId, c.var.projectId), eq(entities.id, c.req.param("entityId")), eq(entities.spaceId, space.id))).returning();
    if (!row) throw Errors.notFound("entities/not-found", "Entity not found in space");
    logger.info({ projectId: c.var.projectId, spaceId: space.id, entityId: row.id, moderatorId: c.var.auth!.userId, status }, "moderation: entity status set by moderator");
    return c.json({ success: true });
  })
  .patch("/:id/comments/:commentId/moderation", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    const { status, reason } = parseBody(moderationSchema, await c.req.json().catch(() => ({})), "spaces");
    const [row] = await getDb().update(comments).set({
      moderationStatus: status, moderationReason: reason, moderatedAt: new Date(),
      moderatedById: c.var.auth!.userId, moderatedByType: "user",
    }).where(and(eq(comments.projectId, c.var.projectId), eq(comments.id, c.req.param("commentId")))).returning();
    if (!row) throw Errors.notFound("comments/not-found", "Comment not found");
    logger.info({ projectId: c.var.projectId, spaceId: space.id, commentId: row.id, moderatorId: c.var.auth!.userId, status }, "moderation: comment status set by moderator");
    return c.json({ success: true });
  })
  // ── report resolution ─────────────────────────────────────────────────────
  .patch("/:id/reports/entity/:entityId", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    await getDb().update(reports).set({ resolvedAt: new Date(), resolvedById: c.var.auth!.userId })
      .where(and(eq(reports.projectId, c.var.projectId), eq(reports.spaceId, space.id), eq(reports.targetType, "entity"), eq(reports.targetId, c.req.param("entityId"))));
    return c.json({ success: true });
  })
  .patch("/:id/reports/comment/:commentId", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    await getDb().update(reports).set({ resolvedAt: new Date(), resolvedById: c.var.auth!.userId })
      .where(and(eq(reports.projectId, c.var.projectId), eq(reports.spaceId, space.id), eq(reports.targetType, "comment"), eq(reports.targetId, c.req.param("commentId"))));
    return c.json({ success: true });
  });
