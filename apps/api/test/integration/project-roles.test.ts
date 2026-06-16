// Integration: the per-project role system (sub-project B) — owner|admin|steward grants layered on
// top of the deployment-wide env operator flag. The trust boundary is the server, so the security
// story is the NEGATIVE matrix: a plain member is blocked on every within-project admin gate; a
// project-admin (NOT a platform operator) is blocked on deployment-only gates; a grant in project A
// confers nothing in project B. We also prove real claim propagation through the DB resolver on the
// refresh path (a fresh grant lands in the rotated access token), not just statically-stamped tokens.
//
// Honest-isolation note: signToken stamps powner/padmin STATICALLY (bypasses the resolver), so it's
// fine for SETUP within a project that actually granted the role — but the tenant-isolation assertion
// must mint X's project-B token via the REFRESH path so the resolver runs against B and returns no
// owner row. Using a static owner token in B would falsely pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { jwtVerify } from "jose";
import { api, signToken, createProject, createUser, deleteProject, base } from "./helpers.js";
import { mintSession } from "../../src/lib/tokens.js";

const accessSecret = new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET);

/** Create an entity then a report against it; returns the report id (for resolve assertions). */
async function makeReport(projectId: string, author: { token: string }, reporter: { token: string }) {
  const entityRes = await api("POST", `${base(projectId)}/entities`, {
    token: author.token,
    body: { content: "Reportable entity" },
  });
  const reportRes = await api("POST", `${base(projectId)}/reports`, {
    token: reporter.token,
    body: { targetType: "entity", targetId: entityRes.body.id, reason: "Inappropriate" },
  });
  return reportRes.body.id as string;
}

describe("Per-project roles (owner|admin|steward) — grants, claims, authorization", () => {
  let projectId: string;
  let operator: { id: string; token: string };
  let owner: { id: string; token: string };
  let admin: { id: string; token: string };
  let member: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    operator = await createUser(projectId);
    owner = await createUser(projectId);
    admin = await createUser(projectId);
    member = await createUser(projectId);

    // Platform operator: env-flagged in the JWT (operator=true). Owner/admin tokens are stamped
    // statically here so SETUP doesn't need a refresh dance for every test — but each of these users
    // is ALSO granted the matching project_roles row below, so the static claim mirrors real DB state.
    operator.token = await signToken(operator.id, "visitor", true, false);
    owner.token = await signToken(owner.id, "visitor", false, false, true /* owner */);
    admin.token = await signToken(admin.id, "visitor", false, false, false, true /* admin */);

    // Persist the grants so the resolver (and the /roles view) reflect them.
    await api("POST", `${base(projectId)}/roles`, {
      token: operator.token,
      body: { userId: owner.id, role: "owner" },
    });
    await api("POST", `${base(projectId)}/roles`, {
      token: operator.token,
      body: { userId: admin.id, role: "admin" },
    });
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  // ── 1. Grant + claim propagation through the resolver ──────────────────────────────────────────
  describe("Grant + claim propagation", () => {
    it("a fresh admin grant propagates into the rotated access token (padmin:true) on next refresh", async () => {
      // Brand-new user → cold resolver cache. Operator grants admin via the endpoint.
      const grantee = await createUser(projectId);
      const session = await mintSession(projectId, grantee.id, "visitor");
      const before = (await jwtVerify(session.accessToken, accessSecret)).payload;
      expect(before.padmin).toBeFalsy();

      const grantRes = await api("POST", `${base(projectId)}/roles`, {
        token: operator.token,
        body: { userId: grantee.id, role: "admin" },
      });
      expect(grantRes.status).toBe(201);

      // The refresh path resolves roles from project_roles and folds them into the new token.
      const rotated = await api("POST", `${base(projectId)}/auth/request-new-access-token`, {
        body: { refreshToken: session.refreshToken },
      });
      expect(rotated.status).toBe(200);
      const after = (await jwtVerify(rotated.body.accessToken, accessSecret)).payload;
      expect(after.padmin).toBe(true);
      // admin folds steward (gate hierarchy) but is NOT owner.
      expect(after.steward).toBe(true);
      expect(after.powner).toBeFalsy();

      // With that admin token, the within-project admin powers are reachable.
      const adminToken = rotated.body.accessToken;
      const reportId = await makeReport(projectId, member, member);
      const resolve = await api("PATCH", `${base(projectId)}/reports/${reportId}/resolve`, {
        token: adminToken,
        body: { action: "dismiss" },
      });
      expect(resolve.status).toBe(200);

      const overview = await api("GET", `${base(projectId)}/admin/community/overview?days=7`, {
        token: adminToken,
      });
      expect(overview.status).toBe(200);
    });

    it("a plain member is blocked (403 roles/admin-only) on report-resolve and community overview", async () => {
      const reportId = await makeReport(projectId, member, member);
      const resolve = await api("PATCH", `${base(projectId)}/reports/${reportId}/resolve`, {
        token: member.token,
        body: { action: "dismiss" },
      });
      expect(resolve.status).toBe(403);
      expect(resolve.body.code).toBe("roles/admin-only");

      const overview = await api("GET", `${base(projectId)}/admin/community/overview`, {
        token: member.token,
      });
      expect(overview.status).toBe(403);
      expect(overview.body.code).toBe("roles/admin-only");
    });

    it("report-resolve 404s roles/not-found on a missing report (admin reaches the handler)", async () => {
      const res = await api("PATCH", `${base(projectId)}/reports/00000000-0000-0000-0000-000000000000/resolve`, {
        token: admin.token,
        body: { action: "dismiss" },
      });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("reports/not-found");
    });
  });

  // ── 2. Owner powers vs admin (grant/revoke is owner-gated; admin may only VIEW) ─────────────────
  describe("Owner powers", () => {
    it("an owner can grant admin and steward (201)", async () => {
      const u1 = await createUser(projectId);
      const u2 = await createUser(projectId);

      const grantAdmin = await api("POST", `${base(projectId)}/roles`, {
        token: owner.token,
        body: { userId: u1.id, role: "admin" },
      });
      expect(grantAdmin.status).toBe(201);
      expect(grantAdmin.body.success).toBe(true);

      const grantSteward = await api("POST", `${base(projectId)}/roles`, {
        token: owner.token,
        body: { userId: u2.id, role: "steward" },
      });
      expect(grantSteward.status).toBe(201);
    });

    it("a project-admin (padmin only, NOT owner) is blocked on grant (403 roles/owner-only)", async () => {
      const target = await createUser(projectId);
      const res = await api("POST", `${base(projectId)}/roles`, {
        token: admin.token,
        body: { userId: target.id, role: "steward" },
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("roles/owner-only");
    });

    it("a project-admin CAN view the grant table (GET /roles → 200)", async () => {
      const res = await api("GET", `${base(projectId)}/roles`, { token: admin.token });
      expect(res.status).toBe(200);
      expect(res.body.roles).toBeDefined();
      const ownerIds = res.body.roles.owner.map((u: any) => u.id);
      const adminIds = res.body.roles.admin.map((u: any) => u.id);
      expect(ownerIds).toContain(owner.id);
      expect(adminIds).toContain(admin.id);
    });

    it("a plain member cannot view the grant table (403 roles/admin-only)", async () => {
      const res = await api("GET", `${base(projectId)}/roles`, { token: member.token });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("roles/admin-only");
    });
  });

  // ── 3. Last-owner guard ─────────────────────────────────────────────────────────────────────────
  describe("Last-owner guard", () => {
    it("blocks revoking the sole owner of a project (400 roles/last-owner), then allows it once a 2nd owner exists", async () => {
      // A dedicated project with exactly one owner, granted by the platform operator.
      const proj = await createProject();
      try {
        const op = await createUser(proj);
        op.token = await signToken(op.id, "visitor", true, false);
        const o1 = await createUser(proj);
        const o2 = await createUser(proj);

        await api("POST", `${base(proj)}/roles`, { token: op.token, body: { userId: o1.id, role: "owner" } });

        // Sole owner → revoke blocked.
        const blocked = await api("DELETE", `${base(proj)}/roles/${o1.id}/owner`, { token: op.token });
        expect(blocked.status).toBe(400);
        expect(blocked.body.code).toBe("roles/last-owner");

        // Add a 2nd owner → the first can now be revoked.
        await api("POST", `${base(proj)}/roles`, { token: op.token, body: { userId: o2.id, role: "owner" } });
        const ok = await api("DELETE", `${base(proj)}/roles/${o1.id}/owner`, { token: op.token });
        expect(ok.status).toBe(200);
        expect(ok.body.success).toBe(true);
      } finally {
        await deleteProject(proj);
      }
    });

    it("two concurrent owner-revokes can never drop the project to zero owners (TOCTOU)", async () => {
      // Exactly two owners; fire both removals at once. The transactional FOR UPDATE guard must let
      // at most one through — the project must always retain >= 1 owner.
      const proj = await createProject();
      try {
        const op = await createUser(proj);
        op.token = await signToken(op.id, "visitor", true, false);
        const o1 = await createUser(proj);
        const o2 = await createUser(proj);
        await api("POST", `${base(proj)}/roles`, { token: op.token, body: { userId: o1.id, role: "owner" } });
        await api("POST", `${base(proj)}/roles`, { token: op.token, body: { userId: o2.id, role: "owner" } });

        const [r1, r2] = await Promise.all([
          api("DELETE", `${base(proj)}/roles/${o1.id}/owner`, { token: op.token }),
          api("DELETE", `${base(proj)}/roles/${o2.id}/owner`, { token: op.token }),
        ]);

        // At least one revoke is blocked as last-owner; the survivor list never reaches empty.
        const blocked = [r1, r2].filter((r) => r.status === 400 && r.body.code === "roles/last-owner");
        expect(blocked.length).toBeGreaterThanOrEqual(1);
        const view = await api("GET", `${base(proj)}/roles`, { token: op.token });
        expect(view.body.roles.owner.length).toBeGreaterThanOrEqual(1);
      } finally {
        await deleteProject(proj);
      }
    });

    it("rejects an unknown role on revoke (400 roles/invalid-role)", async () => {
      const res = await api("DELETE", `${base(projectId)}/roles/${member.id}/superuser`, {
        token: owner.token,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("roles/invalid-role");
    });

    it("rejects a non-UUID userId on revoke (400 roles/invalid-user, not a 500)", async () => {
      const res = await api("DELETE", `${base(projectId)}/roles/not-a-uuid/admin`, {
        token: owner.token,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("roles/invalid-user");
    });

    it("404s roles/user-not-found when granting to a non-profile id", async () => {
      const res = await api("POST", `${base(projectId)}/roles`, {
        token: owner.token,
        body: { userId: "00000000-0000-0000-0000-000000000000", role: "admin" },
      });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("roles/user-not-found");
    });
  });

  // ── 4. Steward unification (the steward gate widened to admin/owner) ─────────────────────────────
  describe("Steward unification", () => {
    // A steward-tier user needs the steward claim on a REAL token; mint via the refresh path after
    // the grant so the resolver folds it in. The static admin/owner tokens already carry steward via
    // the fold (admin/owner ⊇ steward) — they hit the widened gate directly.
    async function tokenAfterGrant(role: "steward") {
      const u = await createUser(projectId);
      const session = await mintSession(projectId, u.id, "visitor");
      const grant = await api("POST", `${base(projectId)}/roles`, {
        token: owner.token,
        body: { userId: u.id, role },
      });
      expect(grant.status).toBe(201);
      const rotated = await api("POST", `${base(projectId)}/auth/request-new-access-token`, {
        body: { refreshToken: session.refreshToken },
      });
      return { id: u.id, token: rotated.body.accessToken };
    }

    const openCase = (token: string, complainantId: string, respondentId: string) =>
      api("POST", `${base(projectId)}/steward/cases`, {
        token,
        body: { complainantId, respondentId, summary: "Conflict" },
      });

    it("a granted steward can open a steward case (201)", async () => {
      const steward = await tokenAfterGrant("steward");
      const res = await openCase(steward.token, owner.id, admin.id);
      expect(res.status).toBe(201);
    });

    it("a project-admin (folds steward) can open a steward case (201)", async () => {
      const res = await openCase(admin.token, owner.id, member.id);
      expect(res.status).toBe(201);
    });

    it("a project-owner (folds steward) can open a steward case (201)", async () => {
      const res = await openCase(owner.token, admin.id, member.id);
      expect(res.status).toBe(201);
    });

    it("a plain member is blocked on steward routes (403 steward/forbidden)", async () => {
      const res = await openCase(member.token, owner.id, admin.id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("steward/forbidden");
    });
  });

  // ── 5. Deployment isolation: within-project admin ≠ platform operator ────────────────────────────
  describe("Deployment isolation", () => {
    it("a project-admin (not a platform operator) is blocked on the operator-only GET /admin/config (403 admin/operator-required)", async () => {
      const res = await api("GET", `${base(projectId)}/admin/config`, { token: admin.token });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("admin/operator-required");
    });

    it("the same project-admin reaches the within-project GET /admin/community/overview (200)", async () => {
      const res = await api("GET", `${base(projectId)}/admin/community/overview`, { token: admin.token });
      expect(res.status).toBe(200);
    });

    it("a platform operator reaches GET /admin/config (200)", async () => {
      const res = await api("GET", `${base(projectId)}/admin/config`, { token: operator.token });
      expect(res.status).toBe(200);
    });
  });

  // ── 6. Negative within-project: a member is blocked on every rewired gate ────────────────────────
  describe("Member is blocked on every within-project admin gate", () => {
    it("report-resolve → 403 roles/admin-only", async () => {
      const reportId = await makeReport(projectId, member, member);
      const res = await api("PATCH", `${base(projectId)}/reports/${reportId}/resolve`, {
        token: member.token,
        body: { action: "removed" },
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("roles/admin-only");
    });

    it("user suspend → 403 roles/admin-only", async () => {
      const victim = await createUser(projectId);
      const res = await api("POST", `${base(projectId)}/users/${victim.id}/suspend`, {
        token: member.token,
        body: { reason: "no power", endDate: new Date(Date.now() + 86_400_000).toISOString() },
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("roles/admin-only");
    });

    it("an admin CAN suspend (201) — confirms the gate lets admins through", async () => {
      const victim = await createUser(projectId);
      const res = await api("POST", `${base(projectId)}/users/${victim.id}/suspend`, {
        token: admin.token,
        body: { reason: "policy", endDate: new Date(Date.now() + 86_400_000).toISOString() },
      });
      expect(res.status).toBe(201);
    });
  });

  // ── 7. Tenant isolation: a grant in project A confers nothing in project B ───────────────────────
  describe("Tenant isolation", () => {
    it("an owner in project A has NO power in project B (resolver is keyed by (projectId, profileId))", async () => {
      const projB = await createProject();
      try {
        const opB = await createUser(projB);
        opB.token = await signToken(opB.id, "visitor", true, false);

        // X is a profile in BOTH projects' eyes only via grants; grant owner in A.
        const xInA = await createUser(projectId);
        const grantA = await api("POST", `${base(projectId)}/roles`, {
          token: owner.token,
          body: { userId: xInA.id, role: "owner" },
        });
        expect(grantA.status).toBe(201);

        // To assert HONESTLY, X's project-B token must reflect B's resolution. Seed X as a profile in
        // B and mint via the refresh path scoped to B → the resolver finds NO owner row → powner/padmin
        // false. (A static signToken(...,true) would falsely pass.)
        const xInB = await createUser(projB);
        const sessionB = await mintSession(projB, xInB.id, "visitor");
        const rotated = await api("POST", `${base(projB)}/auth/request-new-access-token`, {
          body: { refreshToken: sessionB.refreshToken },
        });
        const xTokenB = rotated.body.accessToken;
        const claims = (await jwtVerify(xTokenB, accessSecret)).payload;
        expect(claims.powner).toBeFalsy();
        expect(claims.padmin).toBeFalsy();

        // X's A-grant confers nothing in B: blocked on a B within-project admin route.
        const overviewB = await api("GET", `${base(projB)}/admin/community/overview`, { token: xTokenB });
        expect(overviewB.status).toBe(403);
        expect(overviewB.body.code).toBe("roles/admin-only");

        // And cannot grant in B (owner-gated).
        const grantB = await api("POST", `${base(projB)}/roles`, {
          token: xTokenB,
          body: { userId: xInB.id, role: "admin" },
        });
        expect(grantB.status).toBe(403);
        expect(grantB.body.code).toBe("roles/owner-only");
      } finally {
        await deleteProject(projB);
      }
    });
  });
});
