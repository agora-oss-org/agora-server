// Hard-delete media cleanup (CONTENT_DELETE_MODE=hard). A hard content delete removes DB rows via FK
// cascades, but no cascade can reach MinIO/Supabase Storage — so the delete handlers collect the files
// rows FIRST (collectFileRows), hard-delete the parent row, then remove the objects asynchronously
// (removeMediaAsync, best-effort). Soft mode (the default) never calls into this module: tombstoned
// content is conceptually recoverable, so its media must survive.
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { comments, files } from "../db/schema/index.js";
import { getStorage } from "./storage/index.js";
import { logger } from "./logger.js";

/** The slice of a files row the cleanup needs (works for both Drizzle rows and tests). */
export interface FileRowLike {
  projectId: string;
  originalPath: string;
  image: unknown;
}

export type FileAssoc =
  | { entityId: string } // the entity's own files + its comments' files (comments cascade with it)
  | { commentId: string } // the comment's files + its reply subtree's files (parent_id cascade)
  | { chatMessageId: string }
  | { eventId: string };

/**
 * Derive the storage object keys for one files row. Variants carry bare keys
 * (`image.variants.*.path`); `original_path` stores the full PUBLIC URL, so the key is the substring
 * from the `${projectId}/` marker on — every upload key is built with that prefix, and this stays
 * correct even if S3_PUBLIC_URL changed since upload. A malformed original (no marker) is skipped.
 */
export function fileObjectKeys(row: FileRowLike): string[] {
  const keys = new Set<string>();
  const marker = `${row.projectId}/`;
  const idx = row.originalPath.indexOf(marker);
  if (idx >= 0) keys.add(row.originalPath.slice(idx));
  const variants = (row.image as { variants?: Record<string, { path?: unknown }> } | null)?.variants;
  if (variants && typeof variants === "object") {
    for (const v of Object.values(variants)) {
      if (v && typeof v.path === "string" && v.path) keys.add(v.path);
    }
  }
  return [...keys];
}

/**
 * Load the files rows a hard delete of `assoc` will cascade away. MUST be awaited BEFORE the parent
 * row delete — afterwards the rows (and with them the object keys) are gone.
 */
export async function collectFileRows(projectId: string, assoc: FileAssoc): Promise<FileRowLike[]> {
  if ("entityId" in assoc) {
    return db
      .select()
      .from(files)
      .where(
        and(
          eq(files.projectId, projectId),
          or(
            eq(files.entityId, assoc.entityId),
            inArray(
              files.commentId,
              db.select({ id: comments.id }).from(comments).where(eq(comments.entityId, assoc.entityId)),
            ),
          ),
        ),
      );
  }
  if ("commentId" in assoc) {
    // The parent_id FK cascades the whole reply subtree with the root comment — collect all of it.
    const subtree = await db.execute<{ id: string }>(sql`
      with recursive sub as (
        select id from comments where id = ${assoc.commentId}::uuid and project_id = ${projectId}::uuid
        union all
        select c.id from comments c join sub on c.parent_id = sub.id
      )
      select id from sub
    `);
    const ids = subtree.map((r) => r.id);
    if (!ids.length) return [];
    return db
      .select()
      .from(files)
      .where(and(eq(files.projectId, projectId), inArray(files.commentId, ids)));
  }
  if ("chatMessageId" in assoc) {
    return db
      .select()
      .from(files)
      .where(and(eq(files.projectId, projectId), eq(files.chatMessageId, assoc.chatMessageId)));
  }
  return db
    .select()
    .from(files)
    .where(and(eq(files.projectId, projectId), eq(files.eventId, assoc.eventId)));
}

/** Remove the storage objects for `rows`. Never throws — failure logs and is accepted. */
export async function removeMedia(rows: FileRowLike[], context: string): Promise<void> {
  const keys = [...new Set(rows.flatMap(fileObjectKeys))];
  if (!keys.length) return;
  try {
    await getStorage().remove(keys);
    logger.debug({ context, count: keys.length }, "storage: hard-delete media removed");
  } catch (err) {
    logger.error("storage: hard-delete media removal failed");
    logger.debug({ err, context, keys }, "storage: hard-delete media removal failed");
  }
}

/** Fire-and-forget wrapper for delete handlers (mirrors indexEntityAsync). */
export function removeMediaAsync(rows: FileRowLike[], context: string): void {
  void removeMedia(rows, context);
}
