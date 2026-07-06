// Integration: misc grouped routes — the get-metadata SSRF guard, oauth identities
// (list + ownership-scoped delete), and lean project info.
// NOTE: /oauth/authorize|callback are not covered here — they broker through Supabase
// (network); those belong in an opt-in E2E once OAuth creds are wired.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { oauthIdentities } from "../../src/db/schema/index.js";

describe("misc routes (integration)", () => {
  let projectId: string;
  let user: { id: string; token: string };
  let other: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    [user, other] = await Promise.all([createUser(projectId), createUser(projectId)]);
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  describe("utils/get-metadata SSRF guard", () => {
    it("rejects a missing url", async () => {
      const res = await api("GET", `${B}/utils/get-metadata`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("utils/missing-url");
    });

    it("rejects a malformed url", async () => {
      const res = await api("GET", `${B}/utils/get-metadata?url=${encodeURIComponent("not a url")}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("utils/bad-url");
    });

    it("blocks internal hosts and non-http schemes", async () => {
      const blocked = [
        "http://localhost/x",
        "http://127.0.0.1/x",
        "http://169.254.169.254/latest/meta-data", // cloud metadata endpoint
        "http://192.168.1.1/x",
        "http://10.0.0.5/x",
        "https://foo.local/x",
        "ftp://example.com/x",
        "file:///etc/passwd",
        "http://[::1]/x",          // IPv6 loopback
        "http://2130706433/",      // decimal-encoded 127.0.0.1
        "http://0x7f.0.0.1/",      // hex-encoded 127.0.0.1
      ];
      for (const url of blocked) {
        const res = await api("GET", `${B}/utils/get-metadata?url=${encodeURIComponent(url)}`);
        expect(res.status, url).toBe(400);
        expect(["utils/blocked-url", "utils/bad-url"], url).toContain(res.body.code);
      }
    });
  });

  describe("oauth/identities", () => {
    it("lists the auth user's linked providers (empty by default)", async () => {
      const res = await api("GET", `${B}/oauth/identities`, { token: user.token });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("404s deleting an unknown identity", async () => {
      const res = await api("DELETE", `${B}/oauth/identities/00000000-0000-0000-0000-000000000000`, { token: user.token });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("oauth/not-found");
    });

    it("lists then ownership-scopes deletion (non-owner 403, owner ok)", async () => {
      const [row] = await getDb()
        .insert(oauthIdentities)
        .values({ projectId, profileId: user.id, provider: "google", providerUid: `g_${user.id}` })
        .returning();

      const listed = await api("GET", `${B}/oauth/identities`, { token: user.token });
      expect(listed.body.data.map((i: any) => i.id)).toContain(row!.id);

      const denied = await api("DELETE", `${B}/oauth/identities/${row!.id}`, { token: other.token });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("oauth/not-owner");

      const ok = await api("DELETE", `${B}/oauth/identities/${row!.id}`, { token: user.token });
      expect(ok.status).toBe(200);
      // confirm it's gone
      const remaining = await getDb().select().from(oauthIdentities).where(eq(oauthIdentities.id, row!.id));
      expect(remaining).toHaveLength(0);
    });
  });

  it("projects/lean returns id, name, and integrations", async () => {
    const res = await api("GET", `${B}/projects/lean`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(projectId);
    expect(typeof res.body.name).toBe("string");
    expect(Array.isArray(res.body.integrations)).toBe(true);
  });
});
