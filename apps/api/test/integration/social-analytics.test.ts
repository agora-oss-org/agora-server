// Integration: the operator-only admin-analytics surface — GET /admin/social/{influence,silos,engagement}
// + POST /admin/social/recompute. Hermetic: the app's NEO4J_URI is empty in the test env, so a forced
// recompute is a graceful no-op (GDS needs the graph) and the reads return the empty "asOf: null" sentinel
// from the social_analytics snapshot table. Asserts both the allow path (operator + corporate tier) and
// every deny path (auth, operator gate, corporate-flag gate). The GDS math is covered by
// social-analytics-live.test.ts (opt-in) and the unit suite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, signToken, createProject, createUser, deleteProject, base } from "./helpers.js";

const REPORTS = ["influence", "silos", "engagement"] as const;
const EMPTY = {
  influence: { leaders: [], bridges: [], asOf: null },
  silos: { silos: [], asOf: null },
  engagement: { members: [], asOf: null },
} as const;

describe("admin social analytics", () => {
  let projectId: string;
  let operator: { id: string; token: string };
  let plain: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    operator = await createUser(projectId);
    plain = await createUser(projectId);
    operator.token = await signToken(operator.id, "visitor", true); // isOperator claim
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  for (const report of REPORTS) {
    describe(`GET /admin/social/${report}`, () => {
      it("requires auth (401)", async () => {
        const res = await api("GET", `${B}/admin/social/${report}`);
        expect(res.status).toBe(401);
      });

      it("rejects a non-operator with 403", async () => {
        const res = await api("GET", `${B}/admin/social/${report}`, { token: plain.token });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("admin/operator-required");
      });

      it(`400s with social/${report}-disabled under the (default) community tier`, async () => {
        const res = await api("GET", `${B}/admin/social/${report}`, { token: operator.token });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(`social/${report}-disabled`);
      });
    });
  }

  describe("under the corporate tier", () => {
    beforeAll(async () => {
      const patch = await api("PATCH", `${B}/settings/social`, { token: operator.token, body: { privacyTier: "corporate" } });
      expect(patch.status).toBe(200);
    });
    afterAll(async () => {
      await api("PATCH", `${B}/settings/social`, { token: operator.token, body: { privacyTier: null } });
    });

    for (const report of REPORTS) {
      it(`GET /admin/social/${report} returns the empty sentinel (200) when nothing is materialized`, async () => {
        const res = await api("GET", `${B}/admin/social/${report}`, { token: operator.token });
        expect(res.status).toBe(200);
        expect(res.body).toEqual(EMPTY[report]);
      });
    }

    it("POST /admin/social/recompute (all) no-ops gracefully and returns the fresh empty reports", async () => {
      const res = await api("POST", `${B}/admin/social/recompute`, { token: operator.token, body: {} });
      expect(res.status).toBe(200);
      expect(res.body.recomputed).toEqual([...REPORTS]);
      expect(res.body.influence).toEqual(EMPTY.influence);
      expect(res.body.silos).toEqual(EMPTY.silos);
      expect(res.body.engagement).toEqual(EMPTY.engagement);
    });

    it("POST /admin/social/recompute can target a single report", async () => {
      const res = await api("POST", `${B}/admin/social/recompute`, { token: operator.token, body: { report: "engagement" } });
      expect(res.status).toBe(200);
      expect(res.body.recomputed).toEqual(["engagement"]);
      expect(res.body.engagement).toEqual(EMPTY.engagement);
      expect(res.body.influence).toBeUndefined();
    });
  });

  describe("POST /admin/social/recompute deny paths", () => {
    it("rejects a non-operator with 403", async () => {
      const res = await api("POST", `${B}/admin/social/recompute`, { token: plain.token, body: {} });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("admin/operator-required");
    });

    it("400s social/analytics-disabled under the community tier (nothing enabled)", async () => {
      const res = await api("POST", `${B}/admin/social/recompute`, { token: operator.token, body: {} });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("social/analytics-disabled");
    });

    it("400s social/<report>-disabled when a specific disabled report is requested", async () => {
      const res = await api("POST", `${B}/admin/social/recompute`, { token: operator.token, body: { report: "influence" } });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("social/influence-disabled");
    });
  });
});
