import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { spaces, spaceMembers, entities } from "../../src/db/schema/index.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("Space Access: Race Conditions & Boundaries", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let user1: { id: string; token: string };
  let user2: { id: string; token: string };
  let user3: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    owner = await createUser(projectId);
    user1 = await createUser(projectId);
    user2 = await createUser(projectId);
    user3 = await createUser(projectId);
  });

  afterAll(async () => {
    await deleteProject(projectId);
  });

  describe("Concurrent Join + Delete", () => {
    it("user joins space while owner deletes → no orphaned member", async () => {
      // Create a space
      const spaceRes = await api("POST", `${base(projectId)}/spaces`, {
        token: owner.token,
        body: { name: "Space to delete" },
      });
      const spaceId = spaceRes.body.id;

      // User joins and space deletes concurrently
      const joinPromise = api("POST", `${base(projectId)}/spaces/${spaceId}/join`, {
        token: user1.token,
        body: {},
      });

      const deletePromise = api("DELETE", `${base(projectId)}/spaces/${spaceId}`, {
        token: owner.token,
      });

      const [joinRes, deleteRes] = await Promise.all([joinPromise, deletePromise]);

      // One should succeed, one should fail gracefully
      // Either join fails (space already deleted) or delete fails (join in progress)
      expect([joinRes.status, deleteRes.status]).toContain(200);

      // Verify no orphaned member rows
      const members = await db.select().from(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));
      if (deleteRes.status === 200) {
        // Space is deleted, members should be cascade-deleted
        expect(members.length).toBe(0);
      }
    });

    it("join + space becomes private simultaneously", async () => {
      const spaceRes = await api("POST", `${base(projectId)}/spaces`, {
        token: owner.token,
        body: { name: "Space", readingPermission: "anyone" },
      });
      const spaceId = spaceRes.body.id;

      // User joins while owner makes space private
      const joinPromise = api("POST", `${base(projectId)}/spaces/${spaceId}/join`, {
        token: user1.token,
        body: {},
      });

      const privatePromise = api("PATCH", `${base(projectId)}/spaces/${spaceId}`, {
        token: owner.token,
        body: { readingPermission: "members" },
      });

      const [joinRes, privateRes] = await Promise.all([joinPromise, privatePromise]);

      // Both should succeed (order-independent)
      expect(joinRes.status).toBe(200);
      expect(privateRes.status).toBe(200);

      // User who joined should have access to private space (member)
      const readRes = await api("GET", `${base(projectId)}/spaces/${spaceId}`, {
        token: user1.token,
      });
      expect(readRes.status).toBe(200);
    });
  });

  describe("Role Transitions Under Load", () => {
    it("member promoted while posting (permission checked at POST time, not modified mid-op)", async () => {
      const spaceRes = await api("POST", `${base(projectId)}/spaces`, {
        token: owner.token,
        body: { name: "Space", postingPermission: "admins" },
      });
      const spaceId = spaceRes.body.id;

      // User1 joins as member
      await api("POST", `${base(projectId)}/spaces/${spaceId}/join`, {
        token: user1.token,
        body: {},
      });

      // User1 tries to post (should fail: postingPermission=admins)
      const postBeforeRes = await api("POST", `${base(projectId)}/entities`, {
        token: user1.token,
        body: { body: "Test", spaceId },
      });
      expect(postBeforeRes.status).toBe(403);
      expect(postBeforeRes.body.code).toBe("spaces/posting-restricted");

      // Owner promotes user1 to admin concurrently with post attempt
      const promotePromise = api("PATCH", `${base(projectId)}/spaces/${spaceId}/members/${user1.id}`, {
        token: owner.token,
        body: { role: "admin" },
      });

      const postAfterPromise = api("POST", `${base(projectId)}/entities`, {
        token: user1.token,
        body: { body: "Test", spaceId },
      });

      const [promoteRes, postAfterRes] = await Promise.all([promotePromise, postAfterPromise]);

      // Promotion should succeed
      expect(promoteRes.status).toBe(200);

      // Post may succeed or fail depending on timing
      // If posted after promotion: 200
      // If posted before role check saw promotion: 403
      // Both are acceptable outcomes (permission checked at request time)
    });

    it("member promoted while commenting (same timing constraints)", async () => {
      // Create space with admins-only posting
      const spaceRes = await api("POST", `${base(projectId)}/spaces`, {
        token: owner.token,
        body: { name: "Space", postingPermission: "admins" },
      });
      const spaceId = spaceRes.body.id;

      // Create an entity
      const entityRes = await api("POST", `${base(projectId)}/entities`, {
        token: owner.token,
        body: { body: "Entity", spaceId },
      });
      const entityId = entityRes.body.id;

      // User1 joins as member (and tries to comment)
      await api("POST", `${base(projectId)}/spaces/${spaceId}/join`, {
        token: user1.token,
        body: {},
      });

      // Comment before promotion (should fail)
      const commentBeforeRes = await api("POST", `${base(projectId)}/entities/${entityId}/comments`, {
        token: user1.token,
        body: { body: "Comment" },
      });
      expect(commentBeforeRes.status).toBe(403);

      // Promote to admin concurrently with comment attempt
      const promotePromise = api("PATCH", `${base(projectId)}/spaces/${spaceId}/members/${user1.id}`, {
        token: owner.token,
        body: { role: "admin" },
      });

      const commentAfterPromise = api("POST", `${base(projectId)}/entities/${entityId}/comments`, {
        token: user1.token,
        body: { body: "Comment after" },
      });

      const [promoteRes, commentAfterRes] = await Promise.all([promotePromise, commentAfterPromise]);

      expect(promoteRes.status).toBe(200);
      // Comment may succeed or fail based on timing
    });

    it("moderator demoted → subsequent space edit rejected with 403", async () => {
      const spaceRes = await api("POST", `${base(projectId)}/spaces`, {
        token: owner.token,
        body: { name: "Space" },
      });
      const spaceId = spaceRes.body.id;

      // User1 joins as moderator
      await api("POST", `${base(projectId)}/spaces/${spaceId}/members`, {
        token: owner.token,
        body: { userId: user1.id, role: "moderator" },
      });

      // User1 can edit (has mod permission)
      const editBeforeRes = await api("PATCH", `${base(projectId)}/spaces/${spaceId}`, {
        token: user1.token,
        body: { name: "Updated by mod" },
      });
      expect(editBeforeRes.status).toBe(200);

      // Demote to member
      await api("PATCH", `${base(projectId)}/spaces/${spaceId}/members/${user1.id}`, {
        token: owner.token,
        body: { role: "member" },
      });

      // Now edit should fail
      const editAfterRes = await api("PATCH", `${base(projectId)}/spaces/${spaceId}`, {
        token: user1.token,
        body: { name: "Rejected" },
      });
      expect(editAfterRes.status).toBe(403);
      expect(editAfterRes.body.code).toMatch(/insufficient-role|forbidden/);
    });
  });

  describe("Feed Pagination + Space Changes", () => {
    it("feed cursor remains valid after space becomes private (pagination boundary shift)", async () => {
      // Create a public space with entity
      const spaceRes = await api("POST", `${base(projectId)}/spaces`, {
        token: owner.token,
        body: { name: "Space", readingPermission: "anyone" },
      });
      const spaceId = spaceRes.body.id;

      const entity1Res = await api("POST", `${base(projectId)}/entities`, {
        token: owner.token,
        body: { body: "Entity 1", spaceId },
      });

      const entity2Res = await api("POST", `${base(projectId)}/entities`, {
        token: owner.token,
        body: { body: "Entity 2", spaceId },
      });

      // Non-member reads feed, gets cursor
      const page1Res = await api("GET", `${base(projectId)}/entities?limit=1`, {
        token: user1.token,
      });
      expect(page1Res.status).toBe(200);
      const cursor = page1Res.body.pagination?.next;

      // Space becomes private
      await api("PATCH", `${base(projectId)}/spaces/${spaceId}`, {
        token: owner.token,
        body: { readingPermission: "members" },
      });

      // User1 uses cursor for next page
      const page2Res = await api("GET", `${base(projectId)}/entities?limit=1&after=${cursor}`, {
        token: user1.token,
      });
      // Cursor should still be valid (keyset-based pagination)
      // But entities from private space are filtered out
      expect(page2Res.status).toBe(200);
    });
  });

  describe("Membership State Transitions", () => {
    it("user joins pending → admin approves → becomes active (permission gated)", async () => {
      const spaceRes = await api("POST", `${base(projectId)}/spaces`, {
        token: owner.token,
        body: { name: "Space", readingPermission: "members", approveJoins: true },
      });
      const spaceId = spaceRes.body.id;

      // User1 requests to join
      const joinRes = await api("POST", `${base(projectId)}/spaces/${spaceId}/join`, {
        token: user1.token,
        body: {},
      });
      expect(joinRes.status).toBe(200);

      // User1 cannot read members-only space while pending
      const readBeforeRes = await api("GET", `${base(projectId)}/spaces/${spaceId}`, {
        token: user1.token,
      });
      expect(readBeforeRes.status).toBe(403);

      // Owner approves
      const approveRes = await api("PATCH", `${base(projectId)}/spaces/${spaceId}/members/${user1.id}`, {
        token: owner.token,
        body: { status: "active" },
      });
      expect(approveRes.status).toBe(200);

      // User1 can now read
      const readAfterRes = await api("GET", `${base(projectId)}/spaces/${spaceId}`, {
        token: user1.token,
      });
      expect(readAfterRes.status).toBe(200);
    });

    it("join rejected (banned) → user cannot re-join without intervention", async () => {
      const spaceRes = await api("POST", `${base(projectId)}/spaces`, {
        token: owner.token,
        body: { name: "Space" },
      });
      const spaceId = spaceRes.body.id;

      // User1 joins then is banned
      await api("POST", `${base(projectId)}/spaces/${spaceId}/join`, {
        token: user1.token,
        body: {},
      });

      await api("DELETE", `${base(projectId)}/spaces/${spaceId}/members/${user1.id}`, {
        token: owner.token,
        body: { status: "banned" },
      });

      // User1 tries to rejoin
      const rejoinRes = await api("POST", `${base(projectId)}/spaces/${spaceId}/join`, {
        token: user1.token,
        body: {},
      });
      // Should be rejected (banned status prevents rejoin)
      expect(rejoinRes.status).toBe(403);
      expect(rejoinRes.body.code).toMatch(/banned|forbidden/);
    });

    it("left member re-joins → fresh member status (not pending)", async () => {
      const spaceRes = await api("POST", `${base(projectId)}/spaces`, {
        token: owner.token,
        body: { name: "Space" },
      });
      const spaceId = spaceRes.body.id;

      // User1 joins
      await api("POST", `${base(projectId)}/spaces/${spaceId}/join`, {
        token: user1.token,
        body: {},
      });

      // User1 leaves
      await api("DELETE", `${base(projectId)}/spaces/${spaceId}/members/leave`, {
        token: user1.token,
        body: {},
      });

      // User1 re-joins
      const rejoinRes = await api("POST", `${base(projectId)}/spaces/${spaceId}/join`, {
        token: user1.token,
        body: {},
      });
      expect(rejoinRes.status).toBe(200);
      expect(rejoinRes.body.status).toBe("active"); // fresh status, not pending
    });
  });

  describe("Owner Removal & Cascade", () => {
    it("delete space → all members cascade-deleted", async () => {
      const spaceRes = await api("POST", `${base(projectId)}/spaces`, {
        token: owner.token,
        body: { name: "Space" },
      });
      const spaceId = spaceRes.body.id;

      // Multiple users join
      await api("POST", `${base(projectId)}/spaces/${spaceId}/join`, {
        token: user1.token,
        body: {},
      });
      await api("POST", `${base(projectId)}/spaces/${spaceId}/join`, {
        token: user2.token,
        body: {},
      });

      // Verify members exist
      let members = await db.select().from(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));
      expect(members.length).toBeGreaterThan(0);

      // Delete space
      const deleteRes = await api("DELETE", `${base(projectId)}/spaces/${spaceId}`, {
        token: owner.token,
      });
      expect(deleteRes.status).toBe(200);

      // Verify all members deleted
      members = await db.select().from(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));
      expect(members.length).toBe(0);
    });
  });

  describe("Permission Enforcement at Boundaries", () => {
    it("user reads space (readable), then becomes non-member (race)", async () => {
      const spaceRes = await api("POST", `${base(projectId)}/spaces`, {
        token: owner.token,
        body: { name: "Space", readingPermission: "members" },
      });
      const spaceId = spaceRes.body.id;

      // User1 joins
      await api("POST", `${base(projectId)}/spaces/${spaceId}/join`, {
        token: user1.token,
        body: {},
      });

      // User1 reads (should work)
      const readRes = await api("GET", `${base(projectId)}/spaces/${spaceId}`, {
        token: user1.token,
      });
      expect(readRes.status).toBe(200);

      // Owner removes user1 concurrently with another read
      const removePromise = api("DELETE", `${base(projectId)}/spaces/${spaceId}/members/${user1.id}`, {
        token: owner.token,
      });

      const read2Promise = api("GET", `${base(projectId)}/spaces/${spaceId}`, {
        token: user1.token,
      });

      const [removeRes, read2Res] = await Promise.all([removePromise, read2Promise]);

      // Removal should succeed
      expect(removeRes.status).toBe(200);

      // Second read: may succeed (if checked before removal) or fail with 403
      // Both are acceptable (race condition)
    });

    it("user loads conversation, space posting changes from anyone → admins (race)", async () => {
      const spaceRes = await api("POST", `${base(projectId)}/spaces`, {
        token: owner.token,
        body: { name: "Space", postingPermission: "anyone" },
      });
      const spaceId = spaceRes.body.id;

      // User1 joins
      await api("POST", `${base(projectId)}/spaces/${spaceId}/join`, {
        token: user1.token,
        body: {},
      });

      // User1 creates entity (should work)
      const entity1Res = await api("POST", `${base(projectId)}/entities`, {
        token: user1.token,
        body: { body: "Entity 1", spaceId },
      });
      expect(entity1Res.status).toBe(201);

      // Owner restricts posting concurrently with user1's second post
      const restrictPromise = api("PATCH", `${base(projectId)}/spaces/${spaceId}`, {
        token: owner.token,
        body: { postingPermission: "admins" },
      });

      const entity2Promise = api("POST", `${base(projectId)}/entities`, {
        token: user1.token,
        body: { body: "Entity 2", spaceId },
      });

      const [restrictRes, entity2Res] = await Promise.all([restrictPromise, entity2Promise]);

      expect(restrictRes.status).toBe(200);
      // Entity2: may succeed (if posted before restriction) or fail with 403
    });
  });
});
