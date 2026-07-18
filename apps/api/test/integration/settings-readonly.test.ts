// The settings-read-only cap: a demo operator (operator claim + settingsReadonly claim) is blocked on
// the five settings-SAVE endpoints (403 settings/read-only) but stays free everywhere else — the two
// non-destructive actions and ordinary member writes. A plain operator (no cap) saves normally.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, base, createProject, createUser, deleteProject, signToken } from "./helpers.js";

describe("settings read-only cap", () => {
  let projectId: string;
  let B: string;
  let op: { id: string; token: string };       // plain operator — can save
  let demo: { id: string; token: string };      // operator + settingsReadonly — blocked on saves

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    const a = await createUser(projectId);
    const d = await createUser(projectId);
    // operator claim = arg 3; settingsReadonly = arg 8 (projectId = arg 7).
    op = { id: a.id, token: await signToken(a.id, "visitor", true, false, false, false, projectId) };
    demo = { id: d.id, token: await signToken(d.id, "visitor", true, false, false, false, projectId, true) };
  });

  afterAll(async () => {
    await deleteProject(projectId);
  });

  // Each locked endpoint: demo → 403 settings/read-only; plain operator → not 403 (allowed through the cap).
  const locked: Array<[string, string, Record<string, unknown>]> = [
    ["PATCH", "/settings/feed", { gravity: 1.5 }],
    ["PATCH", "/settings/moderator", { blockAutoActionThreshold: 0.9 }],
    ["PATCH", "/settings/steward", { notifyPolicy: "symmetric" }],
    ["PATCH", "/settings/social", { graphEnabled: false }],
    ["PATCH", "/webhooks/config", { url: "https://example.com/hook" }],
  ];

  for (const [method, path, body] of locked) {
    it(`blocks the read-only principal on ${method} ${path}`, async () => {
      const res = await api(method, `${B}${path}`, { token: demo.token, body });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("settings/read-only");
    });

    it(`allows a plain operator through the cap on ${method} ${path}`, async () => {
      const res = await api(method, `${B}${path}`, { token: op.token, body });
      expect(res.status).not.toBe(403); // 200 on success; never the settings/read-only 403
    });
  }

  // The per-space read-receipts toggle is a sixth settings-mutating endpoint (it flips
  // spaces.readReceiptsEnabled). It lives in the /admin/social namespace, not /settings, so it's not
  // in the `locked` table above — but the same cap must apply: a read-only principal cannot change it.
  // The cap fires before the space lookup, so any spaceId serves.
  const rrPath = `/admin/social/read-receipts/spaces/${randomUUID()}`;
  it("blocks the read-only principal on the read-receipts toggle", async () => {
    const res = await api("PATCH", `${B}${rrPath}`, { token: demo.token, body: { enabled: true } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("settings/read-only");
  });

  it("allows a plain operator through the cap on the read-receipts toggle", async () => {
    const res = await api("PATCH", `${B}${rrPath}`, { token: op.token, body: { enabled: true } });
    expect(res.status).not.toBe(403); // 400 read-receipts-disabled is fine; never the settings/read-only 403
  });

  // Scope proof: the cap is settings-SAVES only — the read-only principal keeps its other powers.
  it("still lets the read-only principal run the two non-destructive actions", async () => {
    // webhooks test: 400 webhooks/not-configured is fine (proves it passed the cap and ran the handler).
    const test = await api("POST", `${B}/webhooks/test`, { token: demo.token });
    expect(test.status).not.toBe(403);

    const recompute = await api("POST", `${B}/admin/social/constellation/recompute`, { token: demo.token });
    expect(recompute.status).not.toBe(403);
  });

  it("still lets the read-only principal do an ordinary member write (create entity)", async () => {
    const res = await api("POST", `${B}/entities`, {
      token: demo.token,
      body: { title: "demo can still post" },
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.error).toBeUndefined();
  });
});
