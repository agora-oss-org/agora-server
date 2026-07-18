// Shared integration-test helpers: an in-process request client over the real Hono app,
// a JWT minter matching the auth middleware, and project/user fixtures (project_id is the
// natural isolation boundary — each test owns its own project and tears it down on cleanup).
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app.js";
import { getDb } from "../../src/db/index.js";
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

/** Mint an Agora access token the auth middleware will accept (HS256 over ACCESS_TOKEN_SECRET).
 *  `steward` stamps the `steward` claim the auth middleware reads back as `isSteward`; `owner`/`admin`
 *  stamp the `powner`/`padmin` claims read back as `isProjectOwner`/`isProjectAdmin`. These extra
 *  params let SETUP mint owner/admin tokens directly (defaults false → existing call sites unchanged);
 *  they bypass the DB resolver, so prove real claim propagation via the refresh path separately.
 *  `projectId` stamps the `pid` claim (mirrors `lib/tokens.ts` `mintSession`) so tests can mint a
 *  token bound to a specific project and prove the auth wall's project-binding check; omitted →
 *  no `pid` claim, matching pre-`pid`-claim tokens (existing call sites unchanged).
 *  `settingsReadonly` stamps the claim the settings-save guard reads back (default false — existing
 *  call sites unchanged). */
export function signToken(
  userId: string,
  role = "visitor",
  operator = false,
  steward = false,
  owner = false,
  admin = false,
  projectId?: string,
  settingsReadonly = false,
) {
  return new SignJWT({ role, operator, steward, powner: owner, padmin: admin, ...(projectId ? { pid: projectId } : {}), ...(settingsReadonly ? { settingsReadonly: true } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setExpirationTime("1h")
    .sign(secret);
}

export async function createProject(): Promise<string> {
  const [p] = await getDb()
    .insert(projects)
    .values({ clientId: `test-${randomUUID()}`, name: "integration" })
    .returning();
  return p!.id;
}

export async function createUser(projectId: string, role = "visitor") {
  const [u] = await getDb()
    .insert(profiles)
    .values({ projectId, role: role as any, username: `u_${randomUUID().slice(0, 8)}` })
    .returning();
  // Stamp `pid` = projectId, mirroring real `mintSession` tokens — every token minted in
  // production carries the project it was issued for, so fixture tokens should too (the auth
  // wall's project-binding check is otherwise never exercised by realistic tokens).
  return { id: u!.id, token: await signToken(u!.id, role, false, false, false, false, projectId) };
}

/** Deletes the project; FK cascades wipe its entities/comments/reactions/profiles. */
export async function deleteProject(projectId: string) {
  await getDb().delete(projects).where(eq(projects.id, projectId));
}

export const base = (projectId: string) => `/v7/${projectId}`;
