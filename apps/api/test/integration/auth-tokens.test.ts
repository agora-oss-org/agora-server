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
import { refreshTokens } from "../../src/db/schema/index.js";
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
});
