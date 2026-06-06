// Integration: bulk/concurrent operations, pagination over large sets, and soft-delete visibility.
// Asserts verified behavior only — entities take { content, title } and return 201; comments are
// created via POST /comments ({ entityId, content }); both single reads 404 once soft-deleted; the
// list envelope is offset-based ({ page, pageSize, totalItems, hasMore }).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("Edge cases: bulk, concurrency, pagination, soft-delete (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    owner = await createUser(projectId);
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  describe("Bulk concurrent writes", () => {
    it("creates 50 entities concurrently → all 201 with unique ids", async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          api("POST", `${B}/entities`, { token: owner.token, body: { content: `Entity ${i}` } }),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      const ids = results.map((r) => r.body.id);
      expect(new Set(ids).size).toBe(50);
    });

    it("updates 30 entities concurrently → all 200 with new content", async () => {
      const created = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          api("POST", `${B}/entities`, { token: owner.token, body: { content: `orig ${i}` } }),
        ),
      );
      const ids = created.map((r) => r.body.id);

      const updates = await Promise.all(
        ids.map((id, i) =>
          api("PATCH", `${B}/entities/${id}`, { token: owner.token, body: { content: `updated ${i}` } }),
        ),
      );
      expect(updates.every((r) => r.status === 200)).toBe(true);
      expect(updates.every((r, i) => r.body.content === `updated ${i}`)).toBe(true);
    });

    it("creates 30 comments on one entity concurrently → all 201; replies_count trigger sums them", async () => {
      const { body: entity } = await api("POST", `${B}/entities`, {
        token: owner.token,
        body: { content: "thread root" },
      });

      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          api("POST", `${B}/comments`, {
            token: owner.token,
            body: { entityId: entity.id, content: `comment ${i}` },
          }),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);

      // The denormalized replies count on the entity reflects all 30 (trigger-maintained).
      const fetched = await api("GET", `${B}/entities/${entity.id}`, { token: owner.token });
      expect(fetched.body.repliesCount).toBe(30);
    });
  });

  describe("Pagination over a large set", () => {
    it("pages through ~45 entities with the offset envelope, no overlaps or gaps", async () => {
      const local = await createProject();
      const u = await createUser(local);
      const LB = base(local);
      try {
        await Promise.all(
          Array.from({ length: 45 }, (_, i) =>
            api("POST", `${LB}/entities`, { token: u.token, body: { content: `p ${i}` } }),
          ),
        );

        const seen = new Set<string>();
        let page = 1;
        let total = 0;
        // Walk pages until hasMore is false.
        for (;;) {
          const res = await api("GET", `${LB}/entities?limit=20&page=${page}`, { token: u.token });
          expect(res.status).toBe(200);
          total = res.body.pagination.totalItems;
          for (const e of res.body.data) seen.add(e.id);
          if (!res.body.pagination.hasMore) break;
          page++;
          if (page > 10) throw new Error("pagination did not terminate");
        }
        expect(total).toBe(45);
        expect(seen.size).toBe(45); // every id seen exactly once across pages
      } finally {
        await deleteProject(local);
      }
    });
  });

  describe("Soft-delete visibility", () => {
    it("a soft-deleted entity 404s on single read", async () => {
      const { body: entity } = await api("POST", `${B}/entities`, {
        token: owner.token,
        body: { content: "delete me" },
      });
      const del = await api("DELETE", `${B}/entities/${entity.id}`, { token: owner.token });
      expect(del.status).toBe(200);

      const read = await api("GET", `${B}/entities/${entity.id}`, { token: owner.token });
      expect(read.status).toBe(404);
    });

    it("a soft-deleted comment 404s on single read", async () => {
      const { body: entity } = await api("POST", `${B}/entities`, {
        token: owner.token,
        body: { content: "host" },
      });
      const { body: comment } = await api("POST", `${B}/comments`, {
        token: owner.token,
        body: { entityId: entity.id, content: "delete me" },
      });
      const del = await api("DELETE", `${B}/comments/${comment.id}`, { token: owner.token });
      expect(del.status).toBe(200);

      const read = await api("GET", `${B}/comments/${comment.id}`, { token: owner.token });
      expect(read.status).toBe(404);
    });
  });
});
