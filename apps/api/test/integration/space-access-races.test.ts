// Integration: space read/post access enforcement + a few genuine concurrency invariants.
// Mirrors the verified contract in spaces.test.ts (join → { membership }, requireJoinApproval,
// /members/:id/approve, owner-only soft-delete) and the space-access guards in lib/space-access.ts
// (members-only reads 403 `spaces/members-only`; admins-only posting 403 `spaces/posting-restricted`).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("Space access enforcement + boundaries (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    [owner, alice, bob] = await Promise.all([
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
  const join = (token: string, spaceId: string) =>
    api("POST", `${B}/spaces/${spaceId}/join`, { token });

  describe("Reading permission (members-only)", () => {
    it("non-member is blocked from reading an entity in a members-only space; a member is not", async () => {
      const { body: space } = await createSpace(owner.token, { readingPermission: "members" });
      const { body: entity } = await api("POST", `${B}/entities`, {
        token: owner.token,
        body: { content: "secret", spaceId: space.id },
      });

      // Non-member single read → 403 spaces/members-only
      const denied = await api("GET", `${B}/entities/${entity.id}`, { token: bob.token });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("spaces/members-only");

      // Active member reads fine
      await join(alice.token, space.id);
      const allowed = await api("GET", `${B}/entities/${entity.id}`, { token: alice.token });
      expect(allowed.status).toBe(200);
      expect(allowed.body.id).toBe(entity.id);
    });

    it("members-only space entities are excluded from a non-member's feed", async () => {
      const { body: space } = await createSpace(owner.token, { readingPermission: "members" });
      const { body: entity } = await api("POST", `${B}/entities`, {
        token: owner.token,
        body: { content: "hidden in feed", spaceId: space.id },
      });

      const feed = await api("GET", `${B}/entities?limit=100`, { token: bob.token });
      expect(feed.status).toBe(200);
      expect(feed.body.data.map((e: any) => e.id)).not.toContain(entity.id);
    });

    it("pending member cannot read a members-only space's entity until approved", async () => {
      const { body: space } = await createSpace(owner.token, {
        readingPermission: "members",
        requireJoinApproval: true,
      });
      const { body: entity } = await api("POST", `${B}/entities`, {
        token: owner.token,
        body: { content: "approval-gated", spaceId: space.id },
      });

      const joinRes = await join(bob.token, space.id);
      expect(joinRes.body.membership.status).toBe("pending");

      // Pending ≠ active member → still blocked
      const pending = await api("GET", `${B}/entities/${entity.id}`, { token: bob.token });
      expect(pending.status).toBe(403);

      // Approve → now an active member → can read
      await api("PATCH", `${B}/spaces/${space.id}/members/${bob.id}/approve`, { token: owner.token });
      const approved = await api("GET", `${B}/entities/${entity.id}`, { token: bob.token });
      expect(approved.status).toBe(200);
    });
  });

  describe("Posting permission", () => {
    it("admins-only posting: a plain member is blocked, the owner is not", async () => {
      const { body: space } = await createSpace(owner.token, { postingPermission: "admins" });
      await join(alice.token, space.id); // plain member

      const denied = await api("POST", `${B}/entities`, {
        token: alice.token,
        body: { content: "member post", spaceId: space.id },
      });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("spaces/posting-restricted");

      const ownerOk = await api("POST", `${B}/entities`, {
        token: owner.token,
        body: { content: "owner post", spaceId: space.id },
      });
      expect(ownerOk.status).toBe(201);
    });

    it("members-only posting: a non-member is blocked, an active member is not", async () => {
      const { body: space } = await createSpace(owner.token, { postingPermission: "members" });

      const nonMember = await api("POST", `${B}/entities`, {
        token: bob.token,
        body: { content: "outsider", spaceId: space.id },
      });
      expect(nonMember.status).toBe(403);

      await join(bob.token, space.id);
      const memberOk = await api("POST", `${B}/entities`, {
        token: bob.token,
        body: { content: "insider", spaceId: space.id },
      });
      expect(memberOk.status).toBe(201);
    });

    it("promoting a member to admin lets them post in an admins-only space", async () => {
      const { body: space } = await createSpace(owner.token, { postingPermission: "admins" });
      await join(alice.token, space.id);

      // Blocked as a plain member
      const before = await api("POST", `${B}/entities`, {
        token: alice.token,
        body: { content: "before", spaceId: space.id },
      });
      expect(before.status).toBe(403);

      // Promote to admin, then posting is allowed (permission is evaluated per request)
      await api("PATCH", `${B}/spaces/${space.id}/members/${alice.id}/role`, {
        token: owner.token,
        body: { role: "admin" },
      });
      const after = await api("POST", `${B}/entities`, {
        token: alice.token,
        body: { content: "after", spaceId: space.id },
      });
      expect(after.status).toBe(201);
    });
  });

  describe("Membership state transitions", () => {
    it("a left member re-joins straight back to active (open space)", async () => {
      const { body: space } = await createSpace(owner.token);
      const first = await join(alice.token, space.id);
      expect(first.body.membership.status).toBe("active");

      // Leave, then re-join — open space so no pending step
      await api("DELETE", `${B}/spaces/${space.id}/members/${alice.id}`, { token: alice.token });
      const rejoin = await join(alice.token, space.id);
      expect(rejoin.body.membership.status).toBe("active");
    });
  });

  describe("Owner-only soft delete", () => {
    it("only the owner deletes the space; afterwards its entities 404 for everyone", async () => {
      const { body: space } = await createSpace(owner.token, { readingPermission: "anyone" });
      const { body: entity } = await api("POST", `${B}/entities`, {
        token: owner.token,
        body: { content: "doomed", spaceId: space.id },
      });
      await join(alice.token, space.id);

      // A member (non-owner) cannot delete
      const memberDenied = await api("DELETE", `${B}/spaces/${space.id}`, { token: alice.token });
      expect(memberDenied.status).toBe(403);
      expect(memberDenied.body.code).toBe("spaces/not-owner");

      // Owner deletes (soft); the space then reads 404
      const ownerOk = await api("DELETE", `${B}/spaces/${space.id}`, { token: owner.token });
      expect(ownerOk.status).toBe(200);
      const gone = await api("GET", `${B}/spaces/${space.id}`, { token: owner.token });
      expect(gone.status).toBe(404);
    });
  });

  describe("Concurrency invariant", () => {
    it("two concurrent joins from the same user don't create a double-active membership", async () => {
      const { body: space } = await createSpace(owner.token);

      // Fire two joins at once; both should resolve without error and the user ends up a single
      // active member (the second is an idempotent no-op, not a duplicate row).
      const [r1, r2] = await Promise.all([join(bob.token, space.id), join(bob.token, space.id)]);
      expect([r1.status, r2.status].every((s) => s === 200 || s === 201)).toBe(true);

      const me = await api("GET", `${B}/spaces/${space.id}/membership/me`, { token: bob.token });
      expect(me.body).toMatchObject({ isMember: true, status: "active" });

      const fetched = await api("GET", `${B}/spaces/${space.id}`, { token: owner.token });
      expect(fetched.body.membersCount).toBe(2); // owner + bob, not owner + bob + bob
    });
  });
});
