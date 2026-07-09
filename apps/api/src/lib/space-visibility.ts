// Read-path enforcement for the space `visibility` axis (space-ROW discovery). Distinct from
// lib/space-access.ts, which gates CONTENT inside a space via `readingPermission`. A space's
// `visibility` is public | unlisted | private:
//   - public   → listed in directories/search, directly fetchable
//   - unlisted → hidden from listings/search, directly fetchable by id/slug/short-id (link-shareable)
//   - private  → hidden from listings/search AND 404 on direct fetch unless the viewer is the owner,
//                an active member, or a project-admin (operator ⊇ owner ⊇ admin)
// One authority, mirroring lib/moderation-visibility.ts: a list predicate (discoverableSpacesSql) +
// a single-row 404 gate (assertSpaceVisible / assertSpaceVisibleById). We 404 (never 403) a hidden
// private space so a probe can't distinguish "private, not yours" from "doesn't exist".
import type { Context } from "hono";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { getDb } from "../db/index.js";
import { spaces, spaceMembers } from "../db/schema/index.js";
import { isProjectAdmin } from "./project-roles.js";

type Ctx = Context<{ Variables: Variables }>;
type VisibilityRow = { id: string; userId: string | null; visibility: string };

/**
 * SQL predicate for space-list/search queries: keep only spaces the caller may DISCOVER — public
 * spaces, plus any space the caller owns or is an active member of (regardless of that space's
 * visibility). Project-admins get `undefined` (unfiltered). Anonymous callers see public only.
 * Correlates to the outer `spaces` row via spaces.id / spaces.user_id / spaces.visibility, so it
 * drops into an existing `and(...conds)` WHERE. Parameterized with an explicit ::uuid cast.
 */
export function discoverableSpacesSql(c: Ctx): SQL | undefined {
  if (c.var.auth && isProjectAdmin(c.var.auth)) return undefined;
  const uid = c.var.auth?.userId ?? null;
  if (!uid) return sql`${spaces.visibility} = 'public'`;
  return sql`(${spaces.visibility} = 'public' or ${spaces.userId} = ${uid}::uuid or exists (
    select 1 from space_members m
    where m.space_id = ${spaces.id} and m.user_id = ${uid}::uuid and m.status = 'active'))`;
}

/**
 * True if the viewer may SEE this (possibly private) space row. Non-private spaces are always
 * visible; a private space only to the owner, an active member, or a project-admin. Hits the DB only
 * for the active-member branch (private + authenticated non-owner non-admin).
 */
export async function spaceVisibleToViewer(c: Ctx, space: VisibilityRow): Promise<boolean> {
  if (space.visibility !== "private") return true;
  if (c.var.auth && isProjectAdmin(c.var.auth)) return true;
  const uid = c.var.auth?.userId ?? null;
  if (!uid) return false;
  if (space.userId && space.userId === uid) return true;
  const [m] = await getDb()
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(
      and(
        eq(spaceMembers.projectId, c.var.projectId),
        eq(spaceMembers.spaceId, space.id),
        eq(spaceMembers.userId, uid),
        eq(spaceMembers.status, "active"),
      ),
    )
    .limit(1);
  return !!m;
}

/**
 * Single-row discovery gate when the handler already holds the space row. Throws 404
 * (spaces/not-found) for a hidden private space — never 403 (which would leak existence).
 */
export async function assertSpaceVisible(c: Ctx, space: VisibilityRow): Promise<void> {
  if (!(await spaceVisibleToViewer(c, space))) {
    throw Errors.notFound("spaces/not-found", "Space not found");
  }
}

/**
 * Same gate for handlers that don't load the space row. Loads a minimal (non-deleted) row and applies
 * assertSpaceVisible; a missing/deleted space also 404s (fail closed, indistinguishable from hidden).
 */
export async function assertSpaceVisibleById(c: Ctx, spaceId: string): Promise<void> {
  const [row] = await getDb()
    .select({ id: spaces.id, userId: spaces.userId, visibility: spaces.visibility })
    .from(spaces)
    .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, spaceId), isNull(spaces.deletedAt)))
    .limit(1);
  if (!row) throw Errors.notFound("spaces/not-found", "Space not found");
  await assertSpaceVisible(c, row);
}
