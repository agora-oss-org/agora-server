// Space-access provider for channel-type secure conversations.
//
// v1 implementation: direct SQL against the SHARED Postgres (spaces / space_members), because
// @agora/secure-chat currently shares the main DB with @agora/api. The seam exists so a future
// standalone / onion deployment (its own DB, with no `spaces` table) can swap in an API-callback
// provider — or disable space-gated channels entirely — without touching the route handlers.
// (See docs/SECURE_CHAT.md → v2 deferrals.)
import { and, eq } from "drizzle-orm";
import { db } from "@agora/core/db";
import { spaces, spaceMembers } from "@agora/core/db/schema";
import { Errors } from "@agora/core/http/errors";

/** Channel conversations are gated by space membership (space owner ⇒ allowed), mirroring chat.ts. */
export async function assertSpaceAccess(projectId: string, spaceId: string, userId: string): Promise<void> {
  const [space] = await db.select().from(spaces)
    .where(and(eq(spaces.projectId, projectId), eq(spaces.id, spaceId))).limit(1);
  if (!space) throw Errors.notFound("secure-chat/space-not-found", "Space not found");
  if (space.userId === userId) return;
  const [sm] = await db.select().from(spaceMembers)
    .where(and(eq(spaceMembers.projectId, projectId), eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId))).limit(1);
  if (!sm || sm.status !== "active") throw Errors.forbidden("secure-chat/space-not-member", "Join the space to access its channel");
}
