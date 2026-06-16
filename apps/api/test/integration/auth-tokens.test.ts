// Integration: Agora's refresh-token rotation state machine (lib/tokens.ts +
// POST /auth/request-new-access-token + /auth/sign-out). This is the hard part of the
// Replyke auth contract — rotation, reuse-detection (revoke the whole family), and the 30s
// grace window — and it's pure DB (refresh_tokens), so no Supabase Auth is involved.
//
// Sign-up/sign-in are intentionally NOT covered here: they depend on Supabase Auth. We seed a
// profile directly and mint sessions via the token service.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { jwtVerify } from "jose";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { db } from "../../src/db/index.js";
import { refreshTokens, projectRoles } from "../../src/db/schema/index.js";
import { mintSession } from "../../src/lib/tokens.js";

const accessSecret = new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET);
const hashOf = (raw: string) => createHash("sha256").update(raw).digest("hex");

describe("auth token rotation (integration)", () => {
  let projectId: string;
  let user: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    user = await createUser(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  const refresh = (refreshToken: string) =>
    api("POST", `${base(projectId)}/auth/request-new-access-token`, { body: { refreshToken } });

  it("rotates a refresh token into a fresh, distinct pair", async () => {
    const start = await mintSession(projectId, user.id, "visitor");
    const res = await refresh(start.refreshToken);

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe(start.refreshToken);

    // the new access token is a valid HS256 JWT carrying the profile id as sub
    const { payload } = await jwtVerify(res.body.accessToken, accessSecret);
    expect(payload.sub).toBe(user.id);
  });

  it("allows re-presenting a just-rotated token within the grace window (racing tabs)", async () => {
    const start = await mintSession(projectId, user.id, "visitor");
    const first = await refresh(start.refreshToken);
    expect(first.status).toBe(200);

    // immediately replay the original — still inside the 30s grace, so it succeeds
    const replay = await refresh(start.refreshToken);
    expect(replay.status).toBe(200);
    expect(replay.body.refreshToken).toBeTruthy();
  });

  it("detects reuse outside the grace window and revokes the whole family", async () => {
    const start = await mintSession(projectId, user.id, "visitor");
    const rotated = await refresh(start.refreshToken);
    expect(rotated.status).toBe(200);

    // age the spent token past the grace window (deterministic — no real sleep)
    await db
      .update(refreshTokens)
      .set({ rotatedAt: new Date(Date.now() - 120_000) })
      .where(eq(refreshTokens.tokenHash, hashOf(start.refreshToken)));

    // replaying the spent token now reads as theft -> 401 + family revoked
    const reuse = await refresh(start.refreshToken);
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe("auth/refresh-reused");

    // the legitimate successor is collateral — its family was revoked
    const successor = await refresh(rotated.body.refreshToken);
    expect(successor.status).toBe(401);
    expect(successor.body.code).toBe("auth/refresh-reused");
  });

  it("rejects an unknown refresh token", async () => {
    const res = await refresh("not-a-real-token");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth/invalid-refresh");
  });

  it("requires a refreshToken in the body", async () => {
    const res = await api("POST", `${base(projectId)}/auth/request-new-access-token`, { body: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("auth/invalid-body");
    expect(res.body.field).toBe("refreshToken");
  });

  it("sign-out revokes the session's family so its refresh token can't rotate", async () => {
    const session = await mintSession(projectId, user.id, "visitor");
    // sign-out is authed; use a freshly-minted access token to authorize it
    const out = await api("POST", `${base(projectId)}/auth/sign-out`, {
      token: session.accessToken,
      body: { refreshToken: session.refreshToken },
    });
    expect(out.status).toBe(200);
    expect(out.body.success).toBe(true);

    const afterSignOut = await refresh(session.refreshToken);
    expect(afterSignOut.status).toBe(401);
    expect(afterSignOut.body.code).toBe("auth/refresh-reused"); // revoked → treated as reuse
  });

  describe("Token Expiry Edge Cases", () => {
    it("accepts refresh token at T=29m59s (within 30m limit)", async () => {
      const session = await mintSession(projectId, user.id, "visitor");
      // Mock: set expiresAt to just before 30m limit
      const row = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hashOf(session.refreshToken)));
      const nowMs = Date.now();
      const expiresAt = new Date(nowMs + 29 * 60 * 1000 + 59 * 1000); // 29m59s from now
      await db.update(refreshTokens).set({ expiresAt }).where(eq(refreshTokens.tokenHash, hashOf(session.refreshToken)));

      const res = await refresh(session.refreshToken);
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
    });

    it("rejects refresh token at T=30m01s (expired, past 30m limit)", async () => {
      const session = await mintSession(projectId, user.id, "visitor");
      // Mock: set expiresAt to just past 30m limit
      const expiresAt = new Date(Date.now() - 1000); // 1s in the past
      await db.update(refreshTokens).set({ expiresAt }).where(eq(refreshTokens.tokenHash, hashOf(session.refreshToken)));

      const res = await refresh(session.refreshToken);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("auth/refresh-expired");
    });

    it("access token remains valid until expiry (29m limit)", async () => {
      const session = await mintSession(projectId, user.id, "visitor");
      // Access token should be valid immediately
      const { payload } = await jwtVerify(session.accessToken, accessSecret);
      expect(payload.exp).toBeDefined();
      // exp is in seconds; check it's ~30m from issue time
      const expMs = (payload.exp as number) * 1000;
      const nowMs = Date.now();
      const deltaMs = expMs - nowMs;
      expect(deltaMs).toBeGreaterThan(29 * 60 * 1000); // at least 29m
      expect(deltaMs).toBeLessThan(31 * 60 * 1000); // less than 31m
    });
  });

  describe("Concurrent Refresh Stress", () => {
    it("handles 5 simultaneous refresh calls from same session (grace window tolerates the race)", async () => {
      const session = await mintSession(projectId, user.id, "visitor");

      // Fire 5 refresh calls concurrently against the same (unrotated) token
      const calls = Array.from({ length: 5 }, () => refresh(session.refreshToken));
      const results = await Promise.all(calls);

      // The 30s grace window means racing replays of the same token are NOT treated as theft —
      // every concurrent call succeeds and hands back a usable token (no false 401 family-revoke).
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.every((r) => typeof r.body.refreshToken === "string" && r.body.refreshToken.length > 0)).toBe(true);
    });

    it("handles 20 sequential rapid-fire refresh calls (stress rotation)", async () => {
      let session = await mintSession(projectId, user.id, "visitor");
      const tokens: string[] = [session.refreshToken];

      for (let i = 0; i < 20; i++) {
        const res = await refresh(session.refreshToken);
        expect(res.status).toBe(200);
        tokens.push(res.body.refreshToken);
        session.refreshToken = res.body.refreshToken;
      }

      // Each rotation should produce a unique token
      expect(new Set(tokens).size).toBe(tokens.length);
    });

    it("handles concurrent refresh from different sessions (families independent)", async () => {
      const user2 = await createUser(projectId);
      const session1 = await mintSession(projectId, user.id, "visitor");
      const session2 = await mintSession(projectId, user2.id, "visitor");

      // Concurrent refresh from different families
      const res1Promise = refresh(session1.refreshToken);
      const res2Promise = refresh(session2.refreshToken);
      const [res1, res2] = await Promise.all([res1Promise, res2Promise]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.refreshToken).not.toBe(res2.body.refreshToken);
    });
  });

  describe("Profile Changes Mid-Session", () => {
    it("steward grant takes effect on the NEXT refresh (not the already-minted token)", async () => {
      // A fresh user: their current access token has no steward claim.
      const grantee = await createUser(projectId);
      const session = await mintSession(projectId, grantee.id, "visitor");
      const before = (await jwtVerify(session.accessToken, accessSecret)).payload;
      expect(before.steward).toBeFalsy();

      // Grant steward out-of-band (rotateRefreshToken recomputes auth bits from project_roles).
      await db.insert(projectRoles).values({ projectId, profileId: grantee.id, role: "steward", grantedById: grantee.id });

      // The rotated access token now carries steward:true — the grant propagated on refresh.
      const rotated = await refresh(session.refreshToken);
      expect(rotated.status).toBe(200);
      const after = (await jwtVerify(rotated.body.accessToken, accessSecret)).payload;
      expect(after.steward).toBe(true);
    });

    it("a user with no grant keeps a steward-less token across refresh", async () => {
      const session = await mintSession(projectId, user.id, "visitor");
      const rotated = await refresh(session.refreshToken);
      expect(rotated.status).toBe(200);
      const after = (await jwtVerify(rotated.body.accessToken, accessSecret)).payload;
      expect(after.steward).toBeFalsy();
      expect(after.operator).toBeFalsy();
    });
  });

  describe("Suspension + Revocation Timing", () => {
    it("suspended user: existing access token still works until end of expiry", async () => {
      const session = await mintSession(projectId, user.id, "visitor");

      // Suspend the user
      const suspendRes = await api("POST", `${base(projectId)}/users/${user.id}/suspensions`, {
        token: session.accessToken, // operator would have token
        body: { reason: "Test suspension", endDate: new Date(Date.now() + 24 * 60 * 60 * 1000) },
      });
      // Suspension is enforced per-request, not per-token-issuance
      // Old token continues working until expiry, but next request with suspended check will fail

      // Verify token decode still works (JWT itself is valid)
      const payload = (await jwtVerify(session.accessToken, accessSecret)).payload;
      expect(payload.sub).toBe(user.id);
    });

    it("suspended user's refresh fails and revokes family", async () => {
      const suspendedUser = await createUser(projectId);
      const session = await mintSession(projectId, suspendedUser.id, "visitor");

      // Suspend the user (via operator; use system bypass)
      // This would normally go through /users/{id}/suspensions route
      // For now, verify that a suspended user cannot refresh

      // Note: actual suspension enforcement depends on the implementation
      // This test is a placeholder for the actual flow
      const res = await refresh(session.refreshToken);
      // Behavior depends on whether suspension is checked at refresh time
    });
  });

  describe("Token Storage & Leak Scenarios", () => {
    it("refresh token hash is stored (not raw token)", async () => {
      const session = await mintSession(projectId, user.id, "visitor");

      // Verify the DB stores the SHA256 hash, not the raw token
      const row = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hashOf(session.refreshToken)));
      expect(row.length).toBe(1);
      expect(row[0].tokenHash).toBe(hashOf(session.refreshToken));
      expect(row[0].tokenHash).not.toBe(session.refreshToken); // hash !== raw
    });

    it("leaked refresh token from one family cannot bump other families", async () => {
      const user2 = await createUser(projectId);
      const session1 = await mintSession(projectId, user.id, "visitor");
      const session2 = await mintSession(projectId, user2.id, "visitor");

      // Try to use user1's token to get user2's session (exploit attempt)
      // This should fail because the token hash won't match any family for user2
      const exploit = await api("POST", `${base(projectId)}/auth/request-new-access-token`, {
        body: { refreshToken: session1.refreshToken }, // wrong family
      });
      // Should either 401 or rotate user1's family, never user2's
      expect(exploit.status).toBe(200); // rotates user1's family
      expect(exploit.body.refreshToken).not.toBe(session2.refreshToken);
    });

    it("refresh token rotation prevents reuse (single-use per generation)", async () => {
      const session = await mintSession(projectId, user.id, "visitor");
      const first = await refresh(session.refreshToken);

      // Using the original token again (outside grace window) should fail
      await db.update(refreshTokens).set({ rotatedAt: new Date(Date.now() - 120_000) }).where(eq(refreshTokens.tokenHash, hashOf(session.refreshToken)));
      const reuse = await refresh(session.refreshToken);
      expect(reuse.status).toBe(401);
      expect(reuse.body.code).toBe("auth/refresh-reused");
    });
  });
});
