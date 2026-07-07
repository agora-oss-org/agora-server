// The pluggable per-project DB resolver (hosting-enablement spec §2). Generic dependency
// injection, not a feature: no env var, no config surface. Unregistered — every self-host,
// every test, every current deployment — resolveDbFor returns the shared DATABASE_URL handle,
// byte-for-byte today's behavior. An external deployment may register a resolver ONCE at boot
// (before serving) to route each project to its own database through the ALS seam.
//
// FAIL CLOSED: whatever a registered resolver throws propagates to the caller unchanged.
// There is deliberately no "resolver failed → shared handle" branch — that would be a silent
// cross-tenant fallback, the exact failure mode this seam exists to prevent.
import type { Db } from "./context.js";
import { sharedDb } from "./shared.js";

export type DbResolver = (projectId: string) => Promise<Db>;

let resolver: DbResolver | null = null;

/** Register the per-project resolver. Call exactly once at boot, before serving; a second
 *  call throws (no hot-swap — a mid-flight swap would be a contamination hazard). */
export function setDbResolver(fn: DbResolver): void {
  if (resolver) throw new Error("setDbResolver: a resolver is already registered (register exactly once at boot)");
  resolver = fn;
}

/** Test/shutdown helper — production code never unregisters. */
export function resetDbResolver(): void {
  resolver = null;
}

/** The seam's single question: "which DB serves this project?" Default: the shared handle. */
export function resolveDbFor(projectId: string): Promise<Db> {
  return resolver ? resolver(projectId) : Promise.resolve(sharedDb);
}
