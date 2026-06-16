// Integration: the operator-gated /admin surface — dashboard metrics (role-scoped), the
// running-config view (secrets must NEVER leak), and the umami/community read-backs (operator gate +
// graceful "not configured" behavior). Authz here guards the whole admin app, so both the allow and
// the deny paths are asserted.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, signToken, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("admin / operator surface (integration)", () => {
  let projectId: string;
  let operator: { id: string; token: string };
  let plain: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    operator = await createUser(projectId);
    plain = await createUser(projectId);
    // Re-mint with the operator claim the auth middleware reads back as isOperator.
    operator.token = await signToken(operator.id, "visitor", true);
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  describe("GET /admin/config — running config, operator-only, secret-redacted", () => {
    it("rejects a non-operator with 403", async () => {
      const res = await api("GET", `${B}/admin/config`, { token: plain.token });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("admin/operator-required");
    });

    it("returns the running config to an operator and NEVER leaks a secret value", async () => {
      const res = await api("GET", `${B}/admin/config`, { token: operator.token });
      expect(res.status).toBe(200);
      expect(res.body.service).toBe("agora-api");
      expect(res.body.config).toBeTruthy();

      // Secret-bearing settings are reported as booleans, not values.
      expect(res.body.config.auth.accessTokenSecretSet).toBe(true);

      // The hard guarantee: no actual secret value appears anywhere in the payload.
      const serialized = JSON.stringify(res.body);
      const secret = process.env.ACCESS_TOKEN_SECRET;
      if (secret) expect(serialized).not.toContain(secret);

      // DATABASE_URL is reduced to host + db; the password must be stripped.
      const dbUrl = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
      if (dbUrl) {
        try {
          const pw = new URL(dbUrl).password;
          if (pw) expect(serialized).not.toContain(pw);
        } catch {
          /* unparseable url — skip */
        }
      }
    });
  });

  describe("GET /admin/dashboard/metrics — role-scoped aggregate", () => {
    it("an operator gets scope=operator with the instance db size; counts reflect the project", async () => {
      // Seed a little content so the counts are non-trivial.
      await api("POST", `${B}/entities`, { token: plain.token, body: { content: "one" } });
      await api("POST", `${B}/entities`, { token: plain.token, body: { content: "two" } });

      const res = await api("GET", `${B}/admin/dashboard/metrics`, { token: operator.token });
      expect(res.status).toBe(200);
      expect(res.body.scope).toBe("operator");
      expect(res.body.projectMetrics.entities).toBeGreaterThanOrEqual(2);
      expect(res.body.projectMetrics.members).toBeGreaterThanOrEqual(2); // operator + plain
      // Instance Postgres size is operator-only and comes from a real query here.
      expect(res.body.supabaseMetrics.databaseSizeBytes).toBeGreaterThan(0);
    });

    it("a non-operator gets scope=moderator with operator-only infra figures nulled", async () => {
      const res = await api("GET", `${B}/admin/dashboard/metrics`, { token: plain.token });
      expect(res.status).toBe(200);
      expect(res.body.scope).toBe("moderator");
      expect(res.body.supabaseMetrics.databaseSizeBytes).toBeNull();
      expect(res.body.serverMetrics).toBeNull();
    });
  });

  describe("GET /admin/umami/overview — operator-only, degrades when unconfigured", () => {
    it("rejects a non-operator with 403", async () => {
      const res = await api("GET", `${B}/admin/umami/overview`, { token: plain.token });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("admin/operator-required");
    });

    it("lets an operator through the gate (200 if Umami is wired, else 400 admin/umami-disabled)", async () => {
      // Outcome depends on whether AGORA_UMAMI_* is configured in the env; the env-independent
      // invariant is that the operator is NOT blocked by the gate.
      const res = await api("GET", `${B}/admin/umami/overview`, { token: operator.token });
      expect(res.status).not.toBe(403);
      if (res.status === 400) expect(res.body.code).toBe("admin/umami-disabled");
    });
  });

  describe("GET /admin/community/overview — project-admin-or-up, empty until the rollup runs", () => {
    // Reclassified by sub-project B from operator-only to within-project (requireProjectAdmin):
    // a plain member is blocked with roles/admin-only, but a project admin (not a platform operator)
    // now gets through.
    it("rejects a plain member with 403 roles/admin-only", async () => {
      const res = await api("GET", `${B}/admin/community/overview`, { token: plain.token });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("roles/admin-only");
    });

    it("lets a project admin (not a platform operator) through (200)", async () => {
      // Stamp the padmin claim directly; real claim propagation through the resolver is proven in
      // project-roles.test.ts.
      const admin = await createUser(projectId);
      const adminToken = await signToken(admin.id, "visitor", false, false, false, true);
      const res = await api("GET", `${B}/admin/community/overview`, { token: adminToken });
      expect(res.status).toBe(200);
    });

    it("returns configured=false for an operator before the first community-stats rollup", async () => {
      const res = await api("GET", `${B}/admin/community/overview`, { token: operator.token });
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(false);
    });
  });
});
