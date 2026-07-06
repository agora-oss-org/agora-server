// Integration: steward mediation channels (the /cases/:id/channels half of steward.ts). Channels are
// built on chat — a 1:1 *caucus* per party, or a consensual *joint* room (hybrid mode only, both
// parties present, never for a "targeting"/asymmetry case). Default project mediationMode is "hybrid".
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb } from "../../src/db/index.js";
import { projectStewards } from "../../src/db/schema/index.js";
import { api, signToken, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("steward mediation channels (integration)", () => {
  let projectId: string;
  let steward: { id: string; token: string };
  let complainant: { id: string; token: string };
  let respondent: { id: string; token: string };
  let outsider: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    steward = await createUser(projectId);
    complainant = await createUser(projectId);
    respondent = await createUser(projectId);
    outsider = await createUser(projectId);
    await getDb().insert(projectStewards).values({ projectId, profileId: steward.id, grantedById: steward.id });
    steward.token = await signToken(steward.id, "visitor", false, true);
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  const openCase = (body: Record<string, unknown> = {}) =>
    api("POST", `${B}/steward/cases`, {
      token: steward.token,
      body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Dispute", ...body },
    });

  describe("Caucus channels", () => {
    it("opens one caucus per party (complainant + respondent)", async () => {
      const { body: c } = await openCase();
      const res = await api("POST", `${B}/steward/cases/${c.id}/channels`, {
        token: steward.token,
        body: { kind: "caucus" },
      });
      expect(res.status).toBe(201);
      expect(res.body.channels).toHaveLength(2);
      for (const ch of res.body.channels) {
        expect(ch.mediationRole).toBe("caucus");
        expect([complainant.id, respondent.id]).toContain(ch.mediationParty);
      }
      const parties = res.body.channels.map((ch: any) => ch.mediationParty).sort();
      expect(parties).toEqual([complainant.id, respondent.id].sort());
    });

    it("re-opening caucus is idempotent — reuses the same channels, no duplicates", async () => {
      const { body: c } = await openCase();
      await api("POST", `${B}/steward/cases/${c.id}/channels`, { token: steward.token, body: { kind: "caucus" } });
      const again = await api("POST", `${B}/steward/cases/${c.id}/channels`, {
        token: steward.token,
        body: { kind: "caucus" },
      });
      expect(again.status).toBe(201);
      expect(again.body.channels).toHaveLength(2);

      const list = await api("GET", `${B}/steward/cases/${c.id}/channels`, { token: steward.token });
      expect(list.body.channels.filter((ch: any) => ch.mediationRole === "caucus")).toHaveLength(2);
    });

    it("rejects caucus when the case has no parties (400 steward/no-parties)", async () => {
      // A cold case with neither complainant nor respondent.
      const { body: c } = await api("POST", `${B}/steward/cases`, {
        token: steward.token,
        body: { summary: "No parties" },
      });
      const res = await api("POST", `${B}/steward/cases/${c.id}/channels`, {
        token: steward.token,
        body: { kind: "caucus" },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("steward/no-parties");
    });
  });

  describe("Joint channel", () => {
    it("opens a single joint room for a non-asymmetry case with both parties (hybrid default)", async () => {
      const { body: c } = await openCase();
      const res = await api("POST", `${B}/steward/cases/${c.id}/channels`, {
        token: steward.token,
        body: { kind: "joint" },
      });
      expect(res.status).toBe(201);
      expect(res.body.channels).toHaveLength(1);
      expect(res.body.channels[0].mediationRole).toBe("joint");
    });

    it("refuses a joint room for a targeting (asymmetry) case (400 steward/joint-not-allowed)", async () => {
      const { body: c } = await openCase();
      // Flag the case as targeting — a joint room is power-unsafe and must be blocked.
      await api("PATCH", `${B}/steward/cases/${c.id}`, { token: steward.token, body: { asymmetry: true } });

      const res = await api("POST", `${B}/steward/cases/${c.id}/channels`, {
        token: steward.token,
        body: { kind: "joint" },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("steward/joint-not-allowed");
    });
  });

  describe("Listing + authorization", () => {
    it("GET lists the case's channels", async () => {
      const { body: c } = await openCase();
      await api("POST", `${B}/steward/cases/${c.id}/channels`, { token: steward.token, body: { kind: "caucus" } });
      const list = await api("GET", `${B}/steward/cases/${c.id}/channels`, { token: steward.token });
      expect(list.status).toBe(200);
      expect(list.body.channels.length).toBeGreaterThanOrEqual(2);
    });

    it("rejects a non-steward from opening or listing channels (403)", async () => {
      const { body: c } = await openCase();
      const post = await api("POST", `${B}/steward/cases/${c.id}/channels`, {
        token: outsider.token,
        body: { kind: "caucus" },
      });
      expect(post.status).toBe(403);
      expect(post.body.code).toBe("steward/forbidden");

      const get = await api("GET", `${B}/steward/cases/${c.id}/channels`, { token: outsider.token });
      expect(get.status).toBe(403);
    });
  });
});
