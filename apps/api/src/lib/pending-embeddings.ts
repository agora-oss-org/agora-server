// The durable side of the outbound embed throttle (lib/embed-throttle.ts). When a project's write-path
// breaker is tripped, indexContent enqueues the skipped item here instead of dropping it; the drain cron
// replays the backlog into content_embeddings at a deliberately bounded pace (its batch size × cadence),
// so the backfill can never re-blow Voyage even while the live path is still tripped.
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { contentEmbeddings, pendingEmbeddings } from "../db/schema/index.js";
import { embedText, embeddingsEnabled, type SourceType } from "./embeddings.js";
import { env } from "./env.js";
import { logger } from "./logger.js";

let capWarned = false;

/**
 * Record a skipped write-path embed as a durable "needs embedding" flag. Upserts on (sourceType,
 * sourceId) so the latest text wins if the row was edited while paused. When EMBED_THROTTLE_MAX_PENDING
 * is set and the table is at the cap, NEW flags are dropped (logged once) — existing ones still refresh.
 */
export async function enqueuePending(
  projectId: string,
  sourceType: SourceType,
  sourceId: string,
  text: string,
): Promise<void> {
  const cap = env.EMBED_THROTTLE_MAX_PENDING;
  if (cap) {
    const rows = (await db.execute(sql`select count(*)::int as n from pending_embeddings`)) as unknown as { n: number }[];
    if (Number(rows[0]?.n ?? 0) >= cap) {
      // At the cap: refresh an already-pending item but never grow the table.
      await db.update(pendingEmbeddings).set({ text, createdAt: new Date() })
        .where(and(eq(pendingEmbeddings.sourceType, sourceType), eq(pendingEmbeddings.sourceId, sourceId)));
      if (!capWarned) {
        capWarned = true;
        logger.warn({ cap }, "embed-throttle: pending_embeddings at cap — dropping new flags");
      }
      return;
    }
  }
  await db.insert(pendingEmbeddings)
    .values({ projectId, sourceType, sourceId, text })
    .onConflictDoUpdate({
      target: [pendingEmbeddings.sourceType, pendingEmbeddings.sourceId],
      set: { text, projectId, createdAt: new Date() },
    });
}

/**
 * Replay up to `limit` of the oldest pending embeds into content_embeddings, deleting each on success.
 * Deliberately decoupled from the live breaker: the operator bounds the Voyage pace via `limit` and the
 * cron cadence. No-op when embeddings are disabled. Failures bump `attempts` and stay queued.
 */
export async function drainPendingEmbeddings(limit = 100): Promise<{ drained: number; failed: number }> {
  if (!embeddingsEnabled()) return { drained: 0, failed: 0 };
  const rows = await db.select().from(pendingEmbeddings).orderBy(asc(pendingEmbeddings.createdAt)).limit(limit);
  let drained = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const embedding = await embedText(row.text, "document");
      await db.insert(contentEmbeddings)
        .values({ projectId: row.projectId, sourceType: row.sourceType, sourceId: row.sourceId, embedding })
        .onConflictDoUpdate({
          target: [contentEmbeddings.sourceType, contentEmbeddings.sourceId],
          set: { embedding, updatedAt: new Date() },
        });
      await db.delete(pendingEmbeddings)
        .where(and(eq(pendingEmbeddings.sourceType, row.sourceType), eq(pendingEmbeddings.sourceId, row.sourceId)));
      drained += 1;
    } catch (e) {
      failed += 1;
      await db.update(pendingEmbeddings).set({ attempts: sql`${pendingEmbeddings.attempts} + 1` })
        .where(and(eq(pendingEmbeddings.sourceType, row.sourceType), eq(pendingEmbeddings.sourceId, row.sourceId)))
        .catch(() => {});
      logger.debug({ err: e, sourceType: row.sourceType }, "drainPendingEmbeddings: item failed");
    }
  }
  if (failed) logger.error("draining pending embeddings: some items failed");
  return { drained, failed };
}
