// Integration: comment-fetch contract + the /thread full-subtree endpoint.
// Covers the SDK gaps fixed here — GET /:id and /by-foreign-id return { comment }, include=parent
// populates parentComment, list honors sortBy (new/old/top) — plus the nested fetch_comment_thread.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("comment fetch contract + thread (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let B: string;
  let entityId: string;
  const id = {} as Record<string, string>; // A (top), Bx (reply→A), C (reply→B), D (top, foreignId)

  const mkComment = async (body: Record<string, unknown>) => {
    const res = await api("POST", `${B}/comments`, { token: owner.token, body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    projectId = await createProject();
    owner = await createUser(projectId);
    B = base(projectId);
    entityId = (await api("POST", `${B}/entities`, { token: owner.token, body: { title: "E" } })).body.id;
    id.A = await mkComment({ entityId, content: "A" });
    id.Bx = await mkComment({ entityId, parentId: id.A, content: "B" });
    id.C = await mkComment({ entityId, parentId: id.Bx, content: "C" });
    id.D = await mkComment({ entityId, content: "D", foreignId: "fid-D" });
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("GET /comments/:id returns { comment }", async () => {
    const res = await api("GET", `${B}/comments/${id.A}`, { token: owner.token });
    expect(res.status).toBe(200);
    expect(res.body.comment).toMatchObject({ id: id.A, content: "A" });
  });

  it("GET /comments/by-foreign-id returns { comment }", async () => {
    const res = await api("GET", `${B}/comments/by-foreign-id?foreignId=fid-D`, { token: owner.token });
    expect(res.status).toBe(200);
    expect(res.body.comment).toMatchObject({ id: id.D, content: "D" });
  });

  it("include=parent populates parentComment (and null for a top-level comment)", async () => {
    const reply = await api("GET", `${B}/comments/${id.Bx}?include=user,parent`, { token: owner.token });
    expect(reply.body.comment.parentComment).toMatchObject({ id: id.A });
    expect("user" in reply.body.comment).toBe(true);

    const top = await api("GET", `${B}/comments/${id.A}?include=parent`, { token: owner.token });
    expect(top.body.comment.parentComment).toBeNull();
  });

  it("list honors sortBy new / old / top", async () => {
    const ids = async (sortBy: string) =>
      (await api("GET", `${B}/comments?entityId=${entityId}&sortBy=${sortBy}`, { token: owner.token })).body.data.map((c: any) => c.id);
    // top-level only: A then D by creation
    expect(await ids("old")).toEqual([id.A, id.D]);
    expect(await ids("new")).toEqual([id.D, id.A]);

    // upvote D → it sorts to the top under "top"
    await api("POST", `${B}/comments/${id.D}/reactions`, { token: owner.token, body: { type: "upvote" } });
    expect((await ids("top"))[0]).toBe(id.D);
  });

  it("GET /comments/thread returns the full nested subtree", async () => {
    const res = await api("GET", `${B}/comments/thread?entityId=${entityId}`, { token: owner.token });
    expect(res.status).toBe(200);
    const roots = res.body.data as any[];
    const a = roots.find((r) => r.id === id.A);
    const d = roots.find((r) => r.id === id.D);
    expect(a).toBeTruthy();
    expect(d.replies).toEqual([]);
    expect(a.replies.map((r: any) => r.id)).toEqual([id.Bx]); // A → B
    expect(a.replies[0].replies.map((r: any) => r.id)).toEqual([id.C]); // B → C
  });

  it("GET /comments/thread?rootId=… scopes to a subtree", async () => {
    const res = await api("GET", `${B}/comments/thread?entityId=${entityId}&rootId=${id.A}`, { token: owner.token });
    const roots = res.body.data as any[];
    expect(roots.map((r) => r.id)).toEqual([id.Bx]); // only B is a direct child of A
    expect(roots[0].replies.map((r: any) => r.id)).toEqual([id.C]); // B → C
  });
});
