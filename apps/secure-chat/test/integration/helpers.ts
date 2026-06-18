// Shared integration-test helpers for @agora/secure-chat: an in-process request client over the real
// secure Hono app (createSecureApp), a JWT minter matching the auth middleware, and project/user
// fixtures (project_id is the isolation boundary — each test owns its own project and tears it down).
// db + schema come from the shared @agora/core kernel (secure-chat shares the main Postgres in v1).
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { createSecureApp } from "../../src/app.js";
import { db } from "@agora/core/db";
import { projects, profiles } from "@agora/core/db/schema";

const app = createSecureApp();
const secret = new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET);

type Init = { token?: string; body?: unknown };

/** Drive the secure app in-process; returns parsed status + body. */
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
export function signToken(userId: string, role = "visitor", operator = false) {
  return new SignJWT({ role, operator })
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

/** Deletes the project; FK cascades wipe its profiles + secure_* rows. */
export async function deleteProject(projectId: string) {
  await db.delete(projects).where(eq(projects.id, projectId));
}

export const base = (projectId: string) => `/v7/${projectId}`;
