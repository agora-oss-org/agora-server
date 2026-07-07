// Integration: per-space digests (lib/digests.ts). Boots a local receiver that verifies the
// outgoing HMAC X-Signature (signed with the SPACE's digest secret), then exercises the real
// due-now scheduling gate, the --force override, the no-content skip, and the envelope contents.
// Also asserts the secret-gated cron endpoint is disabled when CRON_SECRET is unset (unset just for
// that assertion, so it holds regardless of the ambient .env).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { sendDueDigests } from "../../src/lib/digests.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { env } from "../../src/lib/env.js";

const SECRET = "digest_test_secret";
const hmac = (msg: string) => crypto.createHmac("sha256", SECRET).update(msg).digest("hex");

type Received = { type?: string; stage?: string; spaceId?: string; data?: any; signatureValid: boolean };

describe("space digests (integration)", () => {
  let server: http.Server;
  let port: number;
  let projectId: string;
  let owner: { id: string; token: string };
  let B: string;
  const received: Received[] = [];

  const nowHour = new Date().getUTCHours();
  const otherHour = (nowHour + 1) % 24;

  // space ids
  let dueSpace: string;     // scheduled now + has content
  let offHourSpace: string; // configured but scheduled an hour off
  let emptySpace: string;   // scheduled now but no content in window

  const mkSpace = async (name: string) =>
    (await api("POST", `${B}/spaces`, { token: owner.token, body: { name } })).body.id as string;

  const configure = (id: string, hour: number) =>
    api("PATCH", `${B}/spaces/${id}/digest-config`, {
      token: owner.token,
      body: {
        digestEnabled: true,
        digestWebhookUrl: `http://127.0.0.1:${port}/digest`,
        digestWebhookSecret: SECRET,
        digestScheduleHour: hour,
        digestTimezone: "UTC",
      },
    });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        const ts = req.headers["x-timestamp"] as string | undefined;
        const sig = req.headers["x-signature"] as string | undefined;
        const signatureValid = !!ts && sig === hmac(`${ts}.${body}`);
        let env: any = {};
        try { env = JSON.parse(body); } catch { /* noop */ }
        received.push({ type: env.type, stage: env.stage, spaceId: env.spaceId, data: env.data, signatureValid });
        res.writeHead(200);
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as import("node:net").AddressInfo).port;

    projectId = await createProject();
    owner = await createUser(projectId);
    B = base(projectId);

    dueSpace = await mkSpace("Due Now");
    offHourSpace = await mkSpace("Off Hour");
    emptySpace = await mkSpace("Empty");
    await Promise.all([configure(dueSpace, nowHour), configure(offHourSpace, otherHour), configure(emptySpace, nowHour)]);

    // content in the window for dueSpace + offHourSpace (none for emptySpace)
    for (const spaceId of [dueSpace, offHourSpace]) {
      await api("POST", `${B}/entities`, { token: owner.token, body: { title: "Fresh post A", spaceId } });
      await api("POST", `${B}/entities`, { token: owner.token, body: { title: "Fresh post B", spaceId } });
    }
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (projectId) await deleteProject(projectId);
  });

  const forSpace = (id: string) => received.filter((r) => r.spaceId === id);

  it("sends a due space a signed space.digest with its recent entities", async () => {
    const before = received.length;
    const res = await sendDueDigests({ projectId, spaceId: dueSpace });
    expect(res.due).toBe(1);
    expect(res.sent).toBe(1);
    expect(received.length).toBe(before + 1);

    const evt = forSpace(dueSpace).at(-1)!;
    expect(evt).toMatchObject({ type: "space.digest", stage: "complete", signatureValid: true });
    expect(evt.data.entityCount).toBe(2);
    expect(evt.data.entities).toHaveLength(2);
    expect(evt.data.space.id).toBe(dueSpace);
    expect(evt.data.period.since).toBeTruthy();
  });

  it("skips a space whose scheduled hour is not now (unless forced)", async () => {
    const before = received.length;
    const res = await sendDueDigests({ projectId, spaceId: offHourSpace });
    expect(res.due).toBe(0);
    expect(received.length).toBe(before); // receiver never called

    const forced = await sendDueDigests({ projectId, spaceId: offHourSpace, force: true });
    expect(forced.due).toBe(1);
    expect(forced.sent).toBe(1);
    expect(forSpace(offHourSpace).at(-1)!.signatureValid).toBe(true);
  });

  it("does not deliver an empty digest when there is no new content", async () => {
    const before = received.length;
    const res = await sendDueDigests({ projectId, spaceId: emptySpace, force: true });
    expect(res.due).toBe(1);   // it was due/forced
    expect(res.sent).toBe(0);  // but nothing delivered
    expect(res.results[0]).toMatchObject({ ok: true, skipped: "no-content", entityCount: 0 });
    expect(received.length).toBe(before);
  });

  it("sweeps all due spaces in a project at once", async () => {
    const res = await sendDueDigests({ projectId });
    // dueSpace fires; emptySpace is due but no-content; offHourSpace is not due
    expect(res.considered).toBe(3);
    expect(res.due).toBe(2);
    expect(res.sent).toBe(1);
  });

  it("the cron endpoint is disabled (503) when CRON_SECRET is unset", async () => {
    // app.ts reads env.CRON_SECRET live per request; unset it just here so we prove the disabled-path
    // regardless of the ambient .env (which normally sets the secret for real cron).
    const saved = env.CRON_SECRET;
    (env as { CRON_SECRET?: string }).CRON_SECRET = undefined;
    try {
      const r = await api("POST", `/internal/cron/digests`);
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("cron/disabled");
    } finally {
      (env as { CRON_SECRET?: string }).CRON_SECRET = saved;
    }
  });
});
