// Integration: the entities + comments + reactions vertical against a real Postgres.
// Proves the parts unit tests can't reach — the triggers (reaction_counts, replies_count)
// and the toggle_reaction RPC — plus project-scoping and ownership enforcement.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("entities + comments + reactions (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let other: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    owner = await createUser(projectId);
    other = await createUser(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("creates an entity and reads it back shaped", async () => {
    const created = await api("POST", `${base(projectId)}/entities`, {
      token: owner.token,
      body: { title: "Hello", content: "world", keywords: ["greeting"] },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: "Hello",
      content: "world",
      userId: owner.id,
      projectId,
      repliesCount: 0,
      userReaction: null,
    });
    expect(created.body.shortId).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(typeof created.body.createdAt).toBe("string"); // ISO, not a Date

    const got = await api("GET", `${base(projectId)}/entities/${created.body.id}`, { token: owner.token });
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(created.body.id);
  });

  it("requires auth to create", async () => {
    const res = await api("POST", `${base(projectId)}/entities`, { body: { title: "no auth" } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth/unauthorized");
  });

  it("toggle_reaction RPC + trigger maintain reaction_counts", async () => {
    const { body: entity } = await api("POST", `${base(projectId)}/entities`, {
      token: owner.token,
      body: { title: "votable" },
    });

    // upvote -> count 1
    const up = await api("POST", `${base(projectId)}/entities/${entity.id}/reactions`, {
      token: other.token,
      body: { reactionType: "upvote" },
    });
    expect(up.status).toBe(200);
    expect(up.body.reactionCounts.upvote).toBe(1);
    expect(up.body.userReaction).toBe("upvote");

    // same type again -> toggles off -> count 0
    const off = await api("POST", `${base(projectId)}/entities/${entity.id}/reactions`, {
      token: other.token,
      body: { reactionType: "upvote" },
    });
    expect(off.body.reactionCounts.upvote).toBe(0);
    expect(off.body.userReaction).toBeNull();

    // the count is persisted (visible on a fresh GET as the authed reactor)
    const refetch = await api("POST", `${base(projectId)}/entities/${entity.id}/reactions`, {
      token: other.token,
      body: { reactionType: "love" },
    });
    expect(refetch.body.reactionCounts.love).toBe(1);
    expect(refetch.body.reactionCounts.upvote).toBe(0);
  });

  it("comment insert bumps entity.replies_count via trigger", async () => {
    const { body: entity } = await api("POST", `${base(projectId)}/entities`, {
      token: owner.token,
      body: { title: "discussed" },
    });

    const comment = await api("POST", `${base(projectId)}/comments`, {
      token: other.token,
      body: { entityId: entity.id, content: "first!" },
    });
    expect(comment.status).toBe(201);
    expect(comment.body).toMatchObject({ entityId: entity.id, content: "first!", userId: other.id });

    const refetched = await api("GET", `${base(projectId)}/entities/${entity.id}`, { token: owner.token });
    expect(refetched.body.repliesCount).toBe(1);

    // it shows up in the one-level thread listing
    const list = await api("GET", `${base(projectId)}/comments?entityId=${entity.id}`, { token: owner.token });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.pagination).toMatchObject({ totalItems: 1, hasMore: false });
  });

  it("enforces ownership on update (non-owner -> 403)", async () => {
    const { body: entity } = await api("POST", `${base(projectId)}/entities`, {
      token: owner.token,
      body: { title: "mine" },
    });
    const res = await api("PATCH", `${base(projectId)}/entities/${entity.id}`, {
      token: other.token,
      body: { title: "hijacked" },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("entities/not-owner");
  });

  it("soft-deletes an entity (owner) and then 404s", async () => {
    const { body: entity } = await api("POST", `${base(projectId)}/entities`, {
      token: owner.token,
      body: { title: "ephemeral" },
    });
    const del = await api("DELETE", `${base(projectId)}/entities/${entity.id}`, { token: owner.token });
    expect(del.status).toBe(200);
    const gone = await api("GET", `${base(projectId)}/entities/${entity.id}`, { token: owner.token });
    expect(gone.status).toBe(404);
  });

  it("rejects an unknown project", async () => {
    const res = await api("GET", `/v7/00000000-0000-0000-0000-000000000000/entities`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("project/not-found");
  });

  // by-foreign-id + createIfNotFound (SDK EntityProvider / CommentSection lazy-anchor path).
  describe("by-foreign-id createIfNotFound", () => {
    it("404s for a missing foreignId without the flag", async () => {
      const res = await api("GET", `${base(projectId)}/entities/by-foreign-id?foreignId=missing-no-flag`, { token: owner.token });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("entities/not-found");
    });

    // Was "even unauthenticated" pre-wall (this read auto-vivifies an AUTHORLESS anchor for the
    // SDK's CommentSection on an anonymous page view). The auth wall now blocks it pre-handler —
    // inverted per the sweep rules: anonymous asserts 401, authed keeps the original behavior.
    // Flagged in the task report: whether anonymous lazy-anchor creation should stay reachable
    // (e.g. via the allowlist) is a product decision, not something this sweep should force.
    it("anonymous → 401 (was: lazily creates an AUTHORLESS anchor, even unauthenticated)", async () => {
      const res = await api("GET", `${base(projectId)}/entities/by-foreign-id?foreignId=homepage&createIfNotFound=true`);
      expect(res.status).toBe(401);
    });

    it("authed: lazily creates an AUTHORLESS anchor on first view", async () => {
      const res = await api("GET", `${base(projectId)}/entities/by-foreign-id?foreignId=homepage&createIfNotFound=true`, { token: owner.token });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ foreignId: "homepage", projectId, userId: null });
      expect(res.body.shortId).toMatch(/^[A-Za-z0-9_-]{10}$/);
      expect(res.body.id).toBeTruthy();
    });

    it("is idempotent — a second create-on-read returns the SAME entity", async () => {
      const first = await api("GET", `${base(projectId)}/entities/by-foreign-id?foreignId=idem&createIfNotFound=true`, { token: owner.token });
      const second = await api("GET", `${base(projectId)}/entities/by-foreign-id?foreignId=idem&createIfNotFound=true`, { token: owner.token });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id); // no duplicate row — unique (project_id, foreign_id)
    });

    it("is race-safe under concurrent first-views (one row wins, all callers agree)", async () => {
      const hits = await Promise.all(
        Array.from({ length: 6 }, () =>
          api("GET", `${base(projectId)}/entities/by-foreign-id?foreignId=race&createIfNotFound=true`, { token: owner.token })
        )
      );
      expect(hits.every((h) => h.status === 200)).toBe(true);
      const ids = new Set(hits.map((h) => h.body.id));
      expect(ids.size).toBe(1); // exactly one entity materialized despite the stampede
    });

    it("does not leak createIfNotFound across projects (scoped by project_id)", async () => {
      await api("GET", `${base(projectId)}/entities/by-foreign-id?foreignId=scoped&createIfNotFound=true`, { token: owner.token });
      const otherProject = await createProject();
      try {
        // A project-A token used against project B's base path is now rejected at the auth wall
        // itself (401) — the wall binds a token to the project it was minted for (createUser stamps
        // `pid`), so this no longer reaches the handler's own project-scoping at all. See
        // auth-wall.test.ts "auth wall — project binding" for the dedicated wall-level assertion.
        const crossProjectToken = await api("GET", `${base(otherProject)}/entities/by-foreign-id?foreignId=scoped`, { token: owner.token });
        expect(crossProjectToken.status).toBe(401);

        // The subject this test actually proves — by-foreign-id lookups are scoped by project_id,
        // not just gated by auth — needs a token that's valid FOR project B: same foreignId, no
        // cross-tenant bleed, still 404 without the create flag.
        const otherProjectUser = await createUser(otherProject);
        const res = await api("GET", `${base(otherProject)}/entities/by-foreign-id?foreignId=scoped`, { token: otherProjectUser.token });
        expect(res.status).toBe(404);
      } finally {
        await deleteProject(otherProject);
      }
    });
  });
});
