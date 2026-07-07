// Server-side mention handling. The `mentions[]` array arriving on entity/comment/message writes is
// untrusted jsonb — parse it to well-formed tokens here, then validate ids against the DB in
// sanitizeMentions (below) before storing / fanning out. See docs/superpowers/specs/2026-07-07-mentions-design.md.
import type { Mention } from "@agora-server/contract";

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
