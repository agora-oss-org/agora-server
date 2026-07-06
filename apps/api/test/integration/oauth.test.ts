// Integration: OAuth flow orchestration (the deterministic parts — guards, state lookup, one-shot
// consumption, error passthrough redirect). The Supabase code-exchange + profile upsert needs a
// configured provider + real browser consent and is verified manually / out of band.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { oauthStates, profiles } from "../../src/db/schema/index.js";
import { ensureOAuthProfile } from "../../src/routes/misc.js";

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
    await getDb().insert(oauthStates).values({
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
    const rows = await getDb().select().from(oauthStates).where(eq(oauthStates.id, aid));
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

  // ensureOAuthProfile is the profile-upsert helper the /oauth/callback handler calls after a real
  // Supabase code exchange (which this test suite can't perform — see the file header). It has no
  // Supabase dependency of its own, so it's exercised directly against the real test DB here.
  describe("ensureOAuthProfile (profile upsert)", () => {
    it("derives a username from the email local-part on first login — not left null", async () => {
      const authUserId = randomUUID();
      const profile = await ensureOAuthProfile(projectId, authUserId, "google", {
        email: "dana@example.com",
        name: "Dana",
      });
      expect(profile.username).toBe("dana");
      expect(profile.authMethods).toEqual(["google"]);
    });

    it("suffixes the username on a collision instead of leaving it null or erroring", async () => {
      const first = await ensureOAuthProfile(projectId, randomUUID(), "google", { email: "erin@example.com" });
      expect(first.username).toBe("erin");
      const secondAuthUserId = randomUUID();
      const second = await ensureOAuthProfile(projectId, secondAuthUserId, "github", { email: "erin@example.com" });
      expect(second.username).not.toBe("erin");
      expect(second.username).toMatch(/^erin-/);
    });

    it("is idempotent: a repeat login for the same auth user returns the existing profile, untouched", async () => {
      const authUserId = randomUUID();
      const first = await ensureOAuthProfile(projectId, authUserId, "google", { email: "frank@example.com" });
      const second = await ensureOAuthProfile(projectId, authUserId, "google", { email: "different@example.com" });
      expect(second.id).toBe(first.id);
      expect(second.username).toBe(first.username);
      expect(second.email).toBe(first.email); // unchanged — not re-upserted from the second call's attrs
      const rows = await getDb().select().from(profiles)
        .where(and(eq(profiles.projectId, projectId), eq(profiles.authUserId, authUserId)));
      expect(rows).toHaveLength(1);
    });

    it("still creates a profile (with no username) when the OAuth account has no email", async () => {
      const profile = await ensureOAuthProfile(projectId, randomUUID(), "github", {});
      expect(profile.username).toBeNull();
      expect(profile.id).toBeTruthy();
    });
  });
});
