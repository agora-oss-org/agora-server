// Integration: query/searchFields text search on the follows and connections LIST endpoints
// (Task 6, v7.8.2 sync). Filtering happens after id-level pagination — accepted tradeoff, not
// under test here (only that the *contents* of a page are correctly narrowed).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { profiles } from "../../src/db/schema/index.js";

async function rename(id: string, name: string, username: string) {
  await getDb().update(profiles).set({ name, username }).where(eq(profiles.id, id));
}

describe("follows + connections text search (integration)", () => {
  let projectId: string;
  let alice: { id: string; token: string };
  let anna: { id: string; token: string };
  let bob: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    [alice, anna, bob] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    B = base(projectId);
    await rename(anna.id, "Anna Smith", `anna_${anna.id.slice(0, 6)}`);
    await rename(bob.id, "Bob Jones", `bob_${bob.id.slice(0, 6)}`);

    // alice follows both anna and bob
    await api("POST", `${B}/users/${anna.id}/follow`, { token: alice.token });
    await api("POST", `${B}/users/${bob.id}/follow`, { token: alice.token });

    // alice connects with both anna and bob
    for (const other of [anna, bob]) {
      const req = await api("POST", `/v7/users/${other.id}/connection`, { token: alice.token });
      await api("PATCH", `/v7/connections/${req.body.id}/accept`, { token: other.token });
    }
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("follows/following: no query returns both", async () => {
    const res = await api("GET", `${B}/follows/following`, { token: alice.token });
    expect(res.status).toBe(200);
    const ids = res.body.data.map((u: any) => u.id);
    expect(ids).toContain(anna.id);
    expect(ids).toContain(bob.id);
  });

  it("follows/following: ?query=ann narrows to Anna only", async () => {
    const res = await api("GET", `${B}/follows/following?query=ann`, { token: alice.token });
    const ids = res.body.data.map((u: any) => u.id);
    expect(ids).toContain(anna.id);
    expect(ids).not.toContain(bob.id);
  });

  it("follows/following: ?searchFields=username narrows the field searched", async () => {
    const res = await api("GET", `${B}/follows/following?query=anna&searchFields=username`, { token: alice.token });
    const ids = res.body.data.map((u: any) => u.id);
    expect(ids).toContain(anna.id);
    expect(ids).not.toContain(bob.id);

    // a query that only matches the `name` field (not username) is excluded when narrowed to username
    const byName = await api("GET", `${B}/follows/following?query=Smith&searchFields=username`, { token: alice.token });
    expect(byName.body.data.map((u: any) => u.id)).not.toContain(anna.id);
  });

  it("connections: no query returns both", async () => {
    const res = await api("GET", `/v7/connections`, { token: alice.token });
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r: any) => r.connectedUser.id);
    expect(ids).toContain(anna.id);
    expect(ids).toContain(bob.id);
  });

  it("connections: ?query=ann narrows to Anna only, Bob filtered out", async () => {
    const res = await api("GET", `/v7/connections?query=ann`, { token: alice.token });
    const ids = res.body.data.map((r: any) => r.connectedUser.id);
    expect(ids).toContain(anna.id);
    expect(ids).not.toContain(bob.id);
  });
});
