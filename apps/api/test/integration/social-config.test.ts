// Integration: the project-admin social-config surface (GET/PATCH /settings/social) and the
// member-facing transparency endpoint (GET /social/transparency).
// Covers: fresh-project defaults, admin gating, tier-forbidden rejection, tier switch + flag in
// one PATCH, clamp-on-read after downgrade, null-clear-to-default, transparency shape, and
// cache invalidation on PATCH.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("social config surface (integration)", () => {
  let projectId: string;
  let admin: { id: string; token: string };
  let member: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    admin = await createUser(projectId, "admin");
    member = await createUser(projectId); // visitor role — no project-admin
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  // ── 1. Fresh project defaults ────────────────────────────────────────────────────────────────
  it("GET /settings/social on a fresh project → empty stored, community effective defaults", async () => {
    const res = await api("GET", `${B}/settings/social`, { token: admin.token });
    expect(res.status).toBe(200);
    expect(res.body.stored).toEqual({});
    expect(res.body.effective.privacyTier).toBe("community");
    expect(res.body.effective.readReceiptsAllowed).toBe(false);
  });

  // ── 2. Non-admin member is blocked from both endpoints ───────────────────────────────────────
  it("GET /settings/social as non-admin member → 403", async () => {
    const res = await api("GET", `${B}/settings/social`, { token: member.token });
    expect(res.status).toBe(403);
  });

  it("PATCH /settings/social as non-admin member → 403", async () => {
    const res = await api("PATCH", `${B}/settings/social`, {
      token: member.token,
      body: { privacyTier: "corporate" },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("project/not-admin");
  });

  // ── 3. Corporate-only flag under community tier → 400 social/tier-forbidden ─────────────────
  it("PATCH { readReceiptsAllowed: true } under community tier → 400 tier-forbidden; stored unchanged", async () => {
    const denied = await api("PATCH", `${B}/settings/social`, {
      token: admin.token,
      body: { readReceiptsAllowed: true },
    });
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe("social/tier-forbidden");

    // Confirm nothing was persisted
    const check = await api("GET", `${B}/settings/social`, { token: admin.token });
    expect(check.status).toBe(200);
    expect(check.body.stored).toEqual({});
  });

  // ── 4. Tier switch + corporate flag in one PATCH — validated against RESULTING tier ─────────
  it("PATCH { privacyTier: 'corporate', readReceiptsAllowed: true } → 200; effective reflects both", async () => {
    const res = await api("PATCH", `${B}/settings/social`, {
      token: admin.token,
      body: { privacyTier: "corporate", readReceiptsAllowed: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.effective.privacyTier).toBe("corporate");
    expect(res.body.effective.readReceiptsAllowed).toBe(true);
  });

  // ── 5. Downgrade tier; stale corporate flag is clamped on read ───────────────────────────────
  it("PATCH { privacyTier: 'community' } → stored still has readReceiptsAllowed:true; effective clamps to false", async () => {
    const res = await api("PATCH", `${B}/settings/social`, {
      token: admin.token,
      body: { privacyTier: "community" },
    });
    expect(res.status).toBe(200);
    // raw stored override survives the downgrade (not auto-deleted)
    expect(res.body.stored.readReceiptsAllowed).toBe(true);
    // but the effective (clamped) value is false because community forbids it
    expect(res.body.effective.readReceiptsAllowed).toBe(false);
  });

  // ── 6. null clears an override back to tier default ─────────────────────────────────────────
  it("PATCH { weatherEnabled: false } then PATCH { weatherEnabled: null } → stored has no weatherEnabled; effective = true (community default)", async () => {
    // First, disable weather
    const set = await api("PATCH", `${B}/settings/social`, {
      token: admin.token,
      body: { weatherEnabled: false },
    });
    expect(set.status).toBe(200);
    expect(set.body.stored.weatherEnabled).toBe(false);
    expect(set.body.effective.weatherEnabled).toBe(false);

    // Now clear it with null
    const clear = await api("PATCH", `${B}/settings/social`, {
      token: admin.token,
      body: { weatherEnabled: null },
    });
    expect(clear.status).toBe(200);
    expect("weatherEnabled" in clear.body.stored).toBe(false);
    expect(clear.body.effective.weatherEnabled).toBe(true); // community default
  });

  // ── 7. GET /social/transparency: any authenticated member → 200 with required shape; unauthed → 401 ─
  it("GET /social/transparency as plain member → 200 with privacyTier and analytics", async () => {
    const res = await api("GET", `${B}/social/transparency`, { token: member.token });
    expect(res.status).toBe(200);
    expect(typeof res.body.privacyTier).toBe("string");
    expect(res.body.analytics).toBeDefined();
    expect(typeof res.body.analytics.readReceiptsAllowed).toBe("boolean");
  });

  it("GET /social/transparency unauthenticated → 401", async () => {
    const res = await api("GET", `${B}/social/transparency`);
    expect(res.status).toBe(401);
  });

  // ── 8. Cache invalidation: PATCH then immediate GET /social/transparency reflects new value ──
  it("PATCH updates /social/transparency immediately (cache invalidated)", async () => {
    // Confirm we're on community (weatherEnabled = true by default; readReceiptsAllowed = false)
    const before = await api("GET", `${B}/social/transparency`, { token: member.token });
    expect(before.status).toBe(200);
    expect(before.body.analytics.readReceiptsAllowed).toBe(false);

    // Switch to corporate — readReceiptsAllowed should now be true
    const patch = await api("PATCH", `${B}/settings/social`, {
      token: admin.token,
      body: { privacyTier: "corporate" },
    });
    expect(patch.status).toBe(200);

    // Transparency should immediately reflect the invalidated cache
    const after = await api("GET", `${B}/social/transparency`, { token: member.token });
    expect(after.status).toBe(200);
    expect(after.body.privacyTier).toBe("corporate");
    expect(after.body.analytics.readReceiptsAllowed).toBe(true);
  });
});
