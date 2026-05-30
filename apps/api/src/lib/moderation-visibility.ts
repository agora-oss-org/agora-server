// Read-path enforcement for moderation-"removed" content, driven by the per-project moderation
// config (lib/moderation-config.ts). Removed entities/comments must not reach normal readers:
//   - "hide"        → excluded from list queries (excludeRemovedSql) + 404 on single reads (shouldHide)
//   - "placeholder" → kept but blanked in the shaped output (shouldRedact + redactEntity/redactComment)
// Operators bypass entirely (they review removed content via the admin queue).
import type { Context } from "hono";
import { or, isNull, ne, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { entities, comments } from "../db/schema/index.js";
import { getModerationConfig, type RemovedContentBehavior } from "./moderation-config.js";

type Ctx = Context<{ Variables: Variables }>;

export interface RemovedPolicy {
  privileged: boolean; // operator → sees removed content (for review); skips all gating
  behavior: RemovedContentBehavior;
}

/** Resolve the per-request removed-content policy (project config + whether the caller is privileged). */
export async function removedPolicy(c: Ctx): Promise<RemovedPolicy> {
  const { removedContentBehavior } = await getModerationConfig(c.var.projectId);
  return { privileged: c.var.auth?.isOperator === true, behavior: removedContentBehavior };
}

/**
 * SQL to exclude moderation-removed rows from a list query — only when hiding and the viewer is not
 * privileged. Returns undefined when removed rows should stay (placeholder mode or operator), so the
 * caller can `if (cond) conds.push(cond)`. `<> 'removed'` alone would drop NULLs, hence the OR.
 */
export function excludeRemovedSql(
  p: RemovedPolicy,
  table: typeof entities | typeof comments,
): SQL | undefined {
  if (p.privileged || p.behavior !== "hide") return undefined;
  return or(isNull(table.moderationStatus), ne(table.moderationStatus, "removed"));
}

/** True when a single removed item should 404 for this viewer (hide mode, non-privileged). */
export function shouldHide(p: RemovedPolicy, moderationStatus: string | null | undefined): boolean {
  return !p.privileged && p.behavior === "hide" && moderationStatus === "removed";
}

/** True when removed content should be blanked in-place for this viewer (placeholder mode). */
export function shouldRedact(p: RemovedPolicy, moderationStatus: string | null | undefined): boolean {
  return !p.privileged && p.behavior === "placeholder" && moderationStatus === "removed";
}

/** Blank a shaped entity in place ([removed] placeholder): drop title/content/media. */
export function redactEntity(e: any): any {
  e.title = null;
  e.content = null;
  e.files = [];
  e.attachments = [];
  return e;
}

/** Blank a shaped comment in place ([removed] placeholder): drop content/gif. */
export function redactComment(c: any): any {
  c.content = null;
  c.gif = null;
  return c;
}

/**
 * Apply placeholder redaction across a shaped list (no-op when hiding/privileged — those rows are
 * already excluded at query time). Mutates and returns the array.
 */
export function redactRemovedList<T extends { moderationStatus?: string | null }>(
  p: RemovedPolicy,
  items: T[],
  kind: "entity" | "comment",
): T[] {
  if (p.privileged || p.behavior !== "placeholder") return items;
  const redact = kind === "entity" ? redactEntity : redactComment;
  for (const it of items) if (it.moderationStatus === "removed") redact(it);
  return items;
}
