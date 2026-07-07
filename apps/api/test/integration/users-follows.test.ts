// Integration: users (lookups, profile PATCH ownership) + the follow graph (edge, counts,
// follower/following lists, and the auth user's own /follows/* views).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("users + follows (integration)", () => {
  let projectId: string;
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    [alice, bob] = await Promise.all([createUser(projectId), createUser(projectId)]);
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("profile PATCH: owner updates, a non-owner is rejected", async () => {
    const ok = await api("PATCH", `${B}/users/${alice.id}`, { token: alice.token, body: { name: "Alice A", bio: "hi" } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: "Alice A", bio: "hi" });

    const denied = await api("PATCH", `${B}/users/${alice.id}`, { token: bob.token, body: { name: "hijack" } });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("users/not-self");
  });

  it("username lookup + availability", async () => {
    const { body: user } = await api("GET", `${B}/users/${alice.id}`);
    const uname = user.username as string;

    const byName = await api("GET", `${B}/users/by-username?username=${uname}`);
    expect(byName.body.id).toBe(alice.id);

    const taken = await api("GET", `${B}/users/check-username?username=${uname}`);
    expect(taken.body.available).toBe(false);

    const free = await api("GET", `${B}/users/check-username?username=defo_free_${Date.now()}`);
    expect(free.body.available).toBe(true);
  });

  it("rejects self-follow", async () => {
    const res = await api("POST", `${B}/users/${alice.id}/follow`, { token: alice.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("users/self-follow");
  });

  it("follow creates the edge; counts + lists + own /follows views reflect it", async () => {
    const follow = await api("POST", `${B}/users/${bob.id}/follow`, { token: alice.token });
    expect(follow.status).toBe(201);

    const status = await api("GET", `${B}/users/${bob.id}/follow`, { token: alice.token });
    expect(status.body.isFollowing).toBe(true);

    const followers = await api("GET", `${B}/users/${bob.id}/followers-count`);
    const following = await api("GET", `${B}/users/${alice.id}/following-count`);
    expect(followers.body.count).toBe(1);
    expect(following.body.count).toBe(1);

    const bobFollowers = await api("GET", `${B}/users/${bob.id}/followers`);
    expect(bobFollowers.body.data.map((u: any) => u.id)).toContain(alice.id);

    const aliceFollowing = await api("GET", `${B}/users/${alice.id}/following`);
    expect(aliceFollowing.body.data.map((u: any) => u.id)).toContain(bob.id);

    // the auth user's own follow graph (follows router, /v7/:projectId/follows/*)
    const myFollowing = await api("GET", `${B}/follows/following`, { token: alice.token });
    expect(myFollowing.body.data.map((u: any) => u.id)).toContain(bob.id);
    const bobsFollowers = await api("GET", `${B}/follows/followers`, { token: bob.token });
    expect(bobsFollowers.body.data.map((u: any) => u.id)).toContain(alice.id);
  });

  it("re-following is idempotent (count stays 1)", async () => {
    const again = await api("POST", `${B}/users/${bob.id}/follow`, { token: alice.token });
    expect(again.status).toBe(200); // not 201 — already following
    const count = await api("GET", `${B}/users/${bob.id}/followers-count`);
    expect(count.body.count).toBe(1);
  });

  it("unfollow removes the edge", async () => {
    const res = await api("DELETE", `${B}/users/${bob.id}/follow`, { token: alice.token });
    expect(res.status).toBe(200);

    const status = await api("GET", `${B}/users/${bob.id}/follow`, { token: alice.token });
    expect(status.body.isFollowing).toBe(false);
    const count = await api("GET", `${B}/users/${bob.id}/followers-count`);
    expect(count.body.count).toBe(0);
  });
});

describe("user suggestions — mention autocomplete (integration)", () => {
  let projectId: string; let B: string;
  let me: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    me = await createUser(projectId);
    // Give the caller a name that also matches the "smith" query below, so the
    // exclusion assertion in "matches on name too, and excludes the caller"
    // actually exercises the ne(profiles.id, exclude) filter — without it, `me`
    // would otherwise appear in those results too.
    await api("PATCH", `${B}/users/${me.id}`, { token: me.token, body: { name: "Smith Caller" } });
    // Two searchable users with known username/name.
    const jenny = await createUser(projectId);
    await api("PATCH", `${B}/users/${jenny.id}`, { token: jenny.token, body: { username: "jenny", name: "Jen Smith" } });
    const bob = await createUser(projectId);
    await api("PATCH", `${B}/users/${bob.id}`, { token: bob.token, body: { username: "bobby", name: "Bob" } });
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("returns a bare array and filters by username substring", async () => {
    const res = await api("GET", `${B}/users/suggestions?query=jen`, { token: me.token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);                 // bare array, not { data }
    expect(res.body.some((u: any) => u.username === "jenny")).toBe(true);
    expect(res.body.some((u: any) => u.username === "bobby")).toBe(false);
  });

  it("matches on name too, and excludes the caller", async () => {
    const res = await api("GET", `${B}/users/suggestions?query=smith`, { token: me.token });
    expect(res.body.some((u: any) => u.username === "jenny")).toBe(true);
    expect(res.body.some((u: any) => u.id === me.id)).toBe(false);
  });

  it("with no query returns the reputation-ranked list (bare array)", async () => {
    const res = await api("GET", `${B}/users/suggestions`, { token: me.token });
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });
});
