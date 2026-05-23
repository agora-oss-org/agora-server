// Shared integration-test helpers: an in-process request client over the real Hono app,
// a JWT minter matching the auth middleware, and project/user fixtures (project_id is the
// natural isolation boundary — each test owns its own project and tears it down on cleanup).
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app.js";
import { db } from "../../src/db/index.js";
import { projects, profiles } from "../../src/db/schema/index.js";

const app = createApp();
const secret = new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET);

type Init = { token?: string; body?: unknown };

/** Drive the app in-process; returns parsed status + body. */
export async function api(method: string, path: string, init: Init = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers["authorization"] = `Bearer ${init.token}`;
  const res = await app.request(path, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

/** Mint an Agora access token the auth middleware will accept (HS256 over ACCESS_TOKEN_SECRET). */
export function signToken(userId: string, role = "visitor") {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setExpirationTime("1h")
    .sign(secret);
}

export async function createProject(): Promise<string> {
  const [p] = await db
    .insert(projects)
    .values({ clientId: `test-${randomUUID()}`, name: "integration" })
    .returning();
  return p!.id;
}

export async function createUser(projectId: string, role = "visitor") {
  const [u] = await db
    .insert(profiles)
    .values({ projectId, role: role as any, username: `u_${randomUUID().slice(0, 8)}` })
    .returning();
  return { id: u!.id, token: await signToken(u!.id, role) };
}

/** Deletes the project; FK cascades wipe its entities/comments/reactions/profiles. */
export async function deleteProject(projectId: string) {
  await db.delete(projects).where(eq(projects.id, projectId));
}

export const base = (projectId: string) => `/v7/${projectId}`;
