// Server-side mention handling. The `mentions[]` array arriving on entity/comment/message writes is
// untrusted jsonb — parse it to well-formed tokens here, then validate ids against the DB in
// sanitizeMentions (below) before storing / fanning out. See docs/superpowers/specs/2026-07-07-mentions-design.md.
import type { Mention } from "@agora-server/contract";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { profiles, spaces } from "../db/schema/index.js";

/** Parse a raw jsonb `mentions` value into well-formed tokens, dropping anything structurally invalid.
 *  Tolerates legacy shapes (bare string id, `{ id }`) by coercing to a user token with an empty
 *  username (sanitizeMentions refills it from the DB). Dedupes by (type,id), first wins. Pure. */
export function parseMentionTokens(raw: unknown): Mention[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Mention[] = [];
  const push = (m: Mention) => {
    const key = `${m.type}:${m.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };
  for (const item of raw) {
    if (typeof item === "string") { if (item) push({ type: "user", id: item, username: "" }); continue; }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : typeof o.userId === "string" ? (o.userId as string) : null;
    if (!id) continue;
    if (o.type === "space") {
      if (typeof o.slug === "string" && o.slug) push({ type: "space", id, slug: o.slug });
      continue;
    }
    if (o.type === "user") {
      if (typeof o.username === "string") {
        push({ type: "user", id, username: o.username, ...(typeof o.foreignId === "string" ? { foreignId: o.foreignId } : {}) });
      }
      continue;
    }
    if (o.type !== undefined) continue; // unrecognized explicit type -> structurally invalid, drop
    if (typeof o.username === "string" || typeof o.slug === "string") continue; // decorated-but-untyped -> drop
    // Truly bare legacy shape ({ id }, no other fields) -> coerce to a user token, username refilled later.
    push({ type: "user", id, username: "" });
  }
  return out;
}

/** Parse + validate a raw `mentions` value against the DB: keep only tokens whose id is a real profile
 *  / non-deleted space IN THIS PROJECT, refreshing display fields (username/foreignId, slug) to the
 *  canonical DB values. Invalid tokens are dropped silently. DB-backed. */
export async function sanitizeMentions(projectId: string, raw: unknown): Promise<Mention[]> {
  const tokens = parseMentionTokens(raw);
  if (tokens.length === 0) return [];
  const userIds = tokens.filter((t): t is Extract<Mention, { type: "user" }> => t.type === "user").map((t) => t.id);
  const spaceIds = tokens.filter((t): t is Extract<Mention, { type: "space" }> => t.type === "space").map((t) => t.id);

  const db = getDb();
  const [userRows, spaceRows] = await Promise.all([
    userIds.length
      ? db.select({ id: profiles.id, username: profiles.username, foreignId: profiles.foreignId })
          .from(profiles).where(and(eq(profiles.projectId, projectId), inArray(profiles.id, userIds)))
      : Promise.resolve([] as { id: string; username: string | null; foreignId: string | null }[]),
    spaceIds.length
      ? db.select({ id: spaces.id, slug: spaces.slug })
          .from(spaces).where(and(eq(spaces.projectId, projectId), inArray(spaces.id, spaceIds), isNull(spaces.deletedAt)))
      : Promise.resolve([] as { id: string; slug: string | null }[]),
  ]);
  const userById = new Map(userRows.map((r) => [r.id, r]));
  const spaceById = new Map(spaceRows.map((r) => [r.id, r]));

  const out: Mention[] = [];
  for (const t of tokens) {
    if (t.type === "user") {
      const row = userById.get(t.id);
      if (!row) continue;
      out.push({ type: "user", id: t.id, username: row.username ?? "", ...(row.foreignId ? { foreignId: row.foreignId } : {}) });
    } else {
      const row = spaceById.get(t.id);
      if (!row || !row.slug) continue;
      out.push({ type: "space", id: t.id, slug: row.slug });
    }
  }
  return out;
}
