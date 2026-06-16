// Integration: per-space read receipts (corporate tier) — docs/SOCIAL-GRAPH.md §4.
//   record   POST /entities/:id/read                              (member)
//   coverage GET  /admin/social/read-receipts                     (operator, corporate)
//   toggle   PATCH /admin/social/read-receipts/spaces/:spaceId     (operator, corporate)
// Asserts the allow path (operator + corporate tier, member-scoped numerator) and every deny path
// (auth, operator gate, corporate-flag gate, the per-space opt-in, read-access denial, space-less post),
// plus that the requireSpaceRole project-admin fold did NOT over-grant a plain space member.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { api, signToken, createProject, createUser, deleteProject, base } from "./helpers.js";
import { db } from "../../src/db/index.js";
import { spaces, spaceMembers, entities } from "../../src/db/schema/index.js";

const sid = () => randomUUID().slice(0, 10);

async function makeSpace(projectId: string, reading: "anyone" | "members" = "anyone"): Promise<string> {
  const [s] = await db
    .insert(spaces)
    .values({ projectId, name: "Announcements", shortId: sid(), readingPermission: reading })
    .returning({ id: spaces.id });
  return s!.id;
}
async function addMember(projectId: string, spaceId: string, userId: string, role: "admin" | "member" = "member") {
  await db.insert(spaceMembers).values({ projectId, spaceId, userId, role, status: "active" }).onConflictDoNothing();
}
async function makeEntity(projectId: string, spaceId: string | null, userId: string): Promise<string> {
  const [e] = await db
    .insert(entities)
    .values({ projectId, spaceId, userId, shortId: sid(), title: "New policy", content: "please read" })
    .returning({ id: entities.id });
  return e!.id;
}
const setTier = (B: string, token: string, tier: "corporate" | null) =>
  api("PATCH", `${B}/settings/social`, { token, body: { privacyTier: tier } });

describe("read receipts", () => {
  let projectId: string;
  let operator: { id: string; token: string };
  let m1: { id: string; token: string };
  let m2: { id: string; token: string };
  let outsider: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    operator = await createUser(projectId);
    operator.token = await signToken(operator.id, "visitor", true); // isOperator
    m1 = await createUser(projectId);
    m2 = await createUser(projectId);
    outsider = await createUser(projectId);
    B = base(projectId);
  });
  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  describe("deny paths (default community tier)", () => {
    it("GET coverage requires auth (401)", async () => {
      expect((await api("GET", `${B}/admin/social/read-receipts`)).status).toBe(401);
    });
    it("GET coverage rejects a non-operator (403)", async () => {
      const res = await api("GET", `${B}/admin/social/read-receipts`, { token: m1.token });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("admin/operator-required");
    });
    it("GET coverage 400s social/read-receipts-disabled under the community tier", async () => {
      const res = await api("GET", `${B}/admin/social/read-receipts`, { token: operator.token });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("social/read-receipts-disabled");
    });
    it("PATCH toggle rejects a non-operator (403)", async () => {
      const sp = await makeSpace(projectId);
      const res = await api("PATCH", `${B}/admin/social/read-receipts/spaces/${sp}`, { token: m1.token, body: { enabled: true } });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("admin/operator-required");
    });
    it("PATCH toggle 400s under the community tier", async () => {
      const sp = await makeSpace(projectId);
      const res = await api("PATCH", `${B}/admin/social/read-receipts/spaces/${sp}`, { token: operator.token, body: { enabled: true } });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("social/read-receipts-disabled");
    });
  });

  describe("under the corporate tier", () => {
    let space: string;
    let post: string;
    beforeAll(async () => {
      expect((await setTier(B, operator.token, "corporate")).status).toBe(200);
      space = await makeSpace(projectId, "anyone");
      await addMember(projectId, space, m1.id);
      await addMember(projectId, space, m2.id);
      post = await makeEntity(projectId, space, m1.id);
    });
    afterAll(async () => {
      await setTier(B, operator.token, null);
    });

    it("a post in a not-yet-enabled space 400s on record", async () => {
      const res = await api("POST", `${B}/entities/${post}/read`, { token: m1.token });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("social/read-receipts-disabled");
    });

    it("operator enables receipts on the space", async () => {
      const res = await api("PATCH", `${B}/admin/social/read-receipts/spaces/${space}`, { token: operator.token, body: { enabled: true } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ spaceId: space, readReceiptsEnabled: true });
    });

    it("members record reads (200) and re-reads are idempotent", async () => {
      const r1 = await api("POST", `${B}/entities/${post}/read`, { token: m1.token });
      expect(r1.status).toBe(200);
      expect(r1.body.recorded).toBe(true);
      expect(typeof r1.body.readAt).toBe("string");
      expect((await api("POST", `${B}/entities/${post}/read`, { token: m2.token })).status).toBe(200);
      // re-read: still 200, no duplicate row (asserted via coverage below)
      expect((await api("POST", `${B}/entities/${post}/read`, { token: m1.token })).status).toBe(200);
    });

    it("a non-member read is recorded but never counts toward coverage", async () => {
      expect((await api("POST", `${B}/entities/${post}/read`, { token: outsider.token })).status).toBe(200);
    });

    it("coverage reports member-readers / members per post", async () => {
      const res = await api("GET", `${B}/admin/social/read-receipts`, { token: operator.token });
      expect(res.status).toBe(200);
      const sp = res.body.spaces.find((s: any) => s.spaceId === space);
      expect(sp).toBeTruthy();
      expect(sp.memberCount).toBe(2);
      const ann = sp.announcements.find((a: any) => a.entityId === post);
      expect(ann).toBeTruthy();
      expect(ann.readerCount).toBe(2); // m1 + m2 only — the outsider is excluded
      expect(ann.coverage).toBe(1);
      expect(ann.title).toBe("New policy");
    });

    it("disabling the space stops new reads (400)", async () => {
      expect((await api("PATCH", `${B}/admin/social/read-receipts/spaces/${space}`, { token: operator.token, body: { enabled: false } })).status).toBe(200);
      const res = await api("POST", `${B}/entities/${post}/read`, { token: m2.token });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("social/read-receipts-disabled");
    });

    it("a space-less post can't be receipt-tracked (400)", async () => {
      const orphan = await makeEntity(projectId, null, m1.id);
      const res = await api("POST", `${B}/entities/${orphan}/read`, { token: m1.token });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("social/read-receipts-disabled");
    });

    it("a non-member can't record a read in a members-only space (403)", async () => {
      const priv = await makeSpace(projectId, "members");
      await addMember(projectId, priv, m1.id);
      const privPost = await makeEntity(projectId, priv, m1.id);
      await api("PATCH", `${B}/admin/social/read-receipts/spaces/${priv}`, { token: operator.token, body: { enabled: true } });
      const res = await api("POST", `${B}/entities/${privPost}/read`, { token: outsider.token });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("spaces/members-only");
    });

    it("the toggle 404s an unknown space", async () => {
      const res = await api("PATCH", `${B}/admin/social/read-receipts/spaces/${randomUUID()}`, { token: operator.token, body: { enabled: true } });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("spaces/not-found");
    });
  });

  describe("requireSpaceRole project-admin fold", () => {
    let space: string;
    beforeAll(async () => {
      space = await makeSpace(projectId);
      await addMember(projectId, space, m1.id, "member"); // active, but NOT a space admin
    });

    it("a plain space member still can't edit the space (403)", async () => {
      const res = await api("PATCH", `${B}/spaces/${space}`, { token: m1.token, body: { name: "Hijacked" } });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("spaces/insufficient-role");
    });

    it("an operator can edit any space (the fold grants project admins)", async () => {
      const res = await api("PATCH", `${B}/spaces/${space}`, { token: operator.token, body: { name: "Renamed by operator" } });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Renamed by operator");
      const [row] = await db.select({ name: spaces.name }).from(spaces).where(eq(spaces.id, space));
      expect(row?.name).toBe("Renamed by operator");
    });
  });
});
