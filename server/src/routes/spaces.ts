// /v7/:projectId/spaces/*  — spaces, membership, rules, moderation.
// Static routes (/by-slug, /user-spaces, …) MUST stay above /:id.
// NOTE: :memberId is treated as the member's USER id (operate on space_members by user).
import { Hono } from "hono";
import { and, eq, isNull, desc, asc, count, inArray } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { spaces, spaceMembers, spaceRules, entities, comments, profiles, reports } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { shapeSpace, shapeRule, shapeUser, generateShortId } from "../lib/shape.js";
import {
  parseBody, createSpaceSchema, updateSpaceSchema, createRuleSchema, updateRuleSchema,
  reorderRulesSchema, memberRoleSchema, moderationSchema,
} from "../lib/validation.js";

type SpaceRow = typeof spaces.$inferSelect;
type Membership = typeof spaceMembers.$inferSelect;

async function getSpace(c: any): Promise<SpaceRow> {
  const [row] = await db.select().from(spaces)
    .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, c.req.param("id")), isNull(spaces.deletedAt))).limit(1);
  if (!row) throw Errors.notFound("spaces/not-found", "Space not found");
  return row;
}

async function membershipOf(projectId: string, spaceId: string, userId: string): Promise<Membership | null> {
  const [m] = await db.select().from(spaceMembers)
    .where(and(eq(spaceMembers.projectId, projectId), eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId))).limit(1);
  return m ?? null;
}

// Owner counts as admin. Returns the effective role or throws 403.
async function requireSpaceRole(c: any, space: SpaceRow, roles: Array<"admin" | "moderator" | "member">): Promise<"admin" | "moderator" | "member"> {
  const uid = c.var.auth.userId as string;
  if (space.userId === uid) return "admin";
  const m = await membershipOf(c.var.projectId, space.id, uid);
  if (!m || m.status !== "active" || !roles.includes(m.role)) {
    throw Errors.forbidden("spaces/insufficient-role", "Insufficient space role");
  }
  return m.role;
}

export const spaceRoutes = new Hono<{ Variables: Variables }>()
  .get("/", async (c) => {
    const { page, limit, offset } = readPagination(c);
    const parent = c.req.query("parentSpaceId");
    const where = and(
      eq(spaces.projectId, c.var.projectId),
      isNull(spaces.deletedAt),
      parent ? eq(spaces.parentSpaceId, parent) : isNull(spaces.parentSpaceId)
    );
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(spaces).where(where);
    const rows = await db.select().from(spaces).where(where).orderBy(desc(spaces.createdAt)).limit(limit).offset(offset);
    return c.json(paginate(rows.map((r) => shapeSpace(r)), n, page, limit));
  })
  .post("/", requireAuth, async (c) => {
    const body = parseBody(createSpaceSchema, await c.req.json().catch(() => ({})), "spaces");
    let depth = 0;
    if (body.parentSpaceId) {
      const [p] = await db.select({ depth: spaces.depth }).from(spaces)
        .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, body.parentSpaceId))).limit(1);
      if (!p) throw Errors.badRequest("spaces/bad-parent", "Parent space not found", "parentSpaceId");
      depth = p.depth + 1;
    }
    const [row] = await db.insert(spaces).values({
      projectId: c.var.projectId, userId: c.var.auth!.userId, shortId: generateShortId(),
      name: body.name, slug: body.slug, description: body.description,
      readingPermission: body.readingPermission, postingPermission: body.postingPermission,
      requireJoinApproval: body.requireJoinApproval, parentSpaceId: body.parentSpaceId, depth,
      metadata: body.metadata,
    }).returning();
    // Creator joins as admin (trigger bumps members_count).
    await db.insert(spaceMembers).values({
      projectId: c.var.projectId, spaceId: row!.id, userId: c.var.auth!.userId, role: "admin", status: "active",
    }).onConflictDoNothing();
    return c.json(shapeSpace(row!), 201);
  })
  .get("/by-short-id", async (c) => {
    const shortId = c.req.query("shortId");
    if (!shortId) throw Errors.badRequest("spaces/missing-short-id", "shortId is required", "shortId");
    const [row] = await db.select().from(spaces)
      .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.shortId, shortId), isNull(spaces.deletedAt))).limit(1);
    if (!row) throw Errors.notFound("spaces/not-found", "Space not found");
    return c.json(shapeSpace(row));
  })
  .get("/by-slug", async (c) => {
    const slug = c.req.query("slug");
    if (!slug) throw Errors.badRequest("spaces/missing-slug", "slug is required", "slug");
    const [row] = await db.select().from(spaces)
      .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.slug, slug), isNull(spaces.deletedAt))).limit(1);
    if (!row) throw Errors.notFound("spaces/not-found", "Space not found");
    return c.json(shapeSpace(row));
  })
  .get("/check-slug", async (c) => {
    const slug = c.req.query("slug");
    if (!slug) throw Errors.badRequest("spaces/missing-slug", "slug is required", "slug");
    const [row] = await db.select({ id: spaces.id }).from(spaces)
      .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.slug, slug))).limit(1);
    return c.json({ available: !row });
  })
  .get("/user-spaces", requireAuth, async (c) => {
    const { page, limit, offset } = readPagination(c);
    const uid = c.var.auth!.userId;
    const where = and(eq(spaceMembers.projectId, c.var.projectId), eq(spaceMembers.userId, uid));
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(spaceMembers).where(where);
    const rows = await db.select({ space: spaces, m: spaceMembers })
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
    const [row] = await db.update(spaces).set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.slug !== undefined ? { slug: body.slug } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.readingPermission !== undefined ? { readingPermission: body.readingPermission } : {}),
      ...(body.postingPermission !== undefined ? { postingPermission: body.postingPermission } : {}),
      ...(body.requireJoinApproval !== undefined ? { requireJoinApproval: body.requireJoinApproval } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    }).where(eq(spaces.id, space.id)).returning();
    return c.json(shapeSpace(row!));
  })
  .delete("/:id", requireAuth, async (c) => {
    const space = await getSpace(c);
    if (space.userId !== c.var.auth!.userId) throw Errors.forbidden("spaces/not-owner", "Only the owner can delete");
    await db.update(spaces).set({ deletedAt: new Date() }).where(eq(spaces.id, space.id));
    return c.json({ success: true, deletedSpace: { id: space.id, name: space.name } });
  })
  .get("/:id/breadcrumb", async (c) => {
    // Walk up the parent chain (depth is small).
    let current = await getSpace(c);
    const chain: SpaceRow[] = [current];
    while (current.parentSpaceId) {
      const [p] = await db.select().from(spaces).where(eq(spaces.id, current.parentSpaceId)).limit(1);
      if (!p) break;
      chain.unshift(p);
      current = p;
    }
    return c.json({ data: chain.map((s) => shapeSpace(s)) });
  })
  .get("/:id/children", async (c) => {
    const { page, limit, offset } = readPagination(c);
    const where = and(eq(spaces.projectId, c.var.projectId), eq(spaces.parentSpaceId, c.req.param("id")), isNull(spaces.deletedAt));
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(spaces).where(where);
    const rows = await db.select().from(spaces).where(where).orderBy(desc(spaces.createdAt)).limit(limit).offset(offset);
    return c.json(paginate(rows.map((r) => shapeSpace(r)), n, page, limit));
  })
  // ── membership ──────────────────────────────────────────────────────────
  .post("/:id/join", requireAuth, async (c) => {
    const space = await getSpace(c);
    const uid = c.var.auth!.userId;
    const status = space.requireJoinApproval ? "pending" : "active";
    const [row] = await db.insert(spaceMembers)
      .values({ projectId: c.var.projectId, spaceId: space.id, userId: uid, role: "member", status })
      .onConflictDoNothing().returning();
    const m = row ?? (await membershipOf(c.var.projectId, space.id, uid))!;
    return c.json({ message: "ok", membership: { id: m.id, spaceId: space.id, userId: uid, role: m.role, status: m.status, joinedAt: m.joinedAt } });
  })
  .delete("/:id/leave", requireAuth, async (c) => {
    await db.delete(spaceMembers).where(and(
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
      permissions: { canPost: false, canModerate: false, canRead: space.readingPermission === "anyone", isAdmin: false, isModerator: false } });
    const isAdmin = m.role === "admin", isMod = m.role === "moderator";
    return c.json({ isMember: m.status === "active", role: m.role, status: m.status, joinedAt: m.joinedAt,
      permissions: { canPost: m.status === "active", canModerate: isAdmin || isMod, canRead: true, isAdmin, isModerator: isMod } });
  })
  .get("/:id/members", async (c) => {
    const { page, limit, offset } = readPagination(c);
    const where = and(eq(spaceMembers.projectId, c.var.projectId), eq(spaceMembers.spaceId, c.req.param("id")));
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(spaceMembers).where(where);
    const rows = await db.select({ m: spaceMembers, p: profiles })
      .from(spaceMembers).innerJoin(profiles, eq(profiles.id, spaceMembers.userId))
      .where(where).orderBy(asc(spaceMembers.joinedAt)).limit(limit).offset(offset);
    const data = rows.map((r) => ({ membershipId: r.m.id, role: r.m.role, status: r.m.status, joinedAt: r.m.joinedAt, user: shapeUser(r.p) }));
    return c.json(paginate(data, n, page, limit));
  })
  .get("/:id/team", async (c) => {
    const rows = await db.select({ m: spaceMembers, p: profiles })
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
    await db.delete(spaceMembers).where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, c.req.param("memberId"))));
    return c.json({ success: true });
  })
  .patch("/:id/members/:memberId/role", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin"]);
    const { role } = parseBody(memberRoleSchema, await c.req.json().catch(() => ({})), "spaces");
    const [m] = await db.update(spaceMembers).set({ role }).where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, c.req.param("memberId")))).returning();
    if (!m) throw Errors.notFound("spaces/member-not-found", "Member not found");
    return c.json({ message: "ok", membership: { id: m.id, role: m.role, status: m.status, joinedAt: m.joinedAt, userId: m.userId } });
  })
  .patch("/:id/members/:memberId/approve", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    const [m] = await db.update(spaceMembers).set({ status: "active" }).where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, c.req.param("memberId")))).returning();
    if (!m) throw Errors.notFound("spaces/member-not-found", "Member not found");
    return c.json({ message: "approved", membership: { id: m.id, status: m.status, joinedAt: m.joinedAt } });
  })
  .patch("/:id/members/:memberId/decline", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    const [m] = await db.update(spaceMembers).set({ status: "rejected" }).where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, c.req.param("memberId")))).returning();
    if (!m) throw Errors.notFound("spaces/member-not-found", "Member not found");
    return c.json({ message: "declined", membership: { id: m.id, status: m.status } });
  })
  .patch("/:id/members/:memberId/unban", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    const [m] = await db.update(spaceMembers).set({ status: "active" }).where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, c.req.param("memberId")))).returning();
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
    const [row] = await db.update(spaces).set({
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
    const rows = await db.select().from(spaceRules)
      .where(and(eq(spaceRules.projectId, c.var.projectId), eq(spaceRules.spaceId, c.req.param("id"))))
      .orderBy(asc(spaceRules.order));
    return c.json({ data: rows.map(shapeRule), count: rows.length });
  })
  .post("/:id/rules", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin"]);
    const body = parseBody(createRuleSchema, await c.req.json().catch(() => ({})), "spaces");
    const [row] = await db.insert(spaceRules).values({
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
      db.update(spaceRules).set({ order: i }).where(and(eq(spaceRules.spaceId, space.id), eq(spaceRules.id, ruleId)))
    ));
    const rows = await db.select().from(spaceRules).where(eq(spaceRules.spaceId, space.id)).orderBy(asc(spaceRules.order));
    return c.json({ data: rows.map(shapeRule), count: rows.length });
  })
  .get("/:id/rules/:ruleId", async (c) => {
    const [row] = await db.select().from(spaceRules)
      .where(and(eq(spaceRules.spaceId, c.req.param("id")), eq(spaceRules.id, c.req.param("ruleId")))).limit(1);
    if (!row) throw Errors.notFound("spaces/rule-not-found", "Rule not found");
    return c.json(shapeRule(row));
  })
  .patch("/:id/rules/:ruleId", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin"]);
    const body = parseBody(updateRuleSchema, await c.req.json().catch(() => ({})), "spaces");
    const [row] = await db.update(spaceRules).set({
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
    const [row] = await db.delete(spaceRules).where(and(eq(spaceRules.spaceId, space.id), eq(spaceRules.id, c.req.param("ruleId")))).returning();
    if (!row) throw Errors.notFound("spaces/rule-not-found", "Rule not found");
    return c.json({ message: "deleted", deletedRule: { id: row.id, title: row.title } });
  })
  // ── moderation ──────────────────────────────────────────────────────────
  .patch("/:id/entities/:entityId/moderation", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    const { status, reason } = parseBody(moderationSchema, await c.req.json().catch(() => ({})), "spaces");
    const [row] = await db.update(entities).set({
      moderationStatus: status, moderationReason: reason, moderatedAt: new Date(),
      moderatedById: c.var.auth!.userId, moderatedByType: "user",
    }).where(and(eq(entities.projectId, c.var.projectId), eq(entities.id, c.req.param("entityId")), eq(entities.spaceId, space.id))).returning();
    if (!row) throw Errors.notFound("entities/not-found", "Entity not found in space");
    return c.json({ success: true });
  })
  .patch("/:id/comments/:commentId/moderation", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    const { status, reason } = parseBody(moderationSchema, await c.req.json().catch(() => ({})), "spaces");
    const [row] = await db.update(comments).set({
      moderationStatus: status, moderationReason: reason, moderatedAt: new Date(),
      moderatedById: c.var.auth!.userId, moderatedByType: "user",
    }).where(and(eq(comments.projectId, c.var.projectId), eq(comments.id, c.req.param("commentId")))).returning();
    if (!row) throw Errors.notFound("comments/not-found", "Comment not found");
    return c.json({ success: true });
  })
  // ── report resolution ─────────────────────────────────────────────────────
  .patch("/:id/reports/entity/:entityId", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    await db.update(reports).set({ resolvedAt: new Date(), resolvedById: c.var.auth!.userId })
      .where(and(eq(reports.projectId, c.var.projectId), eq(reports.spaceId, space.id), eq(reports.targetType, "entity"), eq(reports.targetId, c.req.param("entityId"))));
    return c.json({ success: true });
  })
  .patch("/:id/reports/comment/:commentId", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    await db.update(reports).set({ resolvedAt: new Date(), resolvedById: c.var.auth!.userId })
      .where(and(eq(reports.projectId, c.var.projectId), eq(reports.spaceId, space.id), eq(reports.targetType, "comment"), eq(reports.targetId, c.req.param("commentId"))));
    return c.json({ success: true });
  });
