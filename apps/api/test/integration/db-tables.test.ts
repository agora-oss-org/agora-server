// Custom-tables `/db` surface — SDK useTable / tablesApi. A generic per-project JSONB row store with
// filtering, sort, soft-delete + restore. Access model: per-row ownership (a user sees/edits only the
// rows they created; operators bypass). RED until the /db router + table_rows table exist.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("/db custom tables (integration)", () => {
  let projectId: string; let B: string;
  let A: { id: string; token: string };
  let other: { id: string; token: string };
  const T = "Events";

  beforeAll(async () => {
    projectId = await createProject();
    A = await createUser(projectId);
    other = await createUser(projectId);
    B = base(projectId);
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  const create = (token: string, data: Record<string, unknown>) =>
    api("POST", `${B}/db/${T}`, { token, body: { data } });

  it("POST creates a row; managed + free columns are flattened", async () => {
    const res = await create(A.token, { title: "Launch", count: 5 });
    expect(res.status).toBe(201);
    expect(res.body.row.id).toBeTruthy();
    expect(res.body.row.title).toBe("Launch");
    expect(res.body.row.count).toBe(5);
    expect(res.body.row.createdAt).toBeTruthy();
  });

  it("GET lists the caller's rows with the standard envelope", async () => {
    const res = await api("GET", `${B}/db/${T}`, { token: A.token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeTruthy();
    expect(res.body.data.some((r: any) => r.title === "Launch")).toBe(true);
  });

  it("GET honors an eq filter on a free column", async () => {
    await create(A.token, { title: "Other", count: 1 });
    const filters = encodeURIComponent(JSON.stringify([{ column: "title", operator: "eq", value: "Launch" }]));
    const res = await api("GET", `${B}/db/${T}?filters=${filters}`, { token: A.token });
    expect(res.status).toBe(200);
    expect(res.body.data.every((r: any) => r.title === "Launch")).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("GET honors a gte filter on a numeric column", async () => {
    const filters = encodeURIComponent(JSON.stringify([{ column: "count", operator: "gte", value: 5 }]));
    const res = await api("GET", `${B}/db/${T}?filters=${filters}`, { token: A.token });
    expect(res.body.data.every((r: any) => Number(r.count) >= 5)).toBe(true);
  });

  it("per-row ownership: another user does not see A's rows", async () => {
    const res = await api("GET", `${B}/db/${T}`, { token: other.token });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(0);
  });

  it("PATCH updates the caller's row", async () => {
    const created = await create(A.token, { title: "Editable", count: 2 });
    const res = await api("PATCH", `${B}/db/${T}/${created.body.row.id}`, { token: A.token, body: { data: { title: "Edited", count: 9 } } });
    expect(res.status).toBe(200);
    expect(res.body.row.title).toBe("Edited");
    expect(res.body.row.count).toBe(9);
  });

  it("PATCH cannot touch another user's row", async () => {
    const created = await create(A.token, { title: "Private" });
    const res = await api("PATCH", `${B}/db/${T}/${created.body.row.id}`, { token: other.token, body: { data: { title: "Hacked" } } });
    expect(res.status).toBe(404);
  });

  it("DELETE soft-deletes; row hidden by default, surfaced with includeDeleted; restore brings it back", async () => {
    const created = await create(A.token, { title: "Temp" });
    const rowId = created.body.row.id;

    const del = await api("DELETE", `${B}/db/${T}/${rowId}`, { token: A.token });
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ deleted: true, soft: true });

    const hidden = await api("GET", `${B}/db/${T}`, { token: A.token });
    expect(hidden.body.data.some((r: any) => r.id === rowId)).toBe(false);

    const shown = await api("GET", `${B}/db/${T}?includeDeleted=true`, { token: A.token });
    expect(shown.body.data.some((r: any) => r.id === rowId)).toBe(true);

    const restored = await api("POST", `${B}/db/${T}/${rowId}/restore`, { token: A.token, body: {} });
    expect(restored.status).toBe(200);
    expect(restored.body.row.deletedAt).toBeNull();
  });
});
