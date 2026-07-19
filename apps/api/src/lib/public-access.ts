// Internet-public read gate for the anonymous /v7/:projectId/public/* surface.
// Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md
//
// Every /public route calls assertEntityInternetPublic INDEPENDENTLY — no route trusts that
// another ran first. The check is live (no cache) and fail-closed: flipping the space to
// members-only, soft-deleting, re-drafting, or moderation-removing the entity instantly
// un-exposes it even while is_public is still true. Always 404, never 403 — the anonymous
// surface must not reveal that a non-public entity exists.
import { z } from "zod";
import { and, eq } from "drizzle-orm";
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
const notFound = () => Errors.notFound("entities/not-found", "Entity not found");

/** Load + gate; returns the entity row or throws 404. A malformed id 404s (not 500s) — this
 *  surface is probed by anonymous strangers. */
export async function assertEntityInternetPublic(projectId: string, entityId: string) {
  if (!uuid.safeParse(entityId).success) throw notFound();
  const [row] = await getDb()
    .select({ entity: entities, spaceReading: spaces.readingPermission, spaceDeletedAt: spaces.deletedAt })
    .from(entities)
    .leftJoin(spaces, and(eq(spaces.id, entities.spaceId), eq(spaces.projectId, projectId)))
    .where(and(eq(entities.projectId, projectId), eq(entities.id, entityId)))
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
