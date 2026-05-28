// Integration: spaces depth — reparenting cycle guard (the intricate bit), rules CRUD + reorder,
// digest-config (admin-gated + secret masking), slug routes, breadcrumb/children, and leave.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("spaces depth (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let member: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    [owner, member] = await Promise.all([createUser(projectId), createUser(projectId)]);
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  const mkSpace = (body: Record<string, unknown>) =>
    api("POST", `${B}/spaces`, { token: owner.token, body: { name: "S", ...body } });

  it("reparenting guards against cycles (self + descendant) and allows valid moves", async () => {
    const a = (await mkSpace({ name: "A" })).body;
    const b = (await mkSpace({ name: "B", parentSpaceId: a.id })).body;
    const c = (await mkSpace({ name: "C", parentSpaceId: b.id })).body;
    expect(c.depth).toBe(2);

    // A under itself → cycle
    const selfCycle = await api("PATCH", `${B}/spaces/${a.id}`, { token: owner.token, body: { parentSpaceId: a.id } });
    expect(selfCycle.status).toBe(400);
    expect(selfCycle.body.code).toBe("spaces/cycle");

    // A under its own descendant C → cycle
    const descCycle = await api("PATCH", `${B}/spaces/${a.id}`, { token: owner.token, body: { parentSpaceId: c.id } });
    expect(descCycle.status).toBe(400);
    expect(descCycle.body.code).toBe("spaces/cycle");

    // valid: move C directly under A (depth recomputed)
    const move = await api("PATCH", `${B}/spaces/${c.id}`, { token: owner.token, body: { parentSpaceId: a.id } });
    expect(move.status).toBe(200);
    expect(move.body.parentSpaceId).toBe(a.id);
    expect(move.body.depth).toBe(1);

    // detach to top level
    const detach = await api("PATCH", `${B}/spaces/${c.id}`, { token: owner.token, body: { parentSpaceId: null } });
    expect(detach.body.parentSpaceId).toBeNull();
    expect(detach.body.depth).toBe(0);
  });

  it("breadcrumb walks ancestors; children lists direct descendants", async () => {
    const a = (await mkSpace({ name: "Root" })).body;
    const b = (await mkSpace({ name: "Mid", parentSpaceId: a.id })).body;

    const crumb = await api("GET", `${B}/spaces/${b.id}/breadcrumb`);
    expect(crumb.body.data.map((s: any) => s.id)).toEqual([a.id, b.id]);

    const kids = await api("GET", `${B}/spaces/${a.id}/children`);
    expect(kids.body.data.map((s: any) => s.id)).toContain(b.id);
  });

  it("rules: create (admin), list ordered, reorder, get/patch/delete; non-admin 403", async () => {
    const space = (await mkSpace({ name: "Ruled" })).body;
    const r1 = (await api("POST", `${B}/spaces/${space.id}/rules`, { token: owner.token, body: { title: "First", order: 0 } })).body;
    const r2 = (await api("POST", `${B}/spaces/${space.id}/rules`, { token: owner.token, body: { title: "Second", order: 1 } })).body;

    // non-admin cannot add a rule
    const denied = await api("POST", `${B}/spaces/${space.id}/rules`, { token: member.token, body: { title: "Nope" } });
    expect(denied.status).toBe(403);

    // reorder swaps them (order = index in the array)
    const reordered = await api("PATCH", `${B}/spaces/${space.id}/rules/reorder`, { token: owner.token, body: { order: [r2.id, r1.id] } });
    expect(reordered.body.data.map((r: any) => r.id)).toEqual([r2.id, r1.id]);

    const one = await api("GET", `${B}/spaces/${space.id}/rules/${r1.id}`);
    expect(one.body.title).toBe("First");

    const patched = await api("PATCH", `${B}/spaces/${space.id}/rules/${r1.id}`, { token: owner.token, body: { title: "First (edited)" } });
    expect(patched.body.title).toBe("First (edited)");

    const del = await api("DELETE", `${B}/spaces/${space.id}/rules/${r2.id}`, { token: owner.token });
    expect(del.status).toBe(200);
    const after = await api("GET", `${B}/spaces/${space.id}/rules`);
    expect(after.body.data.map((r: any) => r.id)).toEqual([r1.id]);
  });

  it("digest-config is admin-gated and masks the secret", async () => {
    const space = (await mkSpace({ name: "Digest" })).body;

    const memberDenied = await api("GET", `${B}/spaces/${space.id}/digest-config`, { token: member.token });
    expect(memberDenied.status).toBe(403);

    const set = await api("PATCH", `${B}/spaces/${space.id}/digest-config`, {
      token: owner.token,
      body: { digestEnabled: true, digestWebhookSecret: "supersecretvalue", digestScheduleHour: 9 },
    });
    expect(set.status).toBe(200);
    expect(set.body.digestEnabled).toBe(true);
    expect(set.body.digestWebhookSecret).toBe("••••••••"); // never echoed back

    const got = await api("GET", `${B}/spaces/${space.id}/digest-config`, { token: owner.token });
    expect(got.body.digestWebhookSecret).toBe("••••••••");
    expect(got.body.digestScheduleHour).toBe(9);
  });

  it("slug lookup + availability", async () => {
    const slug = `s-${Date.now()}`;
    const space = (await mkSpace({ name: "Slugged", slug })).body;

    const bySlug = await api("GET", `${B}/spaces/by-slug?slug=${slug}`);
    expect(bySlug.body.id).toBe(space.id);

    expect((await api("GET", `${B}/spaces/check-slug?slug=${slug}`)).body.available).toBe(false);
    expect((await api("GET", `${B}/spaces/check-slug?slug=free-${Date.now()}`)).body.available).toBe(true);
  });

  it("leave removes membership", async () => {
    const space = (await mkSpace({ name: "Leavable" })).body;
    await api("POST", `${B}/spaces/${space.id}/join`, { token: member.token });
    expect((await api("GET", `${B}/spaces/${space.id}/membership/me`, { token: member.token })).body.isMember).toBe(true);

    const leave = await api("DELETE", `${B}/spaces/${space.id}/leave`, { token: member.token });
    expect(leave.status).toBe(200);
    expect((await api("GET", `${B}/spaces/${space.id}/membership/me`, { token: member.token })).body.isMember).toBe(false);
  });
});
