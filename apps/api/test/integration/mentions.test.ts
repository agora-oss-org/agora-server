import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createProject, createUser, deleteProject, api, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { spaces, appNotifications } from "../../src/db/schema/index.js";
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

describe("mention write validation + fan-out (integration)", () => {
  let projectId: string; let foreignProjectId: string; let B: string;
  let author: { id: string; token: string };
  let mentioned: { id: string; token: string };
  let foreign: { id: string; token: string };

  beforeAll(async () => {
    [projectId, foreignProjectId] = await Promise.all([createProject(), createProject()]);
    B = base(projectId);
    [author, mentioned, foreign] = await Promise.all([createUser(projectId), createUser(projectId), createUser(foreignProjectId)]);
  });
  afterAll(async () => { await Promise.all([deleteProject(projectId), deleteProject(foreignProjectId)]); });

  it("stores only the valid in-project mention and notifies only them", async () => {
    const res = await api("POST", `${B}/entities`, { token: author.token, body: {
      title: "hi", content: "hey",
      mentions: [
        { type: "user", id: mentioned.id, username: "x" },
        { type: "user", id: foreign.id, username: "y" },        // cross-project → dropped
        { type: "user", id: "00000000-0000-4000-8000-000000000000", username: "z" }, // ghost → dropped
      ],
    }});
    expect(res.status).toBe(201);
    expect(res.body.mentions).toHaveLength(1);
    expect(res.body.mentions[0]).toMatchObject({ type: "user", id: mentioned.id });

    // fan-out: mentioned got an entity-mention; foreign did not.
    const mine = await getDb().select().from(appNotifications).where(eq(appNotifications.userId, mentioned.id));
    expect(mine.some((n) => n.type === "entity-mention")).toBe(true);
    const theirs = await getDb().select().from(appNotifications).where(eq(appNotifications.userId, foreign.id));
    expect(theirs.length).toBe(0);
  });
});
