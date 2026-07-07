import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createProject, createUser, deleteProject } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { spaces } from "../../src/db/schema/index.js";
import { randomUUID } from "node:crypto";
import { sanitizeMentions } from "../../src/lib/mentions.js";

describe("sanitizeMentions (integration)", () => {
  let projectId: string; let foreignProjectId: string;
  let alice: { id: string; token: string };
  let foreign: { id: string; token: string };
  let spaceId: string;

  beforeAll(async () => {
    [projectId, foreignProjectId] = await Promise.all([createProject(), createProject()]);
    [alice, foreign] = await Promise.all([createUser(projectId), createUser(foreignProjectId)]);
    const [sp] = await getDb().insert(spaces).values({
      projectId, shortId: randomUUID().slice(0, 8), name: "Dev", slug: "dev", userId: alice.id,
    }).returning();
    spaceId = sp!.id;
  });
  afterAll(async () => { await Promise.all([deleteProject(projectId), deleteProject(foreignProjectId)]); });

  it("keeps a valid in-project user token and refreshes its username from the DB", async () => {
    const out = await sanitizeMentions(projectId, [{ type: "user", id: alice.id, username: "stale" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "user", id: alice.id });
    expect((out[0] as any).username).not.toBe("stale"); // refreshed to the canonical value
  });

  it("drops a cross-project user token (no cross-tenant mention)", async () => {
    expect(await sanitizeMentions(projectId, [{ type: "user", id: foreign.id, username: "x" }])).toEqual([]);
  });

  it("drops a non-existent user token", async () => {
    expect(await sanitizeMentions(projectId, [{ type: "user", id: randomUUID(), username: "ghost" }])).toEqual([]);
  });

  it("keeps a valid in-project space token and refreshes its slug", async () => {
    const out = await sanitizeMentions(projectId, [{ type: "space", id: spaceId, slug: "stale" }]);
    expect(out).toEqual([{ type: "space", id: spaceId, slug: "dev" }]);
  });

  it("drops a cross-project space token", async () => {
    const [foreignSpace] = await getDb().insert(spaces).values({
      projectId: foreignProjectId, shortId: randomUUID().slice(0, 8), name: "Other", slug: "other", userId: foreign.id,
    }).returning();
    expect(await sanitizeMentions(projectId, [{ type: "space", id: foreignSpace!.id, slug: "other" }])).toEqual([]);
  });

  it("returns [] for empty/nullish input", async () => {
    expect(await sanitizeMentions(projectId, null)).toEqual([]);
    expect(await sanitizeMentions(projectId, [])).toEqual([]);
  });
});
