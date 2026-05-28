// Integration: OAuth flow orchestration (the deterministic parts — guards, state lookup, one-shot
// consumption, error passthrough redirect). The Supabase code-exchange + profile upsert needs a
// configured provider + real browser consent and is verified manually / out of band.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { db } from "../../src/db/index.js";
import { oauthStates } from "../../src/db/schema/index.js";

describe("oauth flow orchestration (integration)", () => {
  let projectId: string;
  let user: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    user = await createUser(projectId);
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  // Directly seed a state row (authorize needs Supabase keys, which the test worker may lack —
  // these tests exercise the orchestration around it, not the Supabase exchange itself).
  async function seedState(redirectAfterAuth: string) {
    const id = randomUUID();
    await db.insert(oauthStates).values({
      id, projectId, profileId: null, provider: "google", flow: "signin", redirectAfterAuth, pkce: {},
    });
    return id;
  }

  it("authorize requires a provider", async () => {
    const res = await api("POST", `${B}/oauth/authorize`, { body: { redirectAfterAuth: "http://x/cb" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("oauth/invalid-body");
    expect(res.body.field).toBe("provider");
  });

  it("link requires authentication", async () => {
    const res = await api("POST", `${B}/oauth/link`, { body: { provider: "google", redirectAfterAuth: "http://x/cb" } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth/unauthorized");
  });

  it("callback without a state id → 400", async () => {
    const res = await api("GET", `${B}/oauth/callback`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("oauth/missing-state");
  });

  it("callback with an unknown state id → 400", async () => {
    const res = await api("GET", `${B}/oauth/callback?aid=${randomUUID()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("oauth/invalid-state");
  });

  it("callback passes a provider error through to the redirect target", async () => {
    const aid = await seedState("http://localhost:5173/cb");
    const res = await api("GET", `${B}/oauth/callback?aid=${aid}&error=access_denied&error_description=nope`);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("http://localhost:5173/cb?");
    expect(loc).toContain("error=access_denied");
    expect(loc).toContain("error_description=nope");
  });

  it("state is one-shot: a consumed state can't be reused", async () => {
    const aid = await seedState("http://localhost:5173/cb");
    const first = await api("GET", `${B}/oauth/callback?aid=${aid}&error=x`);
    expect(first.status).toBe(302); // consumed + deleted
    // the row is gone
    const rows = await db.select().from(oauthStates).where(eq(oauthStates.id, aid));
    expect(rows).toHaveLength(0);
    // replaying the same aid now misses
    const second = await api("GET", `${B}/oauth/callback?aid=${aid}&error=x`);
    expect(second.status).toBe(400);
    expect(second.body.code).toBe("oauth/invalid-state");
  });

  it("appends the error with & when the redirect target already has a query string", async () => {
    const aid = await seedState("http://localhost:5173/cb?next=%2Fhome");
    const res = await api("GET", `${B}/oauth/callback?aid=${aid}&error=denied`);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("?next=%2Fhome&error=denied");
  });
});
