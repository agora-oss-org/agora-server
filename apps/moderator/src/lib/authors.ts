// Resolve the author (poster) for a batch of analyses: target → userId (entities/comments) → profile
// name. Returns a map keyed by targetId so the queue can attach each flag's poster. Message targets
// aren't resolved here (graceful null). One round of batched lookups, no N+1.
import { inArray } from "drizzle-orm";
import type { UserSummary } from "@agora-server/contract";
import { db } from "../db/index.js";
import { entities, comments, profiles } from "../db/schema.js";

interface TargetRow {
  targetType: "entity" | "comment" | "message";
  targetId: string;
}

export async function loadAuthors(rows: TargetRow[]): Promise<Map<string, UserSummary | null>> {
  const out = new Map<string, UserSummary | null>();
  const entityIds = [...new Set(rows.filter((r) => r.targetType === "entity").map((r) => r.targetId))];
  const commentIds = [...new Set(rows.filter((r) => r.targetType === "comment").map((r) => r.targetId))];
  if (!entityIds.length && !commentIds.length) return out;

  const [entityRows, commentRows] = await Promise.all([
    entityIds.length
      ? db.select({ id: entities.id, userId: entities.userId }).from(entities).where(inArray(entities.id, entityIds))
      : Promise.resolve([] as { id: string; userId: string | null }[]),
    commentIds.length
      ? db.select({ id: comments.id, userId: comments.userId }).from(comments).where(inArray(comments.id, commentIds))
      : Promise.resolve([] as { id: string; userId: string | null }[]),
  ]);

  const targetAuthorId = new Map<string, string | null>();
  for (const e of entityRows) targetAuthorId.set(e.id, e.userId);
  for (const c of commentRows) targetAuthorId.set(c.id, c.userId);

  const userIds = [...new Set([...targetAuthorId.values()].filter((x): x is string => !!x))];
  const profileRows = userIds.length
    ? await db.select({ id: profiles.id, username: profiles.username, name: profiles.name, reputation: profiles.reputation }).from(profiles).where(inArray(profiles.id, userIds))
    : [];
  const byUser = new Map(profileRows.map((p) => [p.id, { id: p.id, username: p.username, name: p.name, reputation: p.reputation } as UserSummary]));

  for (const r of rows) {
    const uid = targetAuthorId.get(r.targetId) ?? null;
    out.set(r.targetId, uid ? byUser.get(uid) ?? null : null);
  }
  return out;
}
