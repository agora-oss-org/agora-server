// Security regression: a suspended user must be cut off from the realtime layer, not just REST.
// The API's root namespace (socket.ts) enforces hasActiveSuspension() at handshake time, mirroring
// middleware/auth.ts requireAuth. Operators bypass (operator claim in the JWT), matching REST behavior.
// The E2E "/secure" namespace lives in the separate @agora/secure-chat process (its own socket server,
// secure-socket.ts) — its suspension gate is covered by that package's test, not from here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { io as connectClient, type Socket } from "socket.io-client";
import { createApp } from "../../src/app.js";
import { attachRealtime } from "../../src/realtime/socket.js";
import { api, base, createProject, createUser, deleteProject, signToken } from "./helpers.js";

let projectId: string;
let B: string;
let server: ReturnType<typeof serve>;
let io: ReturnType<typeof attachRealtime>;
let port: number;
let operator: { id: string; token: string };

/** Connect to a namespace ("" = root, "/secure"); resolves the socket or rejects on connect_error. */
function connect(token: string, namespace = ""): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connectClient(`http://localhost:${port}${namespace}`, {
      auth: { token }, query: { projectId }, transports: ["websocket"], reconnection: false,
    });
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(e));
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

const suspend = (userId: string) =>
  api("POST", `${B}/users/${userId}/suspend`, { token: operator.token, body: { reason: "test" } });

beforeAll(async () => {
  projectId = await createProject();
  B = base(projectId);
  const op = await createUser(projectId);
  operator = { id: op.id, token: await signToken(op.id, "visitor", true) }; // operator claim

  const app = createApp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => { port = info.port; resolve(); });
  });
  io = attachRealtime(server as unknown as Parameters<typeof attachRealtime>[0]);
});

afterAll(async () => {
  io?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (projectId) await deleteProject(projectId);
});

describe("realtime suspension enforcement (socket.io)", () => {
  it("an active (non-suspended) user connects to the root namespace", async () => {
    const user = await createUser(projectId);
    const root = await connect(user.token);
    expect(root.connected).toBe(true);
    root.close();
  });

  it("a suspended user is rejected on the root namespace", async () => {
    const user = await createUser(projectId);
    expect((await suspend(user.id)).status).toBe(201);
    await expect(connect(user.token)).rejects.toMatchObject({ message: "suspended" });
  });

  it("an operator bypasses the suspension check (operator claim) on the root namespace", async () => {
    const user = await createUser(projectId);
    expect((await suspend(user.id)).status).toBe(201);
    // Same suspended subject, but carrying the operator claim → must still connect (no self-lockout).
    const opToken = await signToken(user.id, "visitor", true);
    const root = await connect(opToken);
    expect(root.connected).toBe(true);
    root.close();
  });
});
