// Internet-public read gate for the anonymous /v7/:projectId/public/* surface.
// Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md
//
// Every /public route calls assertEntityInternetPublic INDEPENDENTLY — no route trusts that
// another ran first. The check is live (no cache) and fail-closed: flipping the space to
// members-only, soft-deleting, re-drafting, or moderation-removing the entity instantly
// un-exposes it even while is_public is still true. Always 404, never 403 — the anonymous
// surface must not reveal that a non-public entity exists.
import { z } from "zod";
import { and, eq, type SQL } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { entities, spaces } from "../db/schema/index.js";
import { Errors } from "../http/errors.js";

export interface InternetPublicEntityCheck {
  isPublic: boolean;
  deletedAt: Date | null;
  isDraft: boolean | null;
  moderationStatus: string | null;
  spaceId: string | null;
}
export interface InternetPublicSpaceCheck {
  readingPermission: string;
  deletedAt: Date | null;
}

/** Pure ladder predicate: internet ⊇ community ⊇ private. */
export function isInternetPublic(
  e: InternetPublicEntityCheck,
  space: InternetPublicSpaceCheck | null,
): boolean {
  if (!e.isPublic || e.deletedAt || e.isDraft) return false;
  if (e.moderationStatus === "removed") return false;
  if (e.spaceId === null) return true;
  if (!space || space.deletedAt) return false;
  return space.readingPermission === "anyone";
}

const uuid = z.string().uuid();
export const notFound = () => Errors.notFound("entities/not-found", "Entity not found");

/** Load one entity by an arbitrary predicate and apply the gate. ALWAYS throws the SAME 404 —
 *  missing, private, draft, deleted, removed and members-only-space are deliberately
 *  indistinguishable, so no lookup key here can become an existence oracle. */
async function loadGated(projectId: string, predicate: SQL) {
  const [row] = await getDb()
    .select({ entity: entities, spaceReading: spaces.readingPermission, spaceDeletedAt: spaces.deletedAt })
    .from(entities)
    .leftJoin(spaces, and(eq(spaces.id, entities.spaceId), eq(spaces.projectId, projectId)))
    .where(and(eq(entities.projectId, projectId), predicate))
    .limit(1);
  if (!row) throw notFound();
  const space = row.spaceReading
    ? { readingPermission: row.spaceReading, deletedAt: row.spaceDeletedAt }
    : null;
  const e = row.entity;
  if (!isInternetPublic(
    { isPublic: e.isPublic, deletedAt: e.deletedAt, isDraft: e.isDraft, moderationStatus: e.moderationStatus, spaceId: e.spaceId },
    space,
  )) throw notFound();
  return e;
}

/** Load + gate by uuid; returns the entity row or throws 404. A malformed id 404s (not 500s) —
 *  this surface is probed by anonymous strangers. */
export async function assertEntityInternetPublic(projectId: string, entityId: string) {
  if (!uuid.safeParse(entityId).success) throw notFound();
  return loadGated(projectId, eq(entities.id, entityId));
}

/** Load + gate by the host app's own key (`foreign_id`), so an anonymous embed can address a
 *  published anchor by the stable handle it already uses on the walled surface
 *  (GET /entities/by-foreign-id) instead of a per-install uuid.
 *
 *  A foreign_id is guessable where a uuid is not, which is a deliberate, bounded trade: the gate is
 *  unchanged, so this can only ever resolve content someone explicitly published, and a miss is the
 *  same 404 as a non-public hit — the real uuid of a private entity is never revealed. What it does
 *  concede is that public entities become enumerable by guessing keys, which softens the
 *  "by-direct-link only" stance in docs/PUBLIC-API.md §9. Accepted: the content is public by
 *  definition, and no unpublished row is reachable through it. */
export async function assertForeignIdInternetPublic(projectId: string, foreignId: string) {
  return loadGated(projectId, eq(entities.foreignId, foreignId));
}
