// Integration: text search — /search/spaces + /search/users. These are plain ILIKE matches
// (semantic indexing is entities-only), so they need no VOYAGE_API_KEY and run against real data.
// Both are POST { query, limit? } and return a BARE array of { similarity, record }, where the
// derived relevance is exact=1 > prefix=0.9 > substring=0.7 (lib relevance()).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb } from "../../src/db/index.js";
import { profiles } from "../../src/db/schema/index.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("text search — spaces + users (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    owner = await createUser(projectId);
    B = base(projectId);

    await api("POST", `${B}/spaces`, { token: owner.token, body: { name: "Photography", slug: "photography", description: "share your photos" } });
    await api("POST", `${B}/spaces`, { token: owner.token, body: { name: "Photo Club", slug: "photo-club" } });
    await api("POST", `${B}/spaces`, { token: owner.token, body: { name: "Cooking", slug: "cooking" } });

    // deterministic handles (createUser only mints random usernames)
    await getDb().insert(profiles).values([
      { projectId, username: "ansel", name: "Ansel Adams" },
      { projectId, username: "ansel_fan", name: "Fan of Ansel" },
      { projectId, username: "chef_marie", name: "Marie Cook" },
    ]);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  const search = (kind: "spaces" | "users", query: string, limit?: number) =>
    api("POST", `${B}/search/${kind}`, { token: owner.token, body: { query, ...(limit ? { limit } : {}) } });

  it("requires a non-empty query", async () => {
    const r = await search("spaces", "  ");
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("search/missing-query");
  });

  it("matches spaces by name/slug/description and returns a bare ranked array", async () => {
    const r = await search("spaces", "photo");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);

    const names = r.body.map((x: any) => x.record.name).sort();
    expect(names).toEqual(["Photo Club", "Photography"]); // Cooking excluded
    for (const x of r.body) expect(x.similarity).toBeGreaterThanOrEqual(0.7);
  });

  it("scores an exact space-name match at 1", async () => {
    const r = await search("spaces", "Cooking");
    expect(r.body).toHaveLength(1);
    expect(r.body[0].record.name).toBe("Cooking");
    expect(r.body[0].similarity).toBe(1);
  });

  it("matches users by username/name and ranks exact above prefix", async () => {
    const r = await search("users", "ansel");
    expect(r.status).toBe(200);
    const usernames = r.body.map((x: any) => x.record.username);
    expect(usernames).toContain("ansel");
    expect(usernames).toContain("ansel_fan");
    expect(usernames).not.toContain("chef_marie");

    // exact username match sorts first with similarity 1
    expect(r.body[0].record.username).toBe("ansel");
    expect(r.body[0].similarity).toBe(1);
  });

  it("respects the limit", async () => {
    const r = await search("users", "ansel", 1);
    expect(r.body).toHaveLength(1);
  });
});
