// Integration: the match_content RPC (semantic search across entity|comment|message). Embeddings
// are inserted directly with synthetic vectors so this is deterministic without a Voyage key —
// it exercises source-type filtering, the entity/comment space scope, message exclusion under a
// space filter, liveness (soft-deleted rows excluded), and similarity ordering.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { contentEmbeddings, comments } from "../../src/db/schema/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DIMS = 1024;
const vec = (...head: number[]) => { const a = new Array(DIMS).fill(0); head.forEach((x, i) => (a[i] = x)); return a; };
const lit = (a: number[]) => `[${a.join(",")}]`;

describe("match_content semantic search RPC (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let B: string;
  const ent = {} as Record<string, string>;
  let commentId: string, messageId: string, spaceId: string;

  const match = async (types: string[] | null, space: string | null) => {
    const typesArg = types ? sql`array[${sql.join(types.map((t) => sql`${t}`), sql`, `)}]::text[]` : sql`null::text[]`;
    // Privileged call (p_privileged => true): exercise the full result set across all source types.
    // Messages are membership-gated in match_content (migration 0019), so a viewer-less, non-privileged
    // call would correctly drop them — privileged review mode is what surfaces every source type.
    const rows = (await getDb().execute(sql`
      select source_type, source_id, similarity
      from match_content(${projectId}::uuid, ${lit(vec(1))}::vector, 20, ${typesArg}, ${space}::uuid, null::uuid, true)
    `)) as unknown as { source_type: string; source_id: string; similarity: number }[];
    return [...rows];
  };

  beforeAll(async () => {
    projectId = await createProject();
    owner = await createUser(projectId);
    B = base(projectId);

    // a space + an entity inside it, plus a spaceless entity, a comment, and a chat message
    const space = await api("POST", `${B}/spaces`, { token: owner.token, body: { name: "Space" } });
    spaceId = space.body.id;
    ent.free = (await api("POST", `${B}/entities`, { token: owner.token, body: { title: "Free", content: "ramen" } })).body.id;
    ent.inSpace = (await api("POST", `${B}/entities`, { token: owner.token, body: { title: "Spaced", content: "ramen", spaceId } })).body.id;
    commentId = (await api("POST", `${B}/comments`, { token: owner.token, body: { entityId: ent.free, content: "a comment about ramen" } })).body.id;
    const convo = await api("POST", `${B}/chat/conversations`, { token: owner.token, body: { name: "C", type: "group" } });
    messageId = (await api("POST", `${B}/chat/conversations/${convo.body.id}/messages`, { token: owner.token, body: { content: "a message about ramen" } })).body.id;

    // The write paths embed asynchronously when VOYAGE_API_KEY is set; let that settle, then
    // clear and replace with deterministic synthetic vectors so the RPC assertions are stable
    // regardless of whether Voyage is configured.
    // (cosine sim vs query e0: free=1, inSpace=1, comment=0.8, message=0.6)
    await sleep(2000);
    await getDb().delete(contentEmbeddings).where(eq(contentEmbeddings.projectId, projectId));
    await getDb().insert(contentEmbeddings).values([
      { projectId, sourceType: "entity", sourceId: ent.free, embedding: vec(1) },
      { projectId, sourceType: "entity", sourceId: ent.inSpace, embedding: vec(1) },
      { projectId, sourceType: "comment", sourceId: commentId, embedding: vec(0.8, 0.6) },
      { projectId, sourceType: "message", sourceId: messageId, embedding: vec(0.6, 0.8) },
    ]);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("returns all source types by default, ordered by similarity", async () => {
    const all = await match(null, null);
    const ids = all.map((r) => r.source_id);
    expect(ids).toEqual(expect.arrayContaining([ent.free, ent.inSpace, commentId, messageId]));
    expect(all[all.length - 1].source_id).toBe(messageId); // lowest similarity last
  });

  it("honors sourceTypes filtering", async () => {
    expect((await match(["comment"], null)).map((r) => r.source_id)).toEqual([commentId]);
    const entMsg = (await match(["entity", "message"], null)).map((r) => r.source_id);
    expect(entMsg).toEqual(expect.arrayContaining([ent.free, ent.inSpace, messageId]));
    expect(entMsg).not.toContain(commentId);
  });

  it("space filter scopes entities/comments and excludes messages", async () => {
    const inSpace = (await match(null, spaceId)).map((r) => r.source_id);
    expect(inSpace).toEqual([ent.inSpace]); // spaceless entity, its comment, and the message all drop out
  });

  it("excludes soft-deleted content (liveness)", async () => {
    await getDb().update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, commentId));
    expect((await match(["comment"], null)).map((r) => r.source_id)).toEqual([]);
  });
});
