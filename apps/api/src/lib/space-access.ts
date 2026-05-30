// Space reading-permission enforcement (the server-side trust boundary for private spaces).
//
// A space's `readingPermission` is either "anyone" (public) or "members" (private). It is stored and
// surfaced in responses, but reads/writes against content that lives in a private space must be
// gated HERE — the `permissions.canRead` flag in space payloads is advisory for clients only.
//
// Rules, uniformly:
//   - content with no space (spaceId null)        → public, always readable
//   - space.readingPermission === "anyone"        → public, always readable
//   - space.readingPermission === "members"       → owner or ACTIVE member only
//   - deployment operators                        → bypass (project-wide god-view)
//
// `postingPermission` is a SEPARATE gate (who may create content) and is not enforced here.
import type { Context } from "hono";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { db } from "../db/index.js";
import { spaces, spaceMembers, entities, comments } from "../db/schema/index.js";

type Ctx = Context<{ Variables: Variables }>;

/** Owner or active member of the space. */
async function isOwnerOrActiveMember(
  projectId: string,
  spaceId: string,
  userId: string,
  ownerId: string | null,
): Promise<boolean> {
  if (ownerId && ownerId === userId) return true;
  const [m] = await db
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(
      and(
        eq(spaceMembers.projectId, projectId),
        eq(spaceMembers.spaceId, spaceId),
        eq(spaceMembers.userId, userId),
        eq(spaceMembers.status, "active"),
      ),
    )
    .limit(1);
  return !!m;
}

/**
 * Assert the caller may READ content that lives in `spaceId`. No-ops for space-less content, public
 * spaces, operators, and the space owner / active members. Throws 403 (spaces/members-only) otherwise.
 * An unknown/deleted space is treated as "not gated" — the caller's own content lookup will 404.
 */
export async function assertCanReadSpace(c: Ctx, spaceId: string | null | undefined): Promise<void> {
  if (!spaceId) return;
  if (c.var.auth?.isOperator) return;
  const [space] = await db
    .select({ userId: spaces.userId, readingPermission: spaces.readingPermission })
    .from(spaces)
    .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, spaceId), isNull(spaces.deletedAt)))
    .limit(1);
  if (!space) return; // unknown/deleted space — let the content lookup 404 on its own
  if (space.readingPermission === "anyone") return;
  const uid = c.var.auth?.userId;
  if (uid && (await isOwnerOrActiveMember(c.var.projectId, spaceId, uid, space.userId))) return;
  throw Errors.forbidden("spaces/members-only", "This space is members-only");
}

/** Resolve an entity to its space and assert read access. No-ops if the entity doesn't exist. */
export async function assertCanReadEntity(c: Ctx, entityId: string): Promise<void> {
  if (c.var.auth?.isOperator) return;
  const [row] = await db
    .select({ spaceId: entities.spaceId })
    .from(entities)
    .where(and(eq(entities.projectId, c.var.projectId), eq(entities.id, entityId)))
    .limit(1);
  if (!row) return;
  await assertCanReadSpace(c, row.spaceId);
}

/** Resolve a comment to its entity's space and assert read access. No-ops if the comment is gone. */
export async function assertCanReadComment(c: Ctx, commentId: string): Promise<void> {
  if (c.var.auth?.isOperator) return;
  const [row] = await db
    .select({ entityId: comments.entityId })
    .from(comments)
    .where(and(eq(comments.projectId, c.var.projectId), eq(comments.id, commentId)))
    .limit(1);
  if (!row) return;
  await assertCanReadEntity(c, row.entityId);
}

/**
 * Assert the caller may POST content into `spaceId`, per the space's `postingPermission`:
 *   - "anyone"   → any authenticated caller
 *   - "members"  → active members (any role) + owner
 *   - "admins"   → owner / admin / moderator only
 * No-ops for space-less content (project-level) and operators. Throws 403 otherwise. This is the
 * write-side counterpart to {@link assertCanReadSpace} (a separate gate from read access).
 */
export async function assertCanPostInSpace(c: Ctx, spaceId: string | null | undefined): Promise<void> {
  if (!spaceId) return;
  if (c.var.auth?.isOperator) return;
  const [space] = await db
    .select({ userId: spaces.userId, postingPermission: spaces.postingPermission })
    .from(spaces)
    .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, spaceId), isNull(spaces.deletedAt)))
    .limit(1);
  if (!space) return; // unknown/deleted space — let the insert's FK / downstream handle it
  if (space.postingPermission === "anyone") return;
  const uid = c.var.auth?.userId;
  if (uid && space.userId === uid) return; // owner ⇒ admin
  const [m] = uid
    ? await db
        .select({ role: spaceMembers.role })
        .from(spaceMembers)
        .where(
          and(
            eq(spaceMembers.projectId, c.var.projectId),
            eq(spaceMembers.spaceId, spaceId),
            eq(spaceMembers.userId, uid),
            eq(spaceMembers.status, "active"),
          ),
        )
        .limit(1)
    : [];
  if (!m) throw Errors.forbidden("spaces/not-a-member", "You must be a member of this space to post");
  if (space.postingPermission === "admins" && m.role !== "admin" && m.role !== "moderator") {
    throw Errors.forbidden("spaces/posting-restricted", "Only admins can post in this space");
  }
}

/**
 * SQL predicate for entity-list queries (the feed): keep only entities the caller may read — those
 * with no space, those in public spaces, or those in members-only spaces the caller owns or actively
 * belongs to. Operators get `undefined` (unfiltered). Anonymous callers see public/space-less only.
 * Correlates to the outer `entities` row via `entities.space_id`.
 */
export function readableEntitiesFilter(c: Ctx): SQL | undefined {
  if (c.var.auth?.isOperator) return undefined;
  const uid = c.var.auth?.userId ?? null;
  const memberClause = uid
    ? sql`or s.user_id = ${uid}::uuid or exists (
        select 1 from space_members m
        where m.space_id = s.id and m.user_id = ${uid}::uuid and m.status = 'active')`
    : sql``;
  return sql`(${entities.spaceId} is null or exists (
    select 1 from spaces s
    where s.id = ${entities.spaceId} and s.deleted_at is null
      and (s.reading_permission = 'anyone' ${memberClause})
  ))`;
}

