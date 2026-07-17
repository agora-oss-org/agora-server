// The auth wall end-to-end: every project-scoped read 401s anonymously and passes authed;
// the pre-sign-in allowlist stays reachable with no token; suspended accounts 403 on walled
// paths but still reach the allowlist (so they can refresh/appeal). The NEGATIVE cases are
// the point (CLAUDE.md → security-relevant logic).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, base, createProject, createUser, deleteProject, signToken } from "./helpers.js";

let projectId: string;
let B: string;
let member: { id: string; token: string };
let operator: { id: string; token: string };

beforeAll(async () => {
  projectId = await createProject();
  B = base(projectId);
  member = await createUser(projectId);
  const op = await createUser(projectId);
  operator = { id: op.id, token: await signToken(op.id, "visitor", true) };
});

afterAll(async () => {
  if (projectId) await deleteProject(projectId);
});

// One representative read per project-group router that was anonymous before the wall.
// [method, path, body?] — paths are project-relative; B is prefixed in the loop.
const WALLED_READS: [string, string, unknown?][] = [
  ["GET", "/entities"],
  ["GET", "/entities/by-short-id?shortId=none"],
  ["GET", "/comments?entityId=00000000-0000-0000-0000-000000000000"],
  ["GET", "/spaces"],
  ["GET", "/spaces/check-slug?slug=probe"],
  ["GET", "/users/suggestions"],
  ["GET", "/users/check-username?username=probe"],
  ["GET", "/events"],
  ["GET", "/users/by-username?username=probe"],
  ["POST", "/search/spaces", { query: "probe" }],
  ["POST", "/search/users", { query: "probe" }],
  // /search/content is the config-leak case from the spec: anonymous must see 401, never
  // 400 search/embeddings-disabled (VOYAGE_API_KEY is forced empty in this suite). The authed
  // call returns that 400 — which the loop's "not 401/403" assertion accepts, proving order.
  ["POST", "/search/content", { query: "probe" }],
];

describe("auth wall — walled reads", () => {
  for (const [method, path, body] of WALLED_READS) {
    it(`${method} ${path} → 401 anonymous`, async () => {
      const r = await api(method, `${B}${path}`, body !== undefined ? { body } : {});
      expect(r.status).toBe(401);
    });
    it(`${method} ${path} → not 401/403 with a member token`, async () => {
      const r = await api(method, `${B}${path}`, { token: member.token, ...(body !== undefined ? { body } : {}) });
      expect([401, 403]).not.toContain(r.status); // past the wall; handler-level 2xx/4xx is its own contract
    });
  }

  it("GET /entities → 200 with a member token (positive anchor)", async () => {
    const r = await api("GET", `${B}/entities`, { token: member.token });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("data");
  });

  it("a malformed token is anonymous, not an error: GET /spaces → 401", async () => {
    const r = await api("GET", `${B}/spaces`, { token: "undefined" }); // the SDK's signed-out literal
    expect(r.status).toBe(401);
  });

  // Anonymous-only on purpose: an authed call would make a REAL outbound fetch (hermeticity).
  // The wall rejecting it pre-handler is exactly the point — an anonymous caller can no longer
  // drive the SSRF-guarded metadata fetcher at all.
  it("GET /utils/get-metadata → 401 anonymous (no outbound fetch attempted)", async () => {
    const r = await api("GET", `${B}/utils/get-metadata?url=https%3A%2F%2Fexample.com`);
    expect(r.status).toBe(401);
  });
});

describe("auth wall — allowlist stays anonymous", () => {
  it("GET /projects/lean → 200 with no token (SDK provider bootstrap)", async () => {
    const r = await api("GET", `${B}/projects/lean`);
    expect(r.status).toBe(200);
  });
  it("GET /push-notifications/vapid-public-key → 200 with no token", async () => {
    const r = await api("GET", `${B}/push-notifications/vapid-public-key`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("publicKey"); // null when VAPID unset — shape, not value
  });
  it("POST /auth/sign-up with an empty body reaches the handler (400, not the wall's 401)", async () => {
    const r = await api("POST", `${B}/auth/sign-up`, { body: {} });
    expect(r.status).toBe(400);
  });
  it("POST /oauth/authorize reaches the handler anonymously (not 401)", async () => {
    const r = await api("POST", `${B}/oauth/authorize`, { body: { provider: "google", redirectAfterAuth: "https://example.com" } });
    expect(r.status).not.toBe(401); // oauth/not-configured (503/400) is fine — it got past the wall
  });
});

describe("auth wall — suspension enforcement", () => {
  it("a suspended member 403s on a walled read but still reaches the allowlist", async () => {
    const u = await createUser(projectId);
    const s = await api("POST", `${B}/users/${u.id}/suspend`, { token: operator.token, body: { reason: "test" } });
    expect(s.status).toBe(201);

    const walled = await api("GET", `${B}/entities`, { token: u.token });
    expect(walled.status).toBe(403);
    expect(walled.body.code).toBe("auth/suspended");

    const allowed = await api("GET", `${B}/projects/lean`, { token: u.token });
    expect(allowed.status).toBe(200); // allowlist = optionalAuth semantics, no suspension gate
  });
});
