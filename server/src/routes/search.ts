// /v7/:projectId/search/*
// content = semantic (Voyage embed query -> match_entities pgvector RPC), returns ContentSearchResult[].
// ask     = RAG Q&A: same retrieval, then stream a Claude answer over SSE (token/sources/done/error).
// spaces/users = plain text (ILIKE), no embeddings needed.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, eq, or, ilike, isNull, inArray, sql } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { db } from "../db/index.js";
import { entities, spaces, profiles } from "../db/schema/index.js";
import { shapeEntity, shapeSpace, shapeUser } from "../lib/shape.js";
import { embedText, embeddingsEnabled } from "../lib/embeddings.js";
import { streamText, llmEnabled } from "../lib/llm.js";

// Mirrors the SDK's ContentSearchResult (interfaces/models). Only entities are embedded today,
// so every record is a shaped Entity; the union is kept for forward-compat with comments/messages.
type ContentSearchResult = { sourceType: "entity" | "comment" | "message"; similarity: number; record: unknown };
type AskBody = { query?: string; sourceTypes?: string[]; spaceId?: string; conversationId?: string; limit?: number };

/** Read { query, limit } from a POST body (the SDK's search hooks post JSON, not query params). */
async function searchBody(c: any): Promise<{ q: string; limit: number }> {
  const body = (await c.req.json().catch(() => ({}))) as { query?: string; limit?: number };
  const q = (body.query ?? "").trim();
  if (!q) throw Errors.badRequest("search/missing-query", "query is required", "query");
  return { q, limit: Math.min(50, Math.max(1, Number(body.limit) || 20)) };
}

// spaces/users aren't embedded (semantic indexing is entities-only — see TODO P2), so these are
// ILIKE matches. We still owe the SDK a `similarity` number per result, so derive a cheap relevance
// score from how the query lands against the matched text (exact > prefix > substring).
function relevance(q: string, ...fields: (string | null | undefined)[]): number {
  const needle = q.toLowerCase();
  let best = 0.5; // floor: it matched the ILIKE filter on some column
  for (const f of fields) {
    if (!f) continue;
    const s = f.toLowerCase();
    if (s === needle) best = Math.max(best, 1);
    else if (s.startsWith(needle)) best = Math.max(best, 0.9);
    else if (s.includes(needle)) best = Math.max(best, 0.7);
  }
  return best;
}

/** Semantic retrieval shared by /content and /ask. Returns results in similarity order. */
async function retrieveContent(
  projectId: string,
  q: string,
  opts: { sourceTypes?: string[]; spaceId?: string | null; limit?: number }
): Promise<ContentSearchResult[]> {
  // Only entity embeddings exist; if the caller restricts away from "entity", there's nothing to match.
  if (Array.isArray(opts.sourceTypes) && !opts.sourceTypes.includes("entity")) return [];
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 20));
  const space = opts.spaceId ?? null;
  const vec = await embedText(q, "query");
  const lit = `[${vec.join(",")}]`;
  const matches = (await db.execute(sql`
    select entity_id, similarity
    from match_entities(${projectId}::uuid, ${lit}::vector, ${limit}, ${space}::uuid)
  `)) as unknown as { entity_id: string; similarity: number }[];
  const ids = matches.map((m) => m.entity_id);
  if (ids.length === 0) return [];
  const rows = await db.select().from(entities)
    .where(and(eq(entities.projectId, projectId), inArray(entities.id, ids), isNull(entities.deletedAt)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return matches
    .map((m) => {
      const row = byId.get(m.entity_id);
      return row ? { sourceType: "entity" as const, similarity: m.similarity, record: shapeEntity(row) } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}

const ASK_SYSTEM =
  "You are a helpful assistant answering questions about a community's content. " +
  "Answer using ONLY the numbered sources provided by the user. Cite sources inline as [1], [2], etc. " +
  "If the sources don't contain the answer, say so plainly — do not invent facts. Be concise.";

/** Render retrieved sources into a numbered context block for the prompt. */
function buildPrompt(q: string, sources: ContentSearchResult[]): string {
  if (sources.length === 0) {
    return `Question: ${q}\n\n(No relevant content was found in this community.)`;
  }
  const blocks = sources.map((s, i) => {
    const r = s.record as { title?: string | null; content?: string | null };
    const title = r.title ? `Title: ${r.title}\n` : "";
    return `[${i + 1}] ${title}${r.content ?? ""}`.trim();
  });
  return `Question: ${q}\n\nSources:\n${blocks.join("\n\n")}`;
}

export const searchRoutes = new Hono<{ Variables: Variables }>()
  // POST per the SDK's useSearchContent: body { query, sourceTypes?, spaceId?, limit? } →
  // returns a BARE array of ContentSearchResult { sourceType, similarity, record }.
  .post("/content", async (c) => {
    if (!embeddingsEnabled()) throw Errors.badRequest("search/embeddings-disabled", "Semantic search is not configured (VOYAGE_API_KEY unset)");
    const body = (await c.req.json().catch(() => ({}))) as AskBody;
    const q = (body.query ?? "").trim();
    if (!q) throw Errors.badRequest("search/missing-query", "query is required", "query");
    const results = await retrieveContent(c.var.projectId, q, body);
    return c.json(results);
  })
  // POST per the SDK's useAskContent: body { query, sourceTypes?, spaceId?, conversationId?, limit? }.
  // Streams SSE: "token" {content} (repeated) → "sources" (ContentSearchResult[]) → "done" | "error".
  .post("/ask", async (c) => {
    if (!embeddingsEnabled()) throw Errors.badRequest("search/embeddings-disabled", "Semantic search is not configured (VOYAGE_API_KEY unset)");
    if (!llmEnabled()) throw Errors.badRequest("search/llm-disabled", "Ask is not configured (ANTHROPIC_API_KEY unset)");
    const body = (await c.req.json().catch(() => ({}))) as AskBody;
    const q = (body.query ?? "").trim();
    if (!q) throw Errors.badRequest("search/missing-query", "query is required", "query");

    // Retrieve before opening the stream so retrieval failures surface as a normal JSON error.
    const sources = await retrieveContent(c.var.projectId, q, body);
    const prompt = buildPrompt(q, sources);

    return streamSSE(c, async (stream) => {
      try {
        for await (const delta of streamText({ system: ASK_SYSTEM, prompt })) {
          await stream.writeSSE({ event: "token", data: JSON.stringify({ content: delta }) });
        }
        await stream.writeSSE({ event: "sources", data: JSON.stringify(sources) });
        await stream.writeSSE({ event: "done", data: "" });
      } catch (err: any) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: err?.message ?? "Ask failed" }) });
      }
    });
  })
  // POST per the SDK's useSearchSpaces: body { query, limit? } → BARE SpaceSearchResult[] { similarity, record }.
  .post("/spaces", async (c) => {
    const { q, limit } = await searchBody(c);
    const like = `%${q}%`;
    const rows = await db.select().from(spaces)
      .where(and(
        eq(spaces.projectId, c.var.projectId),
        isNull(spaces.deletedAt),
        or(ilike(spaces.name, like), ilike(spaces.slug, like), ilike(spaces.description, like))
      ))
      .limit(limit);
    const results = rows
      .map((r) => ({ similarity: relevance(q, r.name, r.slug, r.description), record: shapeSpace(r) }))
      .sort((a, b) => b.similarity - a.similarity);
    return c.json(results);
  })
  // POST per the SDK's useSearchUsers: body { query, limit? } → BARE UserSearchResult[] { similarity, record }.
  .post("/users", async (c) => {
    const { q, limit } = await searchBody(c);
    const like = `%${q}%`;
    const rows = await db.select().from(profiles)
      .where(and(
        eq(profiles.projectId, c.var.projectId),
        or(ilike(profiles.username, like), ilike(profiles.name, like))
      ))
      .limit(limit);
    const results = rows
      .map((r) => ({ similarity: relevance(q, r.username, r.name), record: shapeUser(r) }))
      .sort((a, b) => b.similarity - a.similarity);
    return c.json(results);
  });
