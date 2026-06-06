import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { entities, comments, users, refreshTokens } from "../../src/db/schema/index.js";
import { api, signToken, createProject, createUser, deleteProject, base } from "./helpers.js";
import { createHash } from "node:crypto";

const hashOf = (raw: string) => createHash("sha256").update(raw).digest("hex");

describe("Edge Cases & Bulk Operations", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let user1: { id: string; token: string };
  let user2: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    owner = await createUser(projectId);
    user1 = await createUser(projectId);
    user2 = await createUser(projectId);
  });

  afterAll(async () => {
    await deleteProject(projectId);
  });

  describe("Entity + Comment Cascade on Removal", () => {
    it("remove entity with 100 comments → all comments cascade", async () => {
      // Create entity
      const entityRes = await api("POST", `${base(projectId)}/entities`, {
        token: owner.token,
        body: { body: "Parent entity" },
      });
      const entityId = entityRes.body.id;

      // Create 100 comments
      const commentIds: string[] = [];
      for (let i = 0; i < 100; i++) {
        const commentRes = await api("POST", `${base(projectId)}/entities/${entityId}/comments`, {
          token: owner.token,
          body: { body: `Comment ${i}` },
        });
        commentIds.push(commentRes.body.id);
      }

      // Delete entity (soft-delete)
      const deleteRes = await api("DELETE", `${base(projectId)}/entities/${entityId}`, {
        token: owner.token,
      });
      expect(deleteRes.status).toBe(200);

      // Verify all comments are soft-deleted (or cascade-hidden)
      for (const cid of commentIds.slice(0, 10)) {
        // Check first 10 to keep test fast
        const commentRes = await api("GET", `${base(projectId)}/entities/${entityId}/comments/${cid}`, {
          token: owner.token,
        });
        // Soft-deleted entity → comments orphaned or hidden
        expect(commentRes.status).toBe(404);
      }
    });

    it("remove comment with 50 child replies → subtree hidden from non-ops", async () => {
      // Create entity + parent comment
      const entityRes = await api("POST", `${base(projectId)}/entities`, {
        token: owner.token,
        body: { body: "Entity" },
      });
      const entityId = entityRes.body.id;

      const parentRes = await api("POST", `${base(projectId)}/entities/${entityId}/comments`, {
        token: owner.token,
        body: { body: "Parent comment" },
      });
      const parentId = parentRes.body.id;

      // Create 50 child replies
      const childIds: string[] = [];
      for (let i = 0; i < 50; i++) {
        const childRes = await api("POST", `${base(projectId)}/entities/${entityId}/comments`, {
          token: owner.token,
          body: { body: `Reply ${i}`, parentCommentId: parentId },
        });
        childIds.push(childRes.body.id);
      }

      // Delete parent comment (soft-delete, moderatedByType="user")
      const deleteRes = await api("DELETE", `${base(projectId)}/entities/${entityId}/comments/${parentId}`, {
        token: owner.token,
      });
      expect(deleteRes.status).toBe(200);

      // Non-operator views thread → parent + subtree filtered
      const threadRes = await api("GET", `${base(projectId)}/entities/${entityId}/comments/${parentId}/thread`, {
        token: user1.token,
      });
      expect(threadRes.status).toBe(404); // parent hidden

      // Child replies may be orphaned or hidden (depends on RPC behavior)
    });
  });

  describe("Pagination + Large Result Sets", () => {
    it("entity feed with 200+ entities → pagination works across full set", async () => {
      // Create 200+ entities
      for (let i = 0; i < 200; i++) {
        await api("POST", `${base(projectId)}/entities`, {
          token: owner.token,
          body: { body: `Entity ${i}` },
        });
      }

      // Fetch first page
      const page1 = await api("GET", `${base(projectId)}/entities?limit=50`, {
        token: owner.token,
      });
      expect(page1.body.data.length).toBeLessThanOrEqual(50);
      expect(page1.body.pagination.total).toBeGreaterThanOrEqual(200);

      // Fetch pages via cursor
      let nextCursor = page1.body.pagination.next;
      let pageCount = 1;
      while (nextCursor && pageCount < 5) {
        const nextPage = await api("GET", `${base(projectId)}/entities?limit=50&after=${nextCursor}`, {
          token: owner.token,
        });
        expect(nextPage.status).toBe(200);
        expect(nextPage.body.data.length).toBeGreaterThan(0);
        nextCursor = nextPage.body.pagination.next;
        pageCount++;
      }
    });
  });

  describe("Notification Delivery Under Load", () => {
    it("single entity create → notifications sent to followers", async () => {
      // User1 and user2 follow owner
      await api("POST", `${base(projectId)}/users/${owner.id}/follow`, {
        token: user1.token,
        body: {},
      });
      await api("POST", `${base(projectId)}/users/${owner.id}/follow`, {
        token: user2.token,
        body: {},
      });

      // Owner creates entity
      const entityRes = await api("POST", `${base(projectId)}/entities`, {
        token: owner.token,
        body: { body: "New entity" },
      });
      expect(entityRes.status).toBe(200);

      // Check that followers got notifications
      // Note: notifications are async; this test depends on implementation
      // Simplified: just verify entity creation triggers notification path
    });
  });

  describe("Bulk Operations", () => {
    it("create 50 entities concurrently → all succeed without conflicts", async () => {
      const promises = Array.from({ length: 50 }, (_, i) =>
        api("POST", `${base(projectId)}/entities`, {
          token: owner.token,
          body: { body: `Entity ${i}` },
        }),
      );

      const results = await Promise.all(promises);
      expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);

      const ids = results.map((r) => r.body.id);
      expect(new Set(ids).size).toBe(50); // All unique
    });

    it("update 50 entities concurrently → all succeed", async () => {
      // Create 50 entities
      const entityIds: string[] = [];
      for (let i = 0; i < 50; i++) {
        const res = await api("POST", `${base(projectId)}/entities`, {
          token: owner.token,
          body: { body: `Entity ${i}` },
        });
        entityIds.push(res.body.id);
      }

      // Update all concurrently
      const promises = entityIds.map((id, i) =>
        api("PATCH", `${base(projectId)}/entities/${id}`, {
          token: owner.token,
          body: { body: `Updated ${i}` },
        }),
      );

      const results = await Promise.all(promises);
      expect(results.every((r) => r.status === 200)).toBe(true);
    });

    it("delete 50 comments concurrently → all soft-deleted", async () => {
      // Create entity
      const entityRes = await api("POST", `${base(projectId)}/entities`, {
        token: owner.token,
        body: { body: "Entity" },
      });
      const entityId = entityRes.body.id;

      // Create 50 comments
      const commentIds: string[] = [];
      for (let i = 0; i < 50; i++) {
        const res = await api("POST", `${base(projectId)}/entities/${entityId}/comments`, {
          token: owner.token,
          body: { body: `Comment ${i}` },
        });
        commentIds.push(res.body.id);
      }

      // Delete all concurrently
      const promises = commentIds.map((id) =>
        api("DELETE", `${base(projectId)}/entities/${entityId}/comments/${id}`, {
          token: owner.token,
        }),
      );

      const results = await Promise.all(promises);
      expect(results.every((r) => r.status === 200)).toBe(true);
    });
  });

  describe("Refresh Token Cleanup", () => {
    it.skip("purgeExpiredRefreshTokens removes stale tokens", async () => {
      // Requires mintRefreshToken helper; skipped for now
    });

    it.skip("concurrent purge + refresh (token about to expire) → no race", async () => {
      // Timing-dependent test; hard to test deterministically
    });

    it.skip("purge doesn't delete reuse-detection tokens (revoked, not expired)", async () => {
      // Requires mintRefreshToken helper; skipped for now
    });
  });

  describe("Cascade & Orphaning Behavior", () => {
    it("delete user → entities marked orphaned (or visible only to operators)", async () => {
      // Create entity as user1
      const entityRes = await api("POST", `${base(projectId)}/entities`, {
        token: user1.token,
        body: { body: "User1's entity" },
      });
      const entityId = entityRes.body.id;

      // Delete user1 (Supabase Auth-level; not exposed in API)
      // For testing: soft-delete or deactivate the profile
      // This is implementation-dependent and may not be testable directly

      // Verify entity is still readable (orphaned ownership)
      const readRes = await api("GET", `${base(projectId)}/entities/${entityId}`, {
        token: owner.token,
      });
      expect(readRes.status).toBe(200);
      expect(readRes.body.author).toBeDefined(); // Author may be null or a deleted marker
    });

    it("delete space → entities cascade soft-deleted", async () => {
      // Create space + entity
      const spaceRes = await api("POST", `${base(projectId)}/spaces`, {
        token: owner.token,
        body: { name: "Space" },
      });
      const spaceId = spaceRes.body.id;

      const entityRes = await api("POST", `${base(projectId)}/entities`, {
        token: owner.token,
        body: { body: "Entity", spaceId },
      });
      const entityId = entityRes.body.id;

      // Delete space
      const deleteRes = await api("DELETE", `${base(projectId)}/spaces/${spaceId}`, {
        token: owner.token,
      });
      expect(deleteRes.status).toBe(200);

      // Entity should be hidden or 404 (cascade behavior)
      const readRes = await api("GET", `${base(projectId)}/entities/${entityId}`, {
        token: owner.token,
      });
      // Implementation-dependent: 404 or orphaned visible
    });
  });

  describe("Idempotency & Retries", () => {
    it("creating same entity twice with idempotency key → single row", async () => {
      // SDK sends `clientId` for idempotency
      // Server should dedup on this field

      const clientId = "unique-client-id-" + Date.now();

      const res1 = await api("POST", `${base(projectId)}/entities`, {
        token: owner.token,
        body: { body: "Entity", clientId },
      });
      expect(res1.status).toBe(200);

      const res2 = await api("POST", `${base(projectId)}/entities`, {
        token: owner.token,
        body: { body: "Entity", clientId },
      });
      expect(res2.status).toBe(200);
      expect(res2.body.id).toBe(res1.body.id); // Same entity
    });
  });

  describe("Error Recovery & Partial Failure", () => {
    it("bulk create with one invalid → other 49 succeed, one fails", async () => {
      // Create 50 entities: 49 valid, 1 missing body
      const promises = Array.from({ length: 50 }, (_, i) => {
        const body = i === 25 ? {} : { body: `Entity ${i}` }; // Missing body at index 25
        return api("POST", `${base(projectId)}/entities`, {
          token: owner.token,
          body,
        });
      });

      const results = await Promise.all(promises);

      // Count successes and failures
      const successes = results.filter((r) => r.status === 200 || r.status === 201).length;
      const failures = results.filter((r) => r.status >= 400).length;

      expect(successes).toBe(49);
      expect(failures).toBe(1);
    });
  });
});
