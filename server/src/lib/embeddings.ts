// Voyage AI embeddings (Anthropic-recommended). Used for semantic content search.
// input_type matters for retrieval quality: "query" for searches, "document" for stored text.
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { entityEmbeddings } from "../db/schema/index.js";
import { env } from "./env.js";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

export function embeddingsEnabled(): boolean {
  return !!env.VOYAGE_API_KEY;
}

/** Embed a single string. Throws if the provider isn't configured. */
export async function embedText(text: string, inputType: "query" | "document"): Promise<number[]> {
  if (!env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY not configured");
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.VOYAGE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: [text],
      model: env.VOYAGE_MODEL,
      input_type: inputType,
      output_dimension: env.EMBEDDING_DIMENSIONS,
    }),
  });
  if (!res.ok) throw new Error(`Voyage error ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  const vec = json.data?.[0]?.embedding;
  if (!vec) throw new Error("Voyage returned no embedding");
  return vec;
}

/** Embed an entity's text and upsert into entity_embeddings. No-op if embeddings are off or text is empty. */
export async function indexEntity(projectId: string, entityId: string, text: string | null | undefined): Promise<void> {
  if (!embeddingsEnabled() || !text?.trim()) return;
  const embedding = await embedText(text, "document");
  await db.insert(entityEmbeddings)
    .values({ entityId, projectId, embedding })
    .onConflictDoUpdate({ target: entityEmbeddings.entityId, set: { embedding, updatedAt: new Date() } });
}

/** Fire-and-forget indexing for write paths — never let embedding failures break the request. */
export function indexEntityAsync(projectId: string, entityId: string, text: string | null | undefined): void {
  indexEntity(projectId, entityId, text).catch((e) => console.error("indexEntity failed:", e?.message ?? e));
}
