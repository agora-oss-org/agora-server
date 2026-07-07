// Security regression (the /secure counterpart of @agora/api's realtime-suspension test): a suspended
// user must be cut off from the E2E realtime layer, not just REST. secure-socket.ts enforces
// hasActiveSuspension() at handshake time; operators (operator claim in the JWT) bypass — mirroring the
// REST/auth behavior. This gate moved here with the secure-chat process split and was previously
// untested (the old @agora/api test connected to a /secure namespace the API no longer serves).
//
// REDIS_URL is unset in the test env (see vitest.integration.config.ts), so hasActiveSuspension reads
// the DB directly. We suspend by inserting a user_suspensions row — the POST /users/:id/suspend REST
// endpoint lives in @agora/api, which this standalone process does not serve.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { io as connectClient, type Socket } from "socket.io-client";
import { getDb } from "@agora/core/db";
import { userSuspensions } from "@agora/core/db/schema";
import { createSecureApp } from "../../src/app.js";
import { attachSecureRealtime } from "../../src/realtime/secure-socket.js";
import { createProject, createUser, deleteProject, signToken } from "./helpers.js";

let projectId: string;
let server: ReturnType<typeof serve>;
let io: ReturnType<typeof attachSecureRealtime>;
let port: number;

/** Connect to the /secure namespace on its OWN engine.io path (/secure-socket/); resolve on connect,
 *  reject on connect_error (carries the handshake middleware's Error message). */
function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connectClient(`http://localhost:${port}/secure`, {
      path: "/secure-socket/",
      auth: { token }, query: { projectId }, transports: ["websocket"], reconnection: false,
    });
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(e));
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

/** Active, open-ended suspension for a profile (start_date defaults to now, end_date null). */
const suspend = (userId: string) =>
  getDb().insert(userSuspensions).values({ profileId: userId, reason: "test" });

beforeAll(async () => {
  projectId = await createProject();
  const app = createSecureApp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => { port = info.port; resolve(); });
  });
  io = attachSecureRealtime(server as unknown as Parameters<typeof attachSecureRealtime>[0]);
});

afterAll(async () => {
  io?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (projectId) await deleteProject(projectId);
});

describe("secure realtime suspension enforcement (/secure namespace)", () => {
  it("an active (non-suspended) user connects to /secure", async () => {
    const user = await createUser(projectId);
    const s = await connect(user.token);
    expect(s.connected).toBe(true);
    s.close();
  });

  it("a suspended user is rejected on /secure", async () => {
    const user = await createUser(projectId);
    await suspend(user.id);
    await expect(connect(user.token)).rejects.toMatchObject({ message: "suspended" });
  });

  it("an operator bypasses the suspension check (operator claim) on /secure", async () => {
    const user = await createUser(projectId);
    await suspend(user.id);
    // Same suspended subject, but carrying the operator claim → must still connect (no self-lockout).
    const opToken = await signToken(user.id, "visitor", true);
    const s = await connect(opToken);
    expect(s.connected).toBe(true);
    s.close();
  });
});
