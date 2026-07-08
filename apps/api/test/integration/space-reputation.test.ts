import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/index.js";
import { loadSpaceReputations } from "../../src/lib/space-reputation.js";
import { spaces, spaceReputation } from "../../src/db/schema/index.js";
import { api, base, createProject, createUser, deleteProject } from "./helpers.js";

/** Read one user's stored self-score for a space (0 when absent). */
async function spaceRep(projectId: string, spaceId: string, userId: string): Promise<number> {
  const rows = await getDb().execute<{ reputation: number }>(sql`
    select reputation from space_reputation
    where project_id = ${projectId}::uuid and space_id = ${spaceId}::uuid and user_id = ${userId}::uuid`);
  const r = [...rows];
  return r.length ? Number(r[0]!.reputation) : 0;
}

/** Count all rows for a project (used to assert "no row written"). */
async function repRowCount(projectId: string): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(sql`
    select count(*)::int n from space_reputation where project_id = ${projectId}::uuid`);
  return Number([...rows][0]!.n);
}

describe("space_reputation table", () => {
  it("exists and upserts on the composite PK (project_id, space_id, user_id)", async () => {
    const projectId = await createProject();
    const user = await createUser(projectId);
    const { body: space } = await api("POST", `${base(projectId)}/spaces`, {
      token: user.token, body: { name: "Rep space" },
    });
    await getDb().execute(sql`insert into space_reputation (project_id, space_id, user_id, reputation)
      values (${projectId}::uuid, ${space.id}::uuid, ${user.id}::uuid, 3)`);
    await getDb().execute(sql`insert into space_reputation (project_id, space_id, user_id, reputation)
      values (${projectId}::uuid, ${space.id}::uuid, ${user.id}::uuid, 2)
      on conflict (project_id, space_id, user_id) do update set reputation = space_reputation.reputation + 2`);
    expect(await spaceRep(projectId, space.id, user.id)).toBe(5);
    await deleteProject(projectId);
  });
});

describe("space_reputation trigger maintenance", () => {
  async function setup() {
    const projectId = await createProject();
    const author = await createUser(projectId);
    const reactor = await createUser(projectId);
    return { projectId, author, reactor };
  }
  async function makeSpacedEntity(projectId: string, token: string, spaceId?: string) {
    const { body: entity } = await api("POST", `${base(projectId)}/entities`, {
      token, body: { title: "t", ...(spaceId ? { spaceId } : {}) },
    });
    return entity;
  }
  async function makeSpace(projectId: string, token: string, parentSpaceId?: string) {
    const { body: space } = await api("POST", `${base(projectId)}/spaces`, {
      token, body: { name: `S_${randomUUID().slice(0, 6)}`, ...(parentSpaceId ? { parentSpaceId } : {}) },
    });
    return space;
  }

  it("credits the author's (space, user) row when their spaced entity is reacted to", async () => {
    const { projectId, author, reactor } = await setup();
    const space = await makeSpace(projectId, author.token);
    const entity = await makeSpacedEntity(projectId, author.token, space.id);
    await api("POST", `${base(projectId)}/entities/${entity.id}/reactions`,
      { token: reactor.token, body: { reactionType: "upvote" } });
    expect(await spaceRep(projectId, space.id, author.id)).toBe(1);
    await deleteProject(projectId);
  });

  it("attributes a comment reaction to the comment's ROOT entity's space", async () => {
    const { projectId, author, reactor } = await setup();
    const space = await makeSpace(projectId, author.token);
    const entity = await makeSpacedEntity(projectId, author.token, space.id);
    const { body: comment } = await api("POST", `${base(projectId)}/comments`,
      { token: author.token, body: { entityId: entity.id, content: "c" } });
    await api("POST", `${base(projectId)}/comments/${comment.id}/reactions`,
      { token: reactor.token, body: { reactionType: "like" } });
    expect(await spaceRep(projectId, space.id, author.id)).toBe(1); // like = +1, keyed by the entity's space
    await deleteProject(projectId);
  });

  it("writes no row for a feed-level (null-space) entity", async () => {
    const { projectId, author, reactor } = await setup();
    const entity = await makeSpacedEntity(projectId, author.token); // no spaceId
    await api("POST", `${base(projectId)}/entities/${entity.id}/reactions`,
      { token: reactor.token, body: { reactionType: "upvote" } });
    expect(await repRowCount(projectId)).toBe(0);
    await deleteProject(projectId);
  });

  it("writes no row for a message-target reaction", async () => {
    const { projectId, reactor } = await setup();
    await getDb().execute(sql`insert into reactions (project_id, target_type, target_id, user_id, reaction_type)
      values (${projectId}::uuid, 'message', ${randomUUID()}::uuid, ${reactor.id}::uuid, 'like')`);
    expect(await repRowCount(projectId)).toBe(0);
    await deleteProject(projectId);
  });

  it("content_space_id returns null for a message target", async () => {
    const projectId = await createProject();
    const rows = await getDb().execute<{ sid: string | null }>(sql`
      select content_space_id('message'::reaction_target, ${randomUUID()}::uuid) as sid`);
    expect([...rows][0]!.sid).toBeNull();
    await deleteProject(projectId);
  });

  it("applies the reaction delta map (love = +2)", async () => {
    const { projectId, author, reactor } = await setup();
    const space = await makeSpace(projectId, author.token);
    const entity = await makeSpacedEntity(projectId, author.token, space.id);
    await api("POST", `${base(projectId)}/entities/${entity.id}/reactions`,
      { token: reactor.token, body: { reactionType: "love" } });
    expect(await spaceRep(projectId, space.id, author.id)).toBe(2);
    await deleteProject(projectId);
  });

  it("allows the score to go negative on a downvote", async () => {
    const { projectId, author, reactor } = await setup();
    const space = await makeSpace(projectId, author.token);
    const entity = await makeSpacedEntity(projectId, author.token, space.id);
    await api("POST", `${base(projectId)}/entities/${entity.id}/reactions`,
      { token: reactor.token, body: { reactionType: "downvote" } });
    expect(await spaceRep(projectId, space.id, author.id)).toBe(-1);
    await deleteProject(projectId);
  });

  it("applies the net delta on a reaction type change (upvote → love)", async () => {
    const { projectId, author, reactor } = await setup();
    const space = await makeSpace(projectId, author.token);
    const entity = await makeSpacedEntity(projectId, author.token, space.id);
    const url = `${base(projectId)}/entities/${entity.id}/reactions`;
    await api("POST", url, { token: reactor.token, body: { reactionType: "upvote" } }); // +1
    await api("POST", url, { token: reactor.token, body: { reactionType: "love" } });   // switch → +2 total
    expect(await spaceRep(projectId, space.id, author.id)).toBe(2);
    await deleteProject(projectId);
  });

  it("subtracts the delta when a reaction is removed", async () => {
    const { projectId, author, reactor } = await setup();
    const space = await makeSpace(projectId, author.token);
    const entity = await makeSpacedEntity(projectId, author.token, space.id);
    const url = `${base(projectId)}/entities/${entity.id}/reactions`;
    await api("POST", url, { token: reactor.token, body: { reactionType: "like" } }); // +1
    await api("POST", url, { token: reactor.token, body: { reactionType: "like" } }); // toggle off → 0
    expect(await spaceRep(projectId, space.id, author.id)).toBe(0);
    await deleteProject(projectId);
  });
});

describe("loadSpaceReputations (single space)", () => {
  it("returns the space's own score and 0 for users with no activity", async () => {
    const projectId = await createProject();
    const author = await createUser(projectId);
    const reactor = await createUser(projectId);
    const { body: space } = await api("POST", `${base(projectId)}/spaces`,
      { token: author.token, body: { name: "Solo" } });
    const { body: entity } = await api("POST", `${base(projectId)}/entities`,
      { token: author.token, body: { title: "t", spaceId: space.id } });
    await api("POST", `${base(projectId)}/entities/${entity.id}/reactions`,
      { token: reactor.token, body: { reactionType: "upvote" } });

    const m = await loadSpaceReputations(projectId, space.id, false, [author.id, reactor.id]);
    expect(m.get(author.id)).toBe(1);
    expect(m.get(reactor.id)).toBe(0); // present, zero — never undefined
    await deleteProject(projectId);
  });

  it("returns an empty map for an empty user list", async () => {
    const projectId = await createProject();
    const author = await createUser(projectId);
    const { body: space } = await api("POST", `${base(projectId)}/spaces`,
      { token: author.token, body: { name: "Empty" } });
    expect((await loadSpaceReputations(projectId, space.id, false, [])).size).toBe(0);
    await deleteProject(projectId);
  });
});

describe("loadSpaceReputations (descendant rollup)", () => {
  it("sums parent + child + grandchild, excludes siblings", async () => {
    const projectId = await createProject();
    const author = await createUser(projectId);
    const reactor = await createUser(projectId);
    const mk = async (parentSpaceId?: string) =>
      (await api("POST", `${base(projectId)}/spaces`,
        { token: author.token, body: { name: `S_${randomUUID().slice(0, 6)}`, ...(parentSpaceId ? { parentSpaceId } : {}) } })).body;

    const parent = await mk();
    const child = await mk(parent.id);
    const grandchild = await mk(child.id);
    const sibling = await mk(); // top-level, NOT under parent

    for (const s of [parent, child, grandchild, sibling]) {
      const { body: e } = await api("POST", `${base(projectId)}/entities`,
        { token: author.token, body: { title: "t", spaceId: s.id } });
      await api("POST", `${base(projectId)}/entities/${e.id}/reactions`,
        { token: reactor.token, body: { reactionType: "upvote" } }); // +1 each
    }

    const rolled = await loadSpaceReputations(projectId, parent.id, true, [author.id]);
    expect(rolled.get(author.id)).toBe(3); // parent + child + grandchild, sibling excluded

    const self = await loadSpaceReputations(projectId, parent.id, false, [author.id]);
    expect(self.get(author.id)).toBe(1); // parent only
    await deleteProject(projectId);
  });

  it("does not bleed across projects (tenant isolation)", async () => {
    const a = await createProject();
    const b = await createProject();
    const authorA = await createUser(a);
    const reactorA = await createUser(a);
    const { body: spaceA } = await api("POST", `${base(a)}/spaces`, { token: authorA.token, body: { name: "A" } });
    const { body: entA } = await api("POST", `${base(a)}/entities`, { token: authorA.token, body: { title: "t", spaceId: spaceA.id } });
    await api("POST", `${base(a)}/entities/${entA.id}/reactions`, { token: reactorA.token, body: { reactionType: "upvote" } });

    // Query project B for the same user id — must see nothing from A.
    const m = await loadSpaceReputations(b, spaceA.id, true, [authorA.id]);
    expect(m.get(authorA.id)).toBe(0);
    await deleteProject(a);
    await deleteProject(b);
  });
});

describe("space-reputation enrichment — user-direct", () => {
  const projects: string[] = [];
  afterAll(async () => { for (const p of projects) await deleteProject(p); });

  async function seedSpace(projectId: string, ownerId: string): Promise<string> {
    const [s] = await getDb().insert(spaces).values({
      projectId, shortId: `sr_${randomUUID().slice(0, 8)}`, name: "rep-space", userId: ownerId,
    }).returning();
    return s!.id;
  }
  async function setRep(projectId: string, spaceId: string, userId: string, reputation: number) {
    await getDb().insert(spaceReputation).values({ projectId, spaceId, userId, reputation });
  }

  it("uuid attaches the space-scoped number; absent omits the field", async () => {
    const pid = await createProject(); projects.push(pid);
    const owner = await createUser(pid);
    const spaceId = await seedSpace(pid, owner.id);
    await setRep(pid, spaceId, owner.id, 42);

    const plain = await api("GET", `${base(pid)}/users/${owner.id}`, { token: owner.token });
    expect(plain.status).toBe(200);
    expect(plain.body.spaceReputation).toBeUndefined();

    const enriched = await api("GET", `${base(pid)}/users/${owner.id}?spaceReputationId=${spaceId}`, { token: owner.token });
    expect(enriched.body.spaceReputation).toBe(42);
  });

  it("'none' mirrors global reputation", async () => {
    const pid = await createProject(); projects.push(pid);
    const u = await createUser(pid);
    const r = await api("GET", `${base(pid)}/users/${u.id}?spaceReputationId=none`, { token: u.token });
    expect(r.body.spaceReputation).toBe(r.body.reputation);
  });

  it("'context' → 400 on a user-direct route", async () => {
    const pid = await createProject(); projects.push(pid);
    const u = await createUser(pid);
    const r = await api("GET", `${base(pid)}/users/${u.id}?spaceReputationId=context`, { token: u.token });
    expect(r.status).toBe(400);
  });

  it("descendants=true rolls a child space's reputation into the parent", async () => {
    const pid = await createProject(); projects.push(pid);
    const owner = await createUser(pid);
    const parent = await seedSpace(pid, owner.id);
    const [child] = await getDb().insert(spaces).values({
      projectId: pid, shortId: `sr_${randomUUID().slice(0, 8)}`, name: "child", userId: owner.id, parentSpaceId: parent,
    }).returning();
    await setRep(pid, parent, owner.id, 10);
    await setRep(pid, child!.id, owner.id, 5);

    const flat = await api("GET", `${base(pid)}/users/${owner.id}?spaceReputationId=${parent}`, { token: owner.token });
    expect(flat.body.spaceReputation).toBe(10);
    const rolled = await api("GET", `${base(pid)}/users/${owner.id}?spaceReputationId=${parent}&spaceReputationDescendants=true`, { token: owner.token });
    expect(rolled.body.spaceReputation).toBe(15);
  });
});
