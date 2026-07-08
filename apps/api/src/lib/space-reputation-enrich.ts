// Centralized post-shape space-reputation enrichment (v7.8.2 #6). A directive is resolved+stashed by
// middleware/space-rep.ts; covered handlers call enrichSpaceReputation on their payload before c.json.
// This phase implements the `uuid` and `"none"` modes; `"context"` resolves to null (deferred).
import type { Context } from "hono";
import type { User, SpaceReputationDirective } from "@agora-server/contract";
import type { Variables } from "../http/context.js";
import { loadSpaceReputations, validateSpaceReputationParams } from "./space-reputation.js";
import { assertCanReadSpace } from "./space-access.js";
import { logger } from "./logger.js";

export type UserLike = User & Record<string, unknown>;

// A full User is uniquely identified by carrying all of these keys. Entity/Comment/Space lack
// role+username+reputation; the reduced moderation userSummary lacks role+createdAt.
function isUserShape(o: Record<string, unknown>): boolean {
  return "id" in o && "role" in o && "username" in o && "reputation" in o && "createdAt" in o;
}

/** Every full-User object in the payload — ALL occurrences (a repeated author yields one object per
 *  embed, so each gets stamped). Cycle-safe via object-identity tracking. Pure. */
export function collectUsers(payload: unknown): UserLike[] {
  const users: UserLike[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    const o = v as Record<string, unknown>;
    if (isUserShape(o)) users.push(o as UserLike);
    for (const k in o) walk(o[k]);
  };
  walk(payload);
  return users;
}

/** Validate (throws the contract 400s) then map the raw params to a directive. absent/"context" → null. */
export function resolveDirective(
  raw: { spaceReputationId?: string; spaceReputationDescendants?: string },
  endpointClass: "context" | "user-direct",
): SpaceReputationDirective | null {
  validateSpaceReputationParams(raw, endpointClass);
  const id = raw.spaceReputationId;
  if (id === undefined || id === "context") return null; // absent OR deferred context → no enrichment
  if (id === "none") return { mode: "global" };
  return { mode: "space", spaceId: id, includeDescendants: raw.spaceReputationDescendants === "true" };
}

/** Assign spaceReputation on each user: global → own reputation; space → map (missing → 0). Pure. */
export function stampReputations(
  users: UserLike[],
  directive: SpaceReputationDirective,
  map: Map<string, number> | null,
): void {
  for (const u of users) {
    u.spaceReputation = directive.mode === "global" ? u.reputation : (map?.get(u.id) ?? 0);
  }
}

/** Post-shape enrichment. No-op unless a directive is stashed. `projectId` overrides c.var.projectId
 *  for root-mounted routers (connections derives it from the authed profile). Returns the same payload. */
export async function enrichSpaceReputation<T>(
  c: Context<{ Variables: Variables }>,
  payload: T,
  projectId?: string,
): Promise<T> {
  const directive = c.get("spaceRep") ?? null;
  if (!directive) return payload;
  const users = collectUsers(payload);
  if (users.length === 0) return payload;
  if (directive.mode === "global") {
    stampReputations(users, directive, null);
    return payload;
  }
  const pid = projectId ?? c.get("projectId");
  if (!pid) return payload;
  // Fail closed: never expose per-space reputation for a space the caller can't read (private-space
  // participation oracle). Public/space-less/operator/owner/member all pass; denial → emit no field.
  try {
    await assertCanReadSpace(c, directive.spaceId, pid);
  } catch (err) {
    // Fail closed (no field). Debug-only: an expected members-only denial and a transient read-gate
    // error look identical here; debug keeps the common denial out of info/error noise (log-with-intent).
    logger.debug({ err }, "space-rep read-gate check failed; omitting spaceReputation");
    return payload;
  }
  const ids = [...new Set(users.map((u) => u.id))];
  const map = await loadSpaceReputations(pid, directive.spaceId, directive.includeDescendants, ids);
  stampReputations(users, directive, map);
  return payload;
}
