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
