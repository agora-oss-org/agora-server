// Applies an AUTOMATED ("client") moderation decision to an entity or comment. This is the write
// path behind POST /internal/moderation/apply, called by the @agora/moderator service when it
// auto-acts on a high-confidence violation. Mirrors the space moderation handlers' column writes but
// stamps moderatedByType="client" (vs "user" for human decisions) and no moderatedById (no human).
//
// Setting moderationStatus="removed" takes effect on reads immediately via lib/moderation-visibility
// + the 0019 RPCs — no extra invalidation needed.
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { entities, comments } from "../db/schema/index.js";

export type ClientModerationTarget = "entity" | "comment";
export type ModerationStatusValue = "removed" | "approved";

/** Returns true when a matching row was updated, false when the target wasn't found. */
export async function applyClientModeration(args: {
  projectId: string;
  targetType: ClientModerationTarget;
  targetId: string;
  status: ModerationStatusValue;
  reason?: string;
}): Promise<boolean> {
  const set = {
    moderationStatus: args.status,
    moderationReason: args.reason ?? null,
    moderatedAt: new Date(),
    moderatedById: null,
    moderatedByType: "client" as const,
  };
  if (args.targetType === "entity") {
    const [row] = await db.update(entities).set(set)
      .where(and(eq(entities.projectId, args.projectId), eq(entities.id, args.targetId))).returning({ id: entities.id });
    return !!row;
  }
  const [row] = await db.update(comments).set(set)
    .where(and(eq(comments.projectId, args.projectId), eq(comments.id, args.targetId))).returning({ id: comments.id });
  return !!row;
}
