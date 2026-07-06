// Integration: project webhooks (lib/webhooks.ts). Boots a local receiver that verifies our
// outgoing HMAC X-Signature and replies with a signed validation result, so we exercise the real
// signing + response-signature verification + fail-closed/allow/deny/unsubscribed logic.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db/index.js";
import { projects } from "../../src/db/schema/index.js";
import { validate, broadcast } from "../../src/lib/webhooks.js";
import { createProject, deleteProject } from "./helpers.js";

const SECRET = "whsec_test_secret";
const hmac = (msg: string) => crypto.createHmac("sha256", SECRET).update(msg).digest("hex");

type Received = { type?: string; stage?: string; signatureValid: boolean };

describe("project webhooks (integration)", () => {
  let server: http.Server;
  let port: number;
  let projectId: string;
  let deadProjectId: string;
  let mode: "allow" | "deny" | "badsig" = "allow";
  const received: Received[] = [];

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
        received.push({ type: env.type, stage: env.stage, signatureValid });

        if (env.stage === "validate") {
          const respBody = JSON.stringify(mode === "deny" ? { valid: false, message: "nope" } : { valid: true });
          const respSig = mode === "badsig" ? "00ff" : hmac(respBody);
          res.writeHead(200, { "content-type": "application/json", "x-response-signature": respSig });
          res.end(respBody);
        } else {
          res.writeHead(200);
          res.end("{}");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as import("node:net").AddressInfo).port;

    projectId = await createProject();
    await getDb().update(projects)
      .set({ webhookUrl: `http://127.0.0.1:${port}/hook`, webhookSecret: SECRET, webhookEvents: ["entity.created", "entity.created.complete"] })
      .where(eq(projects.id, projectId));

    // a project whose webhook points at a closed port → exercises fail-closed
    deadProjectId = await createProject();
    await getDb().update(projects)
      .set({ webhookUrl: `http://127.0.0.1:9/hook`, webhookSecret: SECRET, webhookEvents: ["entity.created"] })
      .where(eq(projects.id, deadProjectId));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (projectId) await deleteProject(projectId);
    if (deadProjectId) await deleteProject(deadProjectId);
  });

  const waitFor = async (pred: () => boolean, ms = 3000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  it("allows when the receiver signs a { valid: true } — request carries a valid HMAC", async () => {
    mode = "allow";
    const before = received.length;
    const r = await validate(projectId, "entity.created", { title: "hi" });
    expect(r.valid).toBe(true);

    const req = received[before];
    expect(req).toMatchObject({ type: "entity.created", stage: "validate", signatureValid: true });
  });

  it("rejects when the receiver returns { valid: false }", async () => {
    mode = "deny";
    const r = await validate(projectId, "entity.created", {});
    expect(r.valid).toBe(false);
  });

  it("rejects when the response signature is invalid (forged response)", async () => {
    mode = "badsig";
    const r = await validate(projectId, "entity.created", {});
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/signature/i);
  });

  it("auto-allows an event the project hasn't subscribed to (no request sent)", async () => {
    mode = "allow";
    const before = received.length;
    const r = await validate(projectId, "comment.created", {}); // not in webhookEvents
    expect(r.valid).toBe(true);
    expect(received.length).toBe(before); // receiver never called
  });

  it("fails closed when the webhook is unreachable", async () => {
    const r = await validate(deadProjectId, "entity.created", {});
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/unavailable/i);
  });

  it("broadcast fires a signed complete event (fire-and-forget)", async () => {
    const before = received.length;
    broadcast(projectId, "entity.created.complete", { title: "done" });
    const arrived = await waitFor(() => received.length > before);
    expect(arrived).toBe(true);
    const evt = received[received.length - 1];
    expect(evt).toMatchObject({ type: "entity.created.complete", stage: "complete", signatureValid: true });
  });
});
