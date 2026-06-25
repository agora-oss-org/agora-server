// SDK ↔ server contract conformance (routing + response shapes).
// Each test encodes what a sublay-fork SDK hook (../agora-sdk) actually calls and reads back.
// These are the Class 2 (HTTP method) + Class 3 (missing endpoint) criticals from the contract
// audit. RED until the server honors the SDK; they turn GREEN as the endpoints are fixed/added.
// The point of this file: the SDK is the executable spec, so drift fails CI instead of the demo.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("SDK contract conformance — routing + shapes", () => {
  let projectId: string;
  let A: { id: string; token: string }; // primary actor
  let Bu: { id: string; token: string }; // second user (connections / mutual spaces)
  let B: string; // base(projectId)
  let entityId: string;
  let commentId: string;

  beforeAll(async () => {
    projectId = await createProject();
    A = await createUser(projectId);
    Bu = await createUser(projectId);
    B = base(projectId);
    entityId = (await api("POST", `${B}/entities`, { token: A.token, body: { title: "E" } })).body.id;
    commentId = (await api("POST", `${B}/comments`, { token: A.token, body: { entityId, content: "C" } })).body.id;
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  // ── Class 2: HTTP method mismatch (SDK uses PATCH; server had POST) ──────────
  describe("Class 2 — HTTP method", () => {
    it("PATCH /entities/:id/publish publishes a draft (usePublishDraft)", async () => {
      const draft = await api("POST", `${B}/entities`, { token: A.token, body: { title: "D", isDraft: true } });
      expect(draft.body.isDraft).toBe(true);
      const res = await api("PATCH", `${B}/entities/${draft.body.id}/publish`, { token: A.token, body: {} });
      expect(res.status).toBe(200);
      expect(res.body.isDraft).toBe(false);
    });

    it("PATCH /app-notifications/mark-all-as-read (useMarkAllNotificationsAsReadMutation)", async () => {
      const res = await api("PATCH", `${B}/app-notifications/mark-all-as-read`, { token: A.token, body: {} });
      expect(res.status).toBe(200);
    });
  });

  // ── Class 3: endpoints the SDK calls but the server never registered ─────────
  describe("Class 3 — missing endpoints", () => {
    it("GET /entities/:id/reactions lists reactions (useFetchEntityReactions)", async () => {
      await api("POST", `${B}/entities/${entityId}/reactions`, { token: A.token, body: { reactionType: "like" } });
      const res = await api("GET", `${B}/entities/${entityId}/reactions`, { token: A.token });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toBeTruthy();
      const r = res.body.data.find((x: any) => x.userId === A.id);
      expect(r).toMatchObject({ userId: A.id, reactionType: "like" });
      expect(r.id).toBeTruthy();
      expect(r.createdAt).toBeTruthy();
    });

    it("GET /comments/:id/reactions lists reactions (useFetchCommentReactions)", async () => {
      await api("POST", `${B}/comments/${commentId}/reactions`, { token: A.token, body: { reactionType: "like" } });
      const res = await api("GET", `${B}/comments/${commentId}/reactions`, { token: A.token });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.find((x: any) => x.userId === A.id)).toMatchObject({ reactionType: "like" });
    });

    it("GET /spaces/mutual/:userId returns spaces both users belong to (useFetchMutualSpaces)", async () => {
      const space = await api("POST", `${B}/spaces`, {
        token: A.token,
        body: { name: "Mutual", slug: `mutual-${Date.now()}`, postingPermission: "anyone", readingPermission: "anyone" },
      });
      const spaceId = space.body.id;
      const joined = await api("POST", `${B}/spaces/${spaceId}/join`, { token: Bu.token, body: {} });
      expect(joined.status).toBe(200);
      // A and B are both members of `spaceId` → it shows up as mutual.
      const res = await api("GET", `${B}/spaces/mutual/${Bu.id}`, { token: A.token });
      expect(res.status).toBe(200);
      expect(res.body.data.map((s: any) => s.id)).toContain(spaceId);
      expect(res.body.pagination).toBeTruthy();
    });

    it("GET /users/:userId/connections lists a user's connections (useFetchConnectionsByUserId)", async () => {
      // A requests, B accepts → they are connected. Connections live at the /v7 root (no projectId).
      const reqRes = await api("POST", `/v7/users/${Bu.id}/connection`, { token: A.token, body: {} });
      const connId = reqRes.body.id;
      await api("PATCH", `/v7/connections/${connId}/accept`, { token: Bu.token, body: {} });
      const res = await api("GET", `/v7/users/${A.id}/connections`, { token: A.token });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      const row = res.body.data.find((x: any) => x.connectedUser?.id === Bu.id);
      expect(row).toBeTruthy();
      expect(row.id).toBeTruthy();
      expect(row.connectedAt).toBeTruthy();
    });

    it("PATCH /collections/:id renames (useUpdateCollectionMutation)", async () => {
      const col = await api("POST", `${B}/collections`, { token: A.token, body: { name: "Old" } });
      const res = await api("PATCH", `${B}/collections/${col.body.id}`, { token: A.token, body: { name: "New" } });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("New");
    });

    it("DELETE /collections/:id deletes (useDeleteCollectionMutation)", async () => {
      const col = await api("POST", `${B}/collections`, { token: A.token, body: { name: "Trash" } });
      const del = await api("DELETE", `${B}/collections/${col.body.id}`, { token: A.token });
      expect(del.status).toBe(200);
      const after = await api("GET", `${B}/collections/${col.body.id}`, { token: A.token });
      expect(after.status).toBe(404);
    });
  });
});
