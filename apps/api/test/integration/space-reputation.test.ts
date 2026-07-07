import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/db/index.js";
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
