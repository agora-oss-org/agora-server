// Integration: spaces role-based permissions + membership state machine + members_count trigger.
// This is the most security-sensitive logic in the app (requireSpaceRole gates writes), so the
// matrix below asserts both the allow and the deny paths against real Postgres.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("spaces permissions + membership (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let carl: { id: string; token: string };
  let B: string; // base path

  beforeAll(async () => {
    projectId = await createProject();
    [owner, alice, bob, carl] = await Promise.all([
      createUser(projectId),
      createUser(projectId),
      createUser(projectId),
      createUser(projectId),
    ]);
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  const createSpace = (token: string, body: Record<string, unknown> = {}) =>
    api("POST", `${B}/spaces`, { token, body: { name: "Space", ...body } });

  it("creator becomes admin and the sole member (members_count trigger)", async () => {
    const res = await createSpace(owner.token);
    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(owner.id);

    // membersCount reflects the trigger only on a fresh read — the create response is the
    // space row snapshotted before the creator's membership row is inserted.
    const fetched = await api("GET", `${B}/spaces/${res.body.id}`);
    expect(fetched.body.membersCount).toBe(1); // creator auto-joined as admin via trigger

    const me = await api("GET", `${B}/spaces/${res.body.id}/membership/me`, { token: owner.token });
    expect(me.body).toMatchObject({ isMember: true, role: "admin", status: "active" });
  });

  it("open space: joining makes you active and bumps members_count", async () => {
    const { body: space } = await createSpace(owner.token);
    const join = await api("POST", `${B}/spaces/${space.id}/join`, { token: alice.token });
    expect(join.body.membership.status).toBe("active");

    const fetched = await api("GET", `${B}/spaces/${space.id}`);
    expect(fetched.body.membersCount).toBe(2);
  });

  it("approval-required space: join stays pending until an admin approves", async () => {
    const { body: space } = await createSpace(owner.token, { requireJoinApproval: true });

    const join = await api("POST", `${B}/spaces/${space.id}/join`, { token: bob.token });
    expect(join.body.membership.status).toBe("pending");

    const pendingMe = await api("GET", `${B}/spaces/${space.id}/membership/me`, { token: bob.token });
    expect(pendingMe.body).toMatchObject({ isMember: false, status: "pending" });

    const approve = await api("PATCH", `${B}/spaces/${space.id}/members/${bob.id}/approve`, { token: owner.token });
    expect(approve.body.membership.status).toBe("active");

    const activeMe = await api("GET", `${B}/spaces/${space.id}/membership/me`, { token: bob.token });
    expect(activeMe.body).toMatchObject({ isMember: true, status: "active" });
  });

  it("requireSpaceRole gates edits to admins (member 403, owner 200)", async () => {
    const { body: space } = await createSpace(owner.token);
    await api("POST", `${B}/spaces/${space.id}/join`, { token: alice.token }); // alice = plain member

    const denied = await api("PATCH", `${B}/spaces/${space.id}`, { token: alice.token, body: { name: "Hijacked" } });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("spaces/insufficient-role");

    const allowed = await api("PATCH", `${B}/spaces/${space.id}`, { token: owner.token, body: { name: "Renamed" } });
    expect(allowed.status).toBe(200);
    expect(allowed.body.name).toBe("Renamed");
  });

  it("admin promotes a member to moderator; moderator can remove members, a plain member cannot", async () => {
    const { body: space } = await createSpace(owner.token);
    await api("POST", `${B}/spaces/${space.id}/join`, { token: alice.token });
    await api("POST", `${B}/spaces/${space.id}/join`, { token: bob.token });
    await api("POST", `${B}/spaces/${space.id}/join`, { token: carl.token });

    const promote = await api("PATCH", `${B}/spaces/${space.id}/members/${alice.id}/role`, {
      token: owner.token,
      body: { role: "moderator" },
    });
    expect(promote.status).toBe(200);
    expect(promote.body.membership.role).toBe("moderator");

    // moderator (alice) may remove a member
    const removed = await api("DELETE", `${B}/spaces/${space.id}/members/${bob.id}`, { token: alice.token });
    expect(removed.status).toBe(200);

    // a plain member (carl) may not
    const carlDenied = await api("DELETE", `${B}/spaces/${space.id}/members/${alice.id}`, { token: carl.token });
    expect(carlDenied.status).toBe(403);
    expect(carlDenied.body.code).toBe("spaces/insufficient-role");
  });

  it("moderation is gated to admin/moderator", async () => {
    const { body: space } = await createSpace(owner.token);
    await api("POST", `${B}/spaces/${space.id}/join`, { token: alice.token }); // plain member
    const { body: entity } = await api("POST", `${B}/entities`, {
      token: owner.token,
      body: { title: "in space", spaceId: space.id },
    });

    const memberDenied = await api("PATCH", `${B}/spaces/${space.id}/entities/${entity.id}/moderation`, {
      token: alice.token,
      body: { status: "removed", reason: "spam" },
    });
    expect(memberDenied.status).toBe(403);

    const ownerOk = await api("PATCH", `${B}/spaces/${space.id}/entities/${entity.id}/moderation`, {
      token: owner.token,
      body: { status: "removed", reason: "spam" },
    });
    expect(ownerOk.status).toBe(200);
  });

  it("only the owner can delete a space — not even another admin", async () => {
    const { body: space } = await createSpace(owner.token);
    await api("POST", `${B}/spaces/${space.id}/join`, { token: alice.token });
    await api("PATCH", `${B}/spaces/${space.id}/members/${alice.id}/role`, { token: owner.token, body: { role: "admin" } });

    const adminDenied = await api("DELETE", `${B}/spaces/${space.id}`, { token: alice.token });
    expect(adminDenied.status).toBe(403);
    expect(adminDenied.body.code).toBe("spaces/not-owner");

    const ownerOk = await api("DELETE", `${B}/spaces/${space.id}`, { token: owner.token });
    expect(ownerOk.status).toBe(200);
  });
});

describe("spaces list — search/sort/memberOf (#-mention autocomplete) (integration)", () => {
  let projectId: string; let B: string; let owner: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    owner = await createUser(projectId);
    await api("POST", `${B}/spaces`, { token: owner.token, body: { name: "Developers", slug: "dev-talk", description: "coding" } });
    await api("POST", `${B}/spaces`, { token: owner.token, body: { name: "Gardening", slug: "garden", description: "plants" } });
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("filters by searchAny across name/slug/description", async () => {
    const res = await api("GET", `${B}/spaces?searchAny=dev`, { token: owner.token });
    expect(res.status).toBe(200);
    expect(res.body.data.some((s: any) => s.slug === "dev-talk")).toBe(true);
    expect(res.body.data.some((s: any) => s.slug === "garden")).toBe(false);
  });

  it("filters by searchDescription", async () => {
    const res = await api("GET", `${B}/spaces?searchDescription=plants`, { token: owner.token });
    expect(res.body.data.every((s: any) => s.slug === "garden")).toBe(true);
  });

  it("sorts alphabetically by name", async () => {
    const res = await api("GET", `${B}/spaces?sortBy=alphabetical`, { token: owner.token });
    const names = res.body.data.map((s: any) => s.name);
    expect(names.indexOf("Developers")).toBeLessThan(names.indexOf("Gardening"));
  });

  it("rejects an unknown sortBy with 400", async () => {
    const res = await api("GET", `${B}/spaces?sortBy=bogus`, { token: owner.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("spaces/invalid-filter");
  });

  it("memberOf=true returns only spaces the caller actively belongs to", async () => {
    const outsider = await createUser(projectId);
    const res = await api("GET", `${B}/spaces?memberOf=true`, { token: outsider.token });
    expect(res.body.data.length).toBe(0); // outsider is a member of none
  });

  it("include=files attaches an empty files array (base shape) without erroring", async () => {
    const res = await api("GET", `${base(projectId)}/spaces?include=files`, { token: owner.token });
    expect(res.status).toBe(200);
    expect(res.body.data.every((s: any) => Array.isArray(s.files))).toBe(true);
  });
});
