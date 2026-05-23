// /v7/:projectId/search/*
// content = semantic (Voyage embed query -> match_entities pgvector RPC).
// spaces/users = plain text (ILIKE), no embeddings needed.
import { Hono } from "hono";
import { and, eq, or, ilike, isNull, inArray, sql } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { db } from "../db/index.js";
import { entities, spaces, profiles } from "../db/schema/index.js";
import { readPagination } from "../http/envelope.js";
import { shapeEntity, shapeSpace, shapeUser } from "../lib/shape.js";
import { embedText, embeddingsEnabled } from "../lib/embeddings.js";

function query(c: any): string {
  const q = (c.req.query("query") ?? c.req.query("q") ?? "").trim();
  if (!q) throw Errors.badRequest("search/missing-query", "query is required", "query");
  return q;
}

export const searchRoutes = new Hono<{ Variables: Variables }>()
  // POST per the SDK's useSearchContent: body { query, sourceTypes?, spaceId?, limit? } →
  // returns a BARE array of ContentSearchResult { sourceType, similarity, record }.
  .post("/content", async (c) => {
    if (!embeddingsEnabled()) throw Errors.badRequest("search/embeddings-disabled", "Semantic search is not configured (VOYAGE_API_KEY unset)");
    const body = (await c.req.json().catch(() => ({}))) as { query?: string; sourceTypes?: string[]; spaceId?: string; limit?: number };
    const q = (body.query ?? "").trim();
    if (!q) throw Errors.badRequest("search/missing-query", "query is required", "query");
    // Only entity embeddings are indexed; if the caller restricts to other source types, return empty.
    if (Array.isArray(body.sourceTypes) && !body.sourceTypes.includes("entity")) return c.json([]);
    const limit = Math.min(50, Math.max(1, Number(body.limit) || 20));
    const space = body.spaceId ?? null;
    const vec = await embedText(q, "query");
    const lit = `[${vec.join(",")}]`;
    const matches = (await db.execute(sql`
      select entity_id, similarity
      from match_entities(${c.var.projectId}::uuid, ${lit}::vector, ${limit}, ${space}::uuid)
    `)) as unknown as { entity_id: string; similarity: number }[];
    const ids = matches.map((m) => m.entity_id);
    if (ids.length === 0) return c.json([]);
    const rows = await db.select().from(entities)
      .where(and(eq(entities.projectId, c.var.projectId), inArray(entities.id, ids), isNull(entities.deletedAt)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    // ContentSearchResult[] in similarity order from the RPC
    const results = matches
      .map((m) => { const row = byId.get(m.entity_id); return row ? { sourceType: "entity" as const, similarity: m.similarity, record: shapeEntity(row) } : null; })
      .filter(Boolean);
    return c.json(results);
  })
  .get("/spaces", async (c) => {
    const q = query(c);
    const { limit } = readPagination(c, { page: 1, limit: 20 });
    const like = `%${q}%`;
    const rows = await db.select().from(spaces)
      .where(and(
        eq(spaces.projectId, c.var.projectId),
        isNull(spaces.deletedAt),
        or(ilike(spaces.name, like), ilike(spaces.slug, like), ilike(spaces.description, like))
      ))
      .limit(limit);
    return c.json({ data: rows.map((r) => shapeSpace(r)) });
  })
  .get("/users", async (c) => {
    const q = query(c);
    const { limit } = readPagination(c, { page: 1, limit: 20 });
    const like = `%${q}%`;
    const rows = await db.select().from(profiles)
      .where(and(
        eq(profiles.projectId, c.var.projectId),
        or(ilike(profiles.username, like), ilike(profiles.name, like))
      ))
      .limit(limit);
    return c.json({ data: rows.map(shapeUser) });
  });
