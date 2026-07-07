// Integration: includeChildSpaces (SDK v7.8.2 #38) — a resolved {self ∪ descendants} space set
// scopes semantic search via match_content's new p_space_ids arg (migration 0061), driven by
// lib/space-tree.ts resolveSpaceSubtree — the exact composition retrieveContent (routes/search.ts)
// performs when `includeChildSpaces: true` is passed alongside a spaceId.
//
// This drives the real match_content RPC + resolveSpaceSubtree with a synthetic embedding vector
// (mirrors semantic-search.test.ts), rather than POSTing /search/content directly: the integration
// harness hermetically forces VOYAGE_API_KEY empty (vitest.integration.config.ts) so the route's
// `embeddingsEnabled()` gate always 400s — going through embedText would mean either faking the env
// var (forcing a real, non-deterministic network call to Voyage) or mocking the module (masking the
// exact query construction we want to verify). Exercising the RPC directly with resolveSpaceSubtree's
// real output covers the same code path retrieveContent takes, deterministically and hermetically.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { contentEmbeddings } from "../../src/db/schema/index.js";
import { resolveSpaceSubtree } from "../../src/lib/space-tree.js";

const DIMS = 1024;
const vec = (...head: number[]) => { const a = new Array(DIMS).fill(0); head.forEach((x, i) => (a[i] = x)); return a; };
const lit = (a: number[]) => `[${a.join(",")}]`;

describe("match_content includeChildSpaces / p_space_ids (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let B: string;
  let parentSpaceId: string, childSpaceId: string, childEntityId: string, parentEntityId: string;

  // Mirrors retrieveContent's own arg-building (routes/search.ts): p_space xor p_space_ids.
  const match = async (space: string | null, spaceIds: string[] | null) => {
    const spaceIdsArg = spaceIds
      ? sql`array[${sql.join(spaceIds.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]`
      : sql`null::uuid[]`;
    const rows = (await getDb().execute(sql`
      select source_type, source_id, similarity
      from match_content(${projectId}::uuid, ${lit(vec(1))}::vector, 20, null::text[], ${space}::uuid,
                         null::uuid, true, false, ${spaceIdsArg})
    `)) as unknown as { source_type: string; source_id: string; similarity: number }[];
    return rows;
  };

  beforeAll(async () => {
    projectId = await createProject();
    owner = await createUser(projectId);
    B = base(projectId);

    const parent = await api("POST", `${B}/spaces`, { token: owner.token, body: { name: "Parent" } });
    parentSpaceId = parent.body.id;
    const child = await api("POST", `${B}/spaces`, {
      token: owner.token,
      body: { name: "Child", parentSpaceId },
    });
    childSpaceId = child.body.id;

    parentEntityId = (await api("POST", `${B}/entities`, {
      token: owner.token,
      body: { title: "ParentEnt", content: "ramen", spaceId: parentSpaceId },
    })).body.id;
    childEntityId = (await api("POST", `${B}/entities`, {
      token: owner.token,
      body: { title: "ChildEnt", content: "ramen", spaceId: childSpaceId },
    })).body.id;

    // Deterministic synthetic embeddings — no VOYAGE_API_KEY dependency (see file header).
    await getDb().delete(contentEmbeddings).where(eq(contentEmbeddings.projectId, projectId));
    await getDb().insert(contentEmbeddings).values([
      { projectId, sourceType: "entity", sourceId: parentEntityId, embedding: vec(1) },
      { projectId, sourceType: "entity", sourceId: childEntityId, embedding: vec(1) },
    ]);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("resolveSpaceSubtree returns {self, child}", async () => {
    const ids = await resolveSpaceSubtree(projectId, parentSpaceId);
    expect(ids.sort()).toEqual([parentSpaceId, childSpaceId].sort());
  });

  it("a plain p_space filter (no includeChildSpaces) excludes the child-space entity", async () => {
    const ids = (await match(parentSpaceId, null)).map((r) => r.source_id);
    expect(ids).toEqual([parentEntityId]);
    expect(ids).not.toContain(childEntityId);
  });

  it("p_space_ids from the resolved subtree includes both parent- and child-space entities", async () => {
    const subtree = await resolveSpaceSubtree(projectId, parentSpaceId);
    const ids = (await match(null, subtree)).map((r) => r.source_id);
    expect(ids).toEqual(expect.arrayContaining([parentEntityId, childEntityId]));
  });

  it("null p_space_ids is behaviorally identical to omitting the arg (today's behavior preserved)", async () => {
    const withNull = (await match(null, null)).map((r) => r.source_id).sort();
    const rows = (await getDb().execute(sql`
      select source_id from match_content(${projectId}::uuid, ${lit(vec(1))}::vector, 20, null::text[],
                                          null::uuid, null::uuid, true, false)
    `)) as unknown as { source_id: string }[];
    const withoutArg = rows.map((r) => r.source_id).sort();
    expect(withNull).toEqual(withoutArg);
  });
});
