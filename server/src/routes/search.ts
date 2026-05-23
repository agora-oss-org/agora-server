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
import { readPagination } from "../http/envelope.js";
import { shapeEntity, shapeSpace, shapeUser } from "../lib/shape.js";
import { embedText, embeddingsEnabled } from "../lib/embeddings.js";
import { streamText, llmEnabled } from "../lib/llm.js";

// Mirrors the SDK's ContentSearchResult (interfaces/models). Only entities are embedded today,
// so every record is a shaped Entity; the union is kept for forward-compat with comments/messages.
type ContentSearchResult = { sourceType: "entity" | "comment" | "message"; similarity: number; record: unknown };
type AskBody = { query?: string; sourceTypes?: string[]; spaceId?: string; conversationId?: string; limit?: number };

function query(c: any): string {
  const q = (c.req.query("query") ?? c.req.query("q") ?? "").trim();
  if (!q) throw Errors.badRequest("search/missing-query", "query is required", "query");
  return q;
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
